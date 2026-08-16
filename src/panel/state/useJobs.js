import { useCallback, useEffect, useRef, useState } from 'react';
import { downloadRow } from '../../lib/download.js';
import { createLimiter } from '../../lib/limiter.js';

// Two pools, because there are two independent rate limits.
//
// Both are global rather than per-batch: start a second playlist while the
// first runs and independent pools would double what's in flight, each track
// fanning out ~40 segment requests, which is how you earn a 429 and lose both
// batches at once.
//
// Splitting them matters more than the numbers. A DRM track goes to lucida —
// a search, a resolve, a poll until their server has the file, then a download
// — which can run well over a minute and touches SoundCloud not at all. Sharing
// one pool meant such a track sat on one of only four SoundCloud slots for that
// whole time while perfectly ordinary tracks queued behind it. Now they only
// contend with each other.
const scPool = createLimiter(4);
// Lower, and deliberately: each of these fans out a search across four services
// at once, so three tracks is already twelve concurrent requests at their door.
const lucidaPool = createLimiter(3);

// How long a finished row stays on screen before it leaves.
//
// Long enough to read what happened and see it dissolve, short enough that a
// long crate doesn't turn into a wall of completed rows. Failures are exempt —
// see `expiring` below.
const LINGER_MS = 2600;
// The dissolve itself, matched to the thumbnail's dither-out in Thumb.jsx.
const DISSOLVE_MS = 620;

// Track ids that failed as DRM, kept across reloads.
//
// Local rather than session storage: the answer is a property of the track, not
// of this browsing session, and it doesn't change between visits. Fire and
// forget — a failed write only costs one wasted retry later.
const DRM_KEY = 'drmBlocked';

export async function loadDrmBlocked() {
  try {
    const { [DRM_KEY]: ids = [] } = await chrome.storage.local.get(DRM_KEY);
    return new Set(ids);
  } catch {
    return new Set();
  }
}

function rememberDrm(id) {
  loadDrmBlocked()
    .then((set) => {
      if (set.has(id)) return;
      set.add(id);
      return chrome.storage.local.set({ [DRM_KEY]: [...set] });
    })
    .catch(() => {});
}

/**
 * The download queue.
 *
 * This holds the rows themselves, not just their status, which is what makes it
 * a queue rather than a decoration on the current crate. The panel used to list
 * whatever playlist was in front and mark some of it as downloading — so
 * navigating away lost sight of work that was still running, and starting a
 * second playlist replaced the first in view while both were live.
 *
 * Now the list *is* the queue: rows are appended from wherever you started
 * them, they carry the crate they came from, and they leave once they're done.
 *
 *   id -> { row, crate, text, cls, inFlight, progress, done, leaving }
 */
export function useJobs() {
  const [jobs, setJobs] = useState(() => new Map());
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;

  // Removal timers, so a row that's re-queued while it's dissolving doesn't get
  // deleted out from under its second run.
  const timers = useRef(new Map());

  const setStatus = useCallback((id, text, cls = 'working', extra = {}) => {
    setJobs((prev) => {
      const next = new Map(prev);
      next.set(id, { ...(prev.get(id) ?? {}), text, cls, ...extra });
      return next;
    });
  }, []);

  const remove = useCallback((id) => {
    const t = timers.current.get(id);
    if (t) { clearTimeout(t.linger); clearTimeout(t.strip); timers.current.delete(id); }
    setJobs((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  /**
   * Start a row's exit: mark it leaving so it can animate, then drop it.
   *
   * Only successes expire. A failure that vanished on a timer would take the
   * reason with it — and the whole point of showing a failure is that you get
   * to decide what to do about it.
   */
  const expiring = useCallback((id) => {
    const linger = setTimeout(() => {
      setStatus(id, undefined, undefined, { leaving: true });
      const strip = setTimeout(() => remove(id), DISSOLVE_MS);
      timers.current.set(id, { ...(timers.current.get(id) ?? {}), strip });
    }, LINGER_MS);
    timers.current.set(id, { ...(timers.current.get(id) ?? {}), linger });
  }, [remove, setStatus]);

  useEffect(() => () => {
    for (const t of timers.current.values()) { clearTimeout(t.linger); clearTimeout(t.strip); }
  }, []);

  const list = [...jobs.values()];
  const active = list.filter((j) => j.inFlight).length;
  const pending = list.filter((j) => j.inFlight || !j.done).length;

  // Whole-queue progress. Counts a finished row as done rather than tracking
  // bytes: the formats differ wildly in size, so byte-weighting would make a
  // crate of AIFFs look stalled next to the same crate as MP3s.
  const settled = list.filter((j) => j.done).length;
  const total = list.length;
  const fraction = total
    ? (settled + list.reduce((n, j) => n + (j.inFlight ? (j.progress ?? 0) : 0), 0)) / total
    : 0;

  // Closing the panel kills every in-flight download — the fetches and blob
  // writes live in this page, and an MV3 worker can't take them over. Better a
  // prompt than a crate that silently comes up short.
  useEffect(() => {
    if (!active) return;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  }, [active]);

  /** Append rows to the queue and work them. Resolves when this batch is done. */
  const run = useCallback(async (rows, tracks, opts, crateTitle) => {
    // Already running from an earlier batch. The same track can sit in two
    // playlists, and downloading it twice races two writers onto one filename —
    // Chrome uniquifies it and leaves a stray duplicate.
    const queue = rows.filter((r) => !jobsRef.current.get(r.id)?.inFlight);
    const skipped = rows.length - queue.length;

    // Snapshot: `tracks` and the crate title are both replaced if you navigate
    // to another playlist mid-batch.
    const byId = new Map(queue.map((r) => [r.id, tracks.get(r.id)]));

    // Append everything up front so the queue shows the whole batch waiting,
    // not just the four the limiter happens to be running.
    setJobs((prev) => {
      const next = new Map(prev);
      for (const row of queue) {
        next.set(row.id, {
          ...(prev.get(row.id) ?? {}),
          row, crate: crateTitle,
          text: 'queued', cls: 'working',
          inFlight: false, done: false, leaving: false, progress: 0,
        });
      }
      return next;
    });

    const base = { crate: crateTitle, inFlight: true, done: false, leaving: false };

    // Known-DRM rows route straight to lucida, so they belong in that pool from
    // the start. A row that only *falls back* to lucida mid-flight keeps its
    // SoundCloud slot — rarer, and not worth handing a slot back mid-download.
    await Promise.allSettled(queue.map((row) => (row.drmOnly ? lucidaPool : scPool)(async () => {
      setStatus(row.id, 'starting', 'working', { ...base, row });
      try {
        const res = await downloadRow(row, byId.get(row.id), opts, (p) => {
          if (p.phase === 'segments' && p.total) {
            setStatus(row.id, `segments ${p.done}/${p.total}`, 'working',
              { ...base, progress: p.done / p.total });
          } else if (p.phase === 'fallback') {
            setStatus(row.id, p.reason ?? 'falling back', 'warn', base);
          } else {
            const label = { remuxing: 'remuxing', decoding: 'decoding', gate: 'working the gate' };
            // Name the service while it walks them — matching can take a while
            // per service, and "downloading" for 40s reads as a hang.
            const text = p.phase === 'lucida'
              ? (p.service ? `matching on ${p.service}` : 'trying lucida')
              : label[p.phase] ?? 'downloading';
            setStatus(row.id, text, 'working', base);
          }
        });


        const size = res.bytes ? ` · ${(res.bytes / 1e6).toFixed(1)} MB` : '';
        const failed = Boolean(res.gateFailed);
        setStatus(row.id, `${res.via}${size}`, failed ? 'warn' : 'ok',
          { inFlight: false, done: true, progress: 1 });
        // A clean finish is the only thing that leaves on its own.
        if (!failed) expiring(row.id);
      } catch (e) {
        // Remember tracks that turned out to be DRM so they stop being queued.
        //
        // The triage-time flag can't catch these on its own: they advertise
        // plain mp3_1_0 entries alongside the encrypted ones, so nothing looks
        // wrong until every plain one 404s. Only an attempt reveals it — so
        // record the answer rather than rediscovering it on every re-queue.
        if (/DRM-protected/.test(e.message)) rememberDrm(row.id);
        setStatus(row.id, e.message, 'err', { inFlight: false, done: true });
      }
    })));

    return { skipped };
  }, [setStatus, expiring]);

  return { jobs, active, pending, fraction, total, run, setStatus, remove };
}
