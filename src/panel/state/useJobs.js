import { useCallback, useEffect, useRef, useState } from 'react';

// The concurrency pools live in offscreen.js now, alongside the work they bound.
//
// This hook no longer downloads anything. It hands a batch to the offscreen
// document and watches, because that document outlives the panel and this one
// does not. A side panel is dismissed constantly, and every fetch and blob write
// used to live in it, so closing it lost whatever was in flight. Now closing the
// panel is a UI event rather than a data event.

// How long a finished row stays on screen before it leaves.
const LINGER_MS = 2600;
// The dissolve itself, matched to the row's dither-out in Row.jsx.
const DISSOLVE_MS = 620;

// Track ids that failed as DRM, kept across reloads.
//
// Local rather than session storage: the answer is a property of the track, not
// of this browsing session, and it doesn't change between visits.
const DRM_KEY = 'drmBlocked';

export async function loadDrmBlocked() {
  try {
    const { [DRM_KEY]: ids = [] } = await chrome.storage.local.get(DRM_KEY);
    return new Set(ids);
  } catch {
    return new Set();
  }
}

/**
 * A view onto the download queue.
 *
 *   id -> { row, crate, text, cls, inFlight, progress, done, leaving }
 *
 * The rows themselves live here, not just their status, which is what makes the
 * panel a queue rather than a decoration on whatever crate is in front.
 */
export function useJobs() {
  const [jobs, setJobs] = useState(() => new Map());

  // Removal timers, so a row re-queued while it's dissolving doesn't get
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
    // Drop it there too. Without this, reopening the panel resyncs from the
    // offscreen document and every finished row comes back from the dead.
    chrome.runtime.sendMessage({ type: 'queue:forget', id }).catch(() => {});
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
   * reason with it, and the whole point of showing a failure is that you get to
   * decide what to do about it.
   */
  const expiring = useCallback((id) => {
    if (timers.current.get(id)?.linger) return;   // already on its way out
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

  // Catch up on whatever is already running, then keep up from there. This is
  // what makes reopening the panel mid-crate show the crate rather than nothing.
  useEffect(() => {
    let live = true;

    chrome.runtime.sendMessage({ type: 'queue:state' })
      .then((res) => {
        if (!live || !res?.ok) return;
        setJobs(new Map(res.jobs.map(({ id, ...j }) => [id, j])));
        for (const j of res.jobs) if (j.done && j.cls === 'ok') expiring(j.id);
      })
      .catch(() => {});

    const onMessage = (msg) => {
      if (msg?.type !== 'queue:progress') return;
      setJobs((prev) => {
        const next = new Map(prev);
        next.set(msg.id, { ...(prev.get(msg.id) ?? {}), ...msg.patch });
        return next;
      });
      // A clean finish is the only thing that leaves on its own.
      if (msg.patch?.done && msg.patch?.cls === 'ok') expiring(msg.id);
    };

    chrome.runtime.onMessage.addListener(onMessage);
    return () => { live = false; chrome.runtime.onMessage.removeListener(onMessage); };
  }, [expiring]);

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

  /** Hand a batch to the offscreen document. Resolves once it's accepted. */
  const run = useCallback(async (rows, tracks, opts, crateTitle) => {
    // Maps don't survive runtime messaging, which is JSON, and only the tracks
    // this batch needs are worth sending rather than the whole crate.
    const wanted = new Set(rows.map((r) => r.id));
    const res = await chrome.runtime.sendMessage({
      type: 'queue:run',
      rows,
      tracks: [...tracks.values()].filter((t) => t && wanted.has(t.id)),
      opts,
      crateTitle,
    }).catch(() => null);

    return { skipped: res?.skipped ?? 0 };
  }, []);

  return { jobs, active, pending, fraction, run, setStatus, remove };
}
