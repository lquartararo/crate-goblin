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
 * Which route got the file, guessed from the `via` line.
 *
 * A fallback only. The route is now stated outright by the download, because
 * inferring it from the display string made that string load-bearing: renaming
 * "lucida/amazon → mp3" to "amazon → mp3" for the sake of the row silently
 * refiled every lucida download as a stream, and nothing failed to say so.
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
export function record({ via, source, genre, seconds, ok = true, bytes = 0 }) {
  chain = chain.then(async () => {
    try {
      const log = (await host.getStored(KEY)) ?? [];
      log.push({
        t: Date.now(),
        s: source && SOURCES.includes(source) ? source : sourceOf(via),
        ok: ok ? 1 : 0,
        b: Math.round(bytes / 1e6),
        // Trimmed hard. SoundCloud genres are free text and some are a
        // paragraph; this is for a chart, not for the record.
        g: genre ? String(genre).trim().slice(0, 24) : undefined,
        d: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : undefined,

      });
      await host.setStored(KEY, log.slice(-CAP));
    } catch {
      // Storage unavailable or full. The download already succeeded; this is
      // bookkeeping and is not worth surfacing.
    }
  });
  return chain;
}

// Announced, because the charts are on screen behind the dialog that clears
// them. Resetting emptied the store and left every chart drawn from the copy it
// had already read — the numbers in the dialog went to zero and the graphs kept
// the old shape, which looks like a reset that only half worked.
export const STATS_EVENT = 'cg:stats';

/** Forget everything. The history is a convenience, not a record. */
export async function clearLog() {
  try { await host.setStored(KEY, []); } catch { /* nothing to clear */ }
  try { dispatchEvent(new Event(STATS_EVENT)); } catch { /* no window here */ }
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

  const weeks = Array.from({ length: span }, () => 0);
  // Counted back from now, not forward from a start point.
  //
  // Forward was off by one for everything: a track recorded a millisecond ago
  // divided to 10.999… and floored into the previous bucket, so the newest
  // column was empty except in the instant a download landed. The chart drew
  // this week's digging as last week's, every time.
  const ageInWeeks = (t) => Math.floor((now - t) / WEEK);
  const bySource = Object.fromEntries(SOURCES.map((s) => [s, 0]));
  let failed = 0;
  let mb = 0;
  let secs = 0;

  for (const e of log) {
    if (!e?.ok) { failed++; continue; }
    if (e.s in bySource) bySource[e.s]++;
    mb += e.b || 0;
    secs += e.d || 0;
    const age = ageInWeeks(e.t);
    if (age >= 0 && age < span) weeks[span - 1 - age]++;
  }

  // What you actually dig for, biggest first. Only tracks that arrived and only
  // ones that stated a genre — SoundCloud leaves it blank often enough that
  // counting the blanks would make "unknown" the top genre on most crates.
  // Keyed case-insensitively: SoundCloud genres are free text, so "BUDOTS" and
  // "Budots" are one genre typed twice and splitting them halves both. The
  // first spelling seen is the one shown.
  const genres = new Map();
  for (const e of log) {
    if (!e?.ok || !e.g) continue;
    const key = e.g.toLowerCase();
    const seen = genres.get(key);
    genres.set(key, { name: seen?.name ?? e.g, n: (seen?.n ?? 0) + 1 });
  }
  const topGenres = [...genres.values()].sort((a, b) => b.n - a.n).slice(0, 5);

  const total = log.filter((e) => e?.ok).length;
  const top = SOURCES.reduce((a, b) => (bySource[b] > bySource[a] ? b : a), SOURCES[0]);

  return { weeks, bySource, topGenres, total, failed, mb, seconds: secs,
           top: bySource[top] ? top : null };
}
