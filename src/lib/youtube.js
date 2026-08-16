// Last source before giving up: find the recording on YouTube.
//
// Reached only when SoundCloud has nothing servable and lucida found no match
// on Amazon, Tidal, Deezer or Yandex. That combination is common for exactly
// the material a DJ crate is full of — edits, bootlegs, budots remixes — which
// have no commercial release anywhere but are often uploaded to YouTube.
//
// Be clear about the trade. YouTube audio is Opus around 130kbps, roughly what
// SoundCloud's own stream gives you. It is a worse master than anything above
// it in the chain and it is only worth taking when the alternative is nothing.
// So it sits last, and the row says where the file came from.
//
// Why youtubei.js rather than rolling this ourselves: YouTube rotates the
// signature scrambling that hides the media URLs, and the library carries a JS
// parser (meriyah) so it reads the descrambling out of YouTube's own player
// code instead of hardcoding it. Reimplementing that means signing up to chase
// their changes, and it breaks silently, which for this tool means finding out
// during a set.

import { Innertube, UniversalCache } from 'youtubei.js/web';

// Anything shorter is a clip or an intro, anything much longer is a mix or a
// full set uploaded under a track's name. Neither is the record.
const MIN_SECONDS = 45;
const MAX_SECONDS = 60 * 25;

// How far the match may drift from the duration SoundCloud reported. Edits of
// the same track vary, but not by much, and duration is the only objective
// check available against a title that merely looks right.
const DURATION_TOLERANCE = 25;

let client = null;

async function innertube() {
  client ??= await Innertube.create({
    cache: new UniversalCache(false),
    generate_session_locally: true,
    // The extension holds host permissions for these origins, so requests are
    // not subject to CORS and no proxy is needed.
    fetch: (input, init) => fetch(input, init),
  });
  return client;
}

/** Seconds, from whatever shape the search result carries it in. */
function seconds(item) {
  const raw = item?.duration?.seconds ?? item?.duration?.text ?? null;
  if (typeof raw === 'number') return raw;
  if (typeof raw !== 'string') return null;
  const parts = raw.split(':').map(Number);
  if (parts.some(Number.isNaN)) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/**
 * Pick a result worth taking.
 *
 * Duration is the check that matters. A title match on a remix means very
 * little — half of YouTube is the same title over a different edit, a slowed
 * version, or an hour of it looped — and the length is the one thing that can
 * contradict a title that looks right.
 */
function choose(results, wantSeconds) {
  const usable = results
    .map((r) => ({ r, secs: seconds(r) }))
    .filter(({ r, secs }) =>
      r?.id
      && secs !== null
      && secs >= MIN_SECONDS
      && secs <= MAX_SECONDS);

  if (!usable.length) return null;

  if (wantSeconds) {
    const close = usable
      .map((u) => ({ ...u, drift: Math.abs(u.secs - wantSeconds) }))
      .filter((u) => u.drift <= DURATION_TOLERANCE)
      .sort((a, b) => a.drift - b.drift);
    return close[0]?.r ?? null;
  }

  // No duration to check against, so there is nothing to verify a match with.
  // Refusing beats guessing: a wrong track in a crate is worse than a gap.
  return null;
}

/** Highest-bitrate audio-only stream, or null when only muxed ones exist. */
function bestAudio(info) {
  const formats = info?.streaming_data?.adaptive_formats ?? [];
  return formats
    .filter((f) => f.has_audio && !f.has_video && f.url)
    .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0] ?? null;
}

/**
 * Find and fetch a track's audio.
 *
 * @param {string} query        "artist title"
 * @param {number} durationMs   what SoundCloud said it should be
 * @returns {Promise<{blob: Blob, title: string, videoId: string}>}
 */
export async function fetchFromYouTube(query, { durationMs, onProgress, signal } = {}) {
  const yt = await innertube();

  onProgress?.({ stage: 'searching' });
  const search = await yt.search(query, { type: 'video' });
  const picked = choose(search?.videos ?? [], durationMs ? Math.round(durationMs / 1000) : null);
  if (!picked) throw new Error('no YouTube match of the right length');

  onProgress?.({ stage: 'resolving' });
  const info = await yt.getBasicInfo(picked.id);

  const format = bestAudio(info);
  if (!format) throw new Error('YouTube offered no audio-only stream');

  const res = await fetch(format.decipher(yt.session.player), { signal });
  if (!res.ok) throw new Error(`YouTube audio ${res.status}`);

  return {
    blob: await res.blob(),
    title: info?.basic_info?.title ?? picked.title?.text ?? query,
    videoId: picked.id,
  };
}
