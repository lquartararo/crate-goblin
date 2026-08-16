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
import { BUCKET } from './triage.js';

// Anything shorter is a clip or an intro, anything much longer is a mix or a
// full set uploaded under a track's name. Neither is the record.
const MIN_SECONDS = 45;
const MAX_SECONDS = 60 * 25;

// How far the match may drift from the duration SoundCloud reported. Edits of
// the same track vary, but not by much, and duration is the only objective
// check available against a title that merely looks right.
const DURATION_TOLERANCE = 25;

let client = null;

/**
 * Every InnerTube request, routed through a real YouTube page.
 *
 * Host permissions get past CORS but not past YouTube: `/youtubei/v1/player`
 * answers 403 to anything carrying an extension origin, whatever the payload
 * says. Measured 403 from the offscreen document and fine from a youtube.com
 * page, which is the same shape as the lucida problem and takes the same fix.
 *
 * youtubei.js hands us either a URL or a Request, so both are unwrapped here
 * before crossing runtime messaging, which is JSON and would flatten a Request
 * to nothing.
 */
async function pageFetch(input, init) {
  // Three shapes arrive here: a string, a URL, and a Request.
  //
  // Getting this wrong is not obvious from the failure. An empty string handed
  // to fetch() inside the page resolves to *the page itself*, so a POST lands
  // on a YouTube watch page and comes back 405 Method Not Allowed — an error
  // about the method, for a bug in the URL, reported against a blank address.
  // So it is checked here, where the shape that caused it is still in scope.
  const url = typeof input === 'string' ? input
    : input instanceof URL ? input.href
    : typeof input?.url === 'string' ? input.url
    : null;

  if (!url || !/^https?:/i.test(url)) {
    const shape = input === null ? 'null'
      : input === undefined ? 'undefined'
      : (input?.constructor?.name ?? typeof input);
    throw new Error(`youtube: unusable request URL from a ${shape}: ${JSON.stringify(url)}`);
  }

  const src = init ?? (input instanceof Request ? input : null);
  const method = src?.method ?? 'GET';

  // Built by hand rather than passed through. executeScript arguments cross a
  // structured clone, and a Headers object, an AbortSignal or a stream body all
  // fail it — quietly taking the whole call down with them.
  const opts = {
    method,
    headers: src?.headers
      ? (src.headers instanceof Headers
          ? Object.fromEntries(src.headers.entries())
          : { ...src.headers })
      : undefined,
    body: method === 'GET' || method === 'HEAD'
      ? undefined
      : (input instanceof Request && !init ? await input.clone().text()
         : typeof src?.body === 'string' ? src.body
         : undefined),
  };

  const res = await chrome.runtime.sendMessage({ type: 'youtube:fetch', url, init: opts });
  if (!res?.ok) throw new Error(res?.reason ?? 'youtube request failed');

  // Rebuilt as a Response because that is what the library expects back. `url`
  // is read-only on a constructed Response and stays empty, which is why their
  // error messages had nothing to name — so it is put back deliberately.
  const out = new Response(res.body, { status: res.status });
  Object.defineProperty(out, 'url', { value: res.url ?? url });
  return out;
}

async function innertube() {
  client ??= await Innertube.create({
    cache: new UniversalCache(false),
    generate_session_locally: true,
    fetch: pageFetch,
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

// --------------------------------------------------------------- as a source
//
// YouTube as a place you browse, not only as a last resort behind SoundCloud.
// Rows come out in the same shape triage produces, so the queue, the filename
// builder, the tagger and the panel all take them without knowing where they
// came from.

const videoId = (url) => {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith('youtu.be')) return u.pathname.slice(1) || null;
    return u.searchParams.get('v');
  } catch { return null; }
};

const listId = (url) => {
  try { return new URL(url).searchParams.get('list'); } catch { return null; }
};

/**
 * One row, in triage's shape.
 *
 * `source: 'youtube'` is what routing reads. Without it a YouTube row would
 * walk the SoundCloud chain and fail on the first API call.
 */
function toRow(v) {
  const id = v?.id ?? v?.video_id;
  if (!id) return null;

  const secs = seconds(v) ?? 0;
  const channel = v?.author?.name ?? v?.channel?.name ?? v?.short_byline_text?.text ?? '';
  const title = v?.title?.text ?? v?.title ?? '';

  return {
    id: `yt:${id}`,
    source: 'youtube',
    title,
    rawTitle: title,
    // A channel is not an artist, but for music uploads it is usually the
    // closest thing available, and naming.js will pull a real credit out of an
    // "Artist - Title" video title where there is one.
    artist: channel,
    artistDeclared: false,
    isrc: null,
    genre: null,
    album: null,
    year: null,
    durationMs: secs * 1000,
    permalink: `https://www.youtube.com/watch?v=${id}`,
    artwork: v?.thumbnails?.at?.(-1)?.url ?? v?.best_thumbnail?.url ?? null,
    license: null,
    previewOnly: false,
    drmOnly: false,
    downloadCount: 0,
    // Nothing here is gated or free in SoundCloud's sense; it is all one kind.
    bucket: BUCKET.STREAM,
    kind: 'youtube',
    url: null,
  };
}

/**
 * Load a YouTube watch or playlist URL into rows.
 *
 * Shaped like loadTracks so useCrate can treat both sites the same.
 */
export async function loadYouTube(pageUrl) {
  const yt = await innertube();
  const list = listId(pageUrl);
  const isPlaylist = new URL(pageUrl).pathname === '/playlist' && list;

  if (isPlaylist) {
    const pl = await yt.getPlaylist(list);
    const rows = (pl?.videos ?? []).map(toRow).filter(Boolean);
    return { title: pl?.info?.title ?? 'YouTube playlist', album: null, rows };
  }

  const id = videoId(pageUrl);
  if (!id) throw new Error('no video in that URL');

  const info = await yt.getBasicInfo(id);
  const b = info?.basic_info ?? {};
  const row = toRow({
    id,
    title: b.title,
    author: { name: b.author },
    duration: { seconds: b.duration },
    thumbnails: b.thumbnail,
  });
  if (!row) throw new Error('could not read that video');
  return { title: b.title ?? 'YouTube', album: null, rows: [row] };
}

/** Fetch audio for a row this module produced. */
export async function fetchRowAudio(row, { onProgress, signal } = {}) {
  const yt = await innertube();
  const id = String(row.id).replace(/^yt:/, '');

  onProgress?.({ stage: 'resolving' });
  const info = await yt.getBasicInfo(id);
  const format = bestAudio(info);
  if (!format) throw new Error('YouTube offered no audio-only stream');

  const res = await fetch(format.decipher(yt.session.player), { signal });
  if (!res.ok) throw new Error(`YouTube audio ${res.status}`);
  return res.blob();
}
