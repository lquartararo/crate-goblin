// What the crate actually cost to fill.
//
// Nothing was kept before this: settings, a session cache and a watch list, and
// no record that a download had ever happened. So the panel could say what was
// in front of it and nothing about the weeks behind it.
//
// Deliberately tiny. One entry per finished track — when, where it came from,
// whether it worked — and no titles, no artists, no URLs. A history of what you
// listen to is a different kind of thing to keep than a count of how often the
// gate route beat the stream route, and only the second one is any use here.

import { host } from './host.js';

// Through the host seam, not chrome.storage directly.
//
// Recording happens in the offscreen document, which supports only
// chrome.runtime — no storage. Writing straight to chrome.storage.local there
// throws on `undefined.local`, the catch below swallowed it, and nothing was
// ever written: the about box read zero tracks forever and the chart never had
// enough to draw. host.js exists precisely for this and this file went around
// it. Same mistake this pipeline made once before, in the same place.
const KEY = 'stats';

// Roughly a year of heavy weeks. Old entries fall off the front rather than the
// store growing without bound, and nothing here is worth more than that.
const CAP = 600;

/**
 * Which route got the file, from the `via` line the download reports.
 *
 * Those strings are written for a human reading one row — "aac_256k hls →
 * aiff", "lucida/tidal → flac · matched …" — so they are classified here, once,
 * rather than parsed later by something that wants a number. The first token is
 * the stable part; everything after it describes that particular track.
 */
export function sourceOf(via = '') {
  const s = String(via);
  if (s.startsWith('original')) return 'original';
  if (s.startsWith('gate')) return 'gate';
  if (s.startsWith('lucida/')) return 'lucida';
  if (s.startsWith('yt-dlp')) return 'yt-dlp';
  return 'stream';
}

export const SOURCES = ['original', 'gate', 'stream', 'lucida', 'yt-dlp'];

// Downloads finish concurrently, and read-modify-write on shared storage loses
// entries when two land together. Everything recording runs in the one offscreen
// context, so a promise chain is enough to make the writes take turns.
let chain = Promise.resolve();

/** Note one finished track. Never throws — a failed write must not fail a download. */
export function record({ via, ok = true, bytes = 0 }) {
  chain = chain.then(async () => {
    try {
      const log = (await host.getStored(KEY)) ?? [];
      log.push({ t: Date.now(), s: sourceOf(via), ok: ok ? 1 : 0, b: Math.round(bytes / 1e6) });
      await host.setStored(KEY, log.slice(-CAP));
    } catch {
      // Storage unavailable or full. The download already succeeded; this is
      // bookkeeping and is not worth surfacing.
    }
  });
  return chain;
}

export async function readLog() {
  try {
    const log = await host.getStored(KEY);
    return Array.isArray(log) ? log : [];
  } catch {
    return [];
  }
}

/**
 * The log folded into what the panel draws.
 *
 * `weeks` runs oldest to newest and always has `span` entries, including the
 * empty ones — a gap where you did not dig is part of the shape, and dropping
 * it would draw a busy month and a quiet one identically.
 */
export function summarize(log, span = 12, now = Date.now()) {
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  const start = now - (span - 1) * WEEK;

  const weeks = Array.from({ length: span }, () => 0);
  const bySource = Object.fromEntries(SOURCES.map((s) => [s, 0]));
  let failed = 0;
  let mb = 0;

  for (const e of log) {
    if (!e?.ok) { failed++; continue; }
    if (e.s in bySource) bySource[e.s]++;
    mb += e.b || 0;
    if (e.t >= start) weeks[Math.min(span - 1, Math.floor((e.t - start) / WEEK))]++;
  }

  const total = log.filter((e) => e?.ok).length;
  const top = SOURCES.reduce((a, b) => (bySource[b] > bySource[a] ? b : a), SOURCES[0]);

  return { weeks, bySource, total, failed, mb, top: bySource[top] ? top : null };
}
