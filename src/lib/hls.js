// HLS fetcher for SoundCloud's AAC streams.
//
// The 160k AAC (and Go+ 256k) tier is HLS-only — there is no progressive URL
// for it. Verified segment layout:
//
//   #EXT-X-VERSION:7
//   #EXT-X-MAP:URI="…/init.mp4"      <- 954-byte init segment, required
//   #EXTINF:10.007800,
//   …/data000.m4s                    <- styp/sidx boxes = fragmented MP4
//
// Because it's fMP4, `init.mp4 + data000.m4s + data001.m4s + …` concatenated
// byte-for-byte is already a valid ISO-BMFF file. No transcode, no remux.
// Confirmed with ffprobe: aac / 44100 / 2ch / 161571 bps / full 397.18s duration.

const SEGMENT_CONCURRENCY = 6;

function parse(playlist) {
  const init = playlist.match(/#EXT-X-MAP:URI="([^"]+)"/)?.[1] ?? null;
  const segments = playlist
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  return { init, segments };
}

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`segment ${res.status}`);
  return res.arrayBuffer();
}

// Segments must land in playlist order, but fetching them in order is slow.
// Fetch through a bounded pool, write into a pre-sized array by index.
async function fetchAllOrdered(urls, onProgress) {
  const out = new Array(urls.length);
  let next = 0;
  let done = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= urls.length) return;
      out[i] = await fetchBuffer(urls[i]);
      onProgress?.(++done, urls.length);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(SEGMENT_CONCURRENCY, urls.length) }, worker),
  );
  return out;
}

// Returns a Blob of fragmented MP4 (`mp4f`). Playable everywhere CoreAudio or
// ffmpeg is involved. See remux.js for why you may not want to stop here.
export async function fetchHlsAudio(playlistUrl, onProgress) {
  const res = await fetch(playlistUrl);
  if (!res.ok) throw new Error(`playlist ${res.status}`);

  const { init, segments } = parse(await res.text());
  if (!segments.length) throw new Error('HLS playlist contained no segments');

  const parts = [];
  if (init) parts.push(await fetchBuffer(init)); // must come first
  parts.push(...(await fetchAllOrdered(segments, onProgress)));

  return new Blob(parts, { type: 'audio/mp4' });
}

// Rank the transcodings SoundCloud offered, best-first.
//
// Returns an ordered list rather than a single pick, because presets lie about
// their availability. `abr_sq` is the newer adaptive tier and advertises itself
// on every track, but resolving it anonymously returns `HTTP 404 {}` — it needs
// an authenticated session. Ranking it first without a fallback fails 100% of
// downloads for logged-out users. Callers walk the list until one resolves.
//
// `aac_160k` is the verified-good anonymous ceiling (measured: 161571 bps).
const AUTHED_RANK = ['abr_sq', 'aac_256k', 'aac_160k', 'aac_96k', 'mp3_0_0'];
const ANON_RANK = ['aac_160k', 'aac_96k', 'mp3_0_0', 'abr_sq'];

const isDrm = (t) => /^(ctr|cbc)-encrypted/.test(t.format?.protocol ?? '');

/**
 * Whether the only thing on offer is DRM.
 *
 * SoundCloud increasingly serves logged-out listeners nothing but encrypted
 * HLS, while still advertising the plain `hls` and `progressive` entries — those
 * resolve to `HTTP 404 {}`. So every candidate we're willing to take fails, and
 * the honest report is "sign in", not a 404 on a URL nobody can act on.
 *
 * The encrypted variants carry `#EXT-X-KEY:METHOD=SAMPLE-AES` with a `skd://`
 * FairPlay key — a licence exchange with a content decryption module, not
 * something to fetch. They are skipped, not attempted.
 */
export function drmOnly(track) {
  const all = track.media?.transcodings ?? [];
  return all.length > 0 && all.every(isDrm);
}

export function rankTranscodings(track, { preferAac = true, authenticated = false } = {}) {
  // Skip DRM rather than failing mid-download.
  const all = (track.media?.transcodings ?? []).filter((t) => !isDrm(t));
  if (!all.length) return [];

  const order = authenticated ? AUTHED_RANK : ANON_RANK;

  const score = (t) => {
    const i = order.indexOf(t.preset);
    const rank = i === -1 ? order.length : i;
    // Opting out of AAC means "give me the single-fetch progressive MP3 and
    // skip the segment assembly + remux entirely".
    return preferAac ? rank : t.format.protocol === 'progressive' ? -10 : rank;
  };

  return [...all].sort((a, b) => score(a) - score(b));
}
