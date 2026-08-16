// Runs the download pipeline for one-click track downloads.
//
// The panel can't do this job: opening it is exactly what the in-page button is
// meant to avoid. The service worker can't either — assembling HLS segments
// needs URL.createObjectURL, which MV3 workers don't have.
//
// But an offscreen document supports *only* chrome.runtime. No storage, no
// cookies, no downloads. So everything the pipeline needs from those is proxied
// back to the service worker, which does have them. The blob itself never
// crosses that boundary — runtime messaging is JSON, so a Blob wouldn't
// survive. Only the blob URL travels, and it stays valid because it belongs to
// this document, which is same-origin with the worker.

import { setHost } from './lib/host.js';
import { loadTracks } from './lib/api.js';
import { triage } from './lib/triage.js';
import { downloadRow } from './lib/download.js';
import { record } from './lib/stats.js';
import { createLimiter, createAdaptiveLimiter } from './lib/limiter.js';
import { reportPressureTo } from './lib/lucida.js';

const ask = (type, payload) => chrome.runtime.sendMessage({ type, ...payload });

setHost({
  getStored: (key) => ask('host:get', { key }).then((r) => r?.value),
  setStored: (key, value) => ask('host:set', { key, value }),
  oauthToken: () => ask('host:oauth').then((r) => r?.token ?? null),

  async save(blobOrUrl, filename) {
    // A string is already a URL the browser can fetch; only a Blob needs
    // wrapping. Gate files come as the former so they never cross an origin
    // check the extension would fail.
    const isUrl = typeof blobOrUrl === 'string';
    const url = isUrl ? blobOrUrl : URL.createObjectURL(blobOrUrl);
    try {
      const res = await ask('host:save', { url, filename });
      if (!res?.ok) throw new Error(res?.reason ?? 'download failed');
      return res.id;
    } finally {
      // Long enough for the download to have been read off the URL.
      if (!isUrl) setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  },
});

const DEFAULTS = { mode: 'best', 'gated-policy': 'auto', container: 'aiff' };

/** Whatever the panel last saved, so a one-click download matches it. */
async function currentOptions() {
  const saved = (await ask('host:get', { key: 'settings' }))?.value ?? {};
  const s = { ...DEFAULTS, ...saved };
  return { mode: s.mode, gatedPolicy: s['gated-policy'], container: s.container };
}

async function downloadOne(url) {
  const result = await loadTracks(url);
  const tracks = Array.isArray(result) ? result : result.tracks;
  if (!tracks?.length) throw new Error('no track on that page');

  const row = triage(tracks, { album: Array.isArray(result) ? null : result.album }).rows[0];
  if (!row) throw new Error('could not read that track');
  if (row.previewOnly) throw new Error('SoundCloud only offered a 30 second preview');

  const res = await downloadRow(row, tracks[0], await currentOptions(), () => {});


  return { title: `${row.artist} — ${row.title}`, via: res.via, bytes: res.bytes };
}

// ------------------------------------------------------------------- queue
//
// Batches run here rather than in the panel, which is the only way they can
// survive the panel closing. The panel is a side panel: it is dismissed
// constantly, and every fetch and blob write used to live in it, so a crate
// half-downloaded was a crate lost.
//
// This document outlives it. The panel now sends work here, watches progress
// messages, and resyncs from `state` when it reopens, so closing it is a UI
// event rather than a data event.
// Was 4, when each slot meant decoding and re-encoding a track on the panel's
// own thread and more of them made the UI stutter. The work is out of process
// now — these slots mostly wait on a socket — so the ceiling is SoundCloud's
// patience rather than ours.
// Back down from six. Moving the work out of the browser did not raise
// SoundCloud's tolerance — six tracks each resolving five transcodings is
// thirty api-v2 calls at once, and the ones that get refused simply drop out of
// yt-dlp's format list. That is where a 96k file comes from: not a track that
// only had 96k, but a track whose better transcodings failed to resolve.
const scPool = createLimiter(3);
// Starts at three and finds its own ceiling. A fixed one is a guess in both
// directions: three was too many for one crate and one is too few for a service
// that is fine most days. It halves on a refusal, holds every worker behind the
// same gate while the service recovers, and creeps back up once it stops being
// told no.
const lucidaPool = createAdaptiveLimiter({ start: 3, min: 1, max: 4 });
reportPressureTo(lucidaPool);

/** id -> the last status pushed, so a reopened panel can catch up. */
const state = new Map();

function push(id, patch) {
  state.set(id, { ...(state.get(id) ?? {}), ...patch });
  // Fire and forget: with no panel open there is no receiver, and that is the
  // normal case rather than an error.
  chrome.runtime.sendMessage({ type: 'queue:progress', id, patch }).catch(() => {});
}

// Batches can overlap — queue a second playlist while the first is running and
// both are live. The tab is only free once the last one lets go of it.
let batches = 0;

// Rows the panel has taken back. Checked at the moment a slot frees rather than
// when the batch was queued, which is the whole point: the queue is mostly
// waiting, so a track cancelled while four others run genuinely never starts.
const cancelled = new Set();

async function runBatch({ rows, tracks, opts, crateTitle }) {
  batches++;
  const byId = new Map((tracks ?? []).map((t) => [t.id, t]));

  for (const row of rows) {
    push(row.id, { row, crate: crateTitle, text: 'queued', cls: 'working',
                   inFlight: false, done: false, leaving: false, progress: 0 });
  }

  const base = { crate: crateTitle, inFlight: true, done: false, leaving: false };

  await Promise.allSettled(rows.map((row) => (row.drmOnly ? lucidaPool : scPool)(async () => {
    if (cancelled.has(row.id)) {
      cancelled.delete(row.id);
      return push(row.id, { text: 'cancelled', cls: 'ok', inFlight: false, done: true, leaving: true });
    }
    push(row.id, { ...base, row, text: 'starting', cls: 'working' });
    try {
      // The folder is the caller's call — it knows whether this is a crate or
      // one track. crateTitle is only the label on the row.
      const res = await downloadRow(row, byId.get(row.id), opts, (p) => {
        if (p.phase === 'segments' && p.total) {
          push(row.id, { ...base, text: `segments ${p.done}/${p.total}`, cls: 'working',
                         progress: p.done / p.total });
        } else if (p.phase === 'fallback') {
          // Mid-download, and still working. This used to flash the raw error
          // in amber while the track was on its way, which is the moment least
          // worth alarming anyone: nothing has failed, a route was closed and
          // another is being tried. The reason goes to the console for whoever
          // is debugging, and the row says what is happening.
          if (p.reason) console.debug('[crate] fallback:', row.title, '—', p.reason);
          push(row.id, { ...base, text: 'trying another way', cls: 'working' });
        } else {
          const label = { remuxing: 'converting', decoding: 'decoding', gate: 'working the gate' };
          const text = p.phase === 'lucida'
            ? (p.service ? `looking on ${p.service}` : 'looking elsewhere')
            : label[p.phase] ?? 'downloading';
          push(row.id, { ...base, text, cls: 'working' });
        }
      });

      const size = res.bytes ? ` · ${(res.bytes / 1e6).toFixed(1)} MB` : '';
      // Only flag a file that is not what was asked for. A gate that refused
      // and a stream that answered is a track you have, in the format you
      // picked, with its tags — the gate is an implementation detail and
      // colouring it amber reported a working download as a problem. The
      // reason still travels in the text.
      const failed = Boolean(res.degraded);
      // Kept out of the row and out of the way, but not thrown away — this is
      // the only trace of which route was tried first.
      if (res.note) console.debug('[crate] took the fallback:', row.title, '—', res.note);
      record({ via: res.via, ok: !failed, bytes: res.bytes });
      push(row.id, { text: `${res.via}${size}`, cls: failed ? 'warn' : 'ok',
                     inFlight: false, done: true, progress: 1 });
    } catch (e) {
      record({ via: '', ok: false });
      // A track you took back is not a track that failed.
      if (cancelled.has(row.id)) {
        cancelled.delete(row.id);
        return push(row.id, { text: 'cancelled', cls: 'ok', inFlight: false, done: true, leaving: true });
      }
      push(row.id, { text: e.message, cls: 'err', inFlight: false, done: true });
    }
  })));

  // Nothing left to look anything up for. The tab has its own idle timer as a
  // backstop, but sitting in the strip for another 45 seconds after the work is
  // visibly finished reads as something that was left behind.
  if (--batches === 0) {
    chrome.runtime.sendMessage({ type: 'lucida:release' }).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'queue:cancel') {
    cancelled.add(msg.id);
    // Already downloading: cut the port. The host reads stdin, so closing it
    // ends the process and takes yt-dlp with it. A row still waiting for a slot
    // never starts, which needs nothing else.
    chrome.runtime.sendMessage({ type: 'native:cancel', id: msg.id }).catch(() => {});
    const job = state.get(msg.id);
    if (!job?.inFlight) push(msg.id, { text: 'cancelled', cls: 'ok', inFlight: false, done: true, leaving: true });
    sendResponse({ ok: true });
    return false;
  }

  if (msg?.type === 'queue:run') {
    // Answers immediately. The batch outlives the message, and the panel wants
    // to know the work was accepted, not wait for a crate to finish.
    const already = new Set([...state.entries()]
      .filter(([, j]) => j.inFlight).map(([id]) => id));
    const rows = (msg.rows ?? []).filter((r) => !already.has(r.id));
    runBatch({ ...msg, rows });
    sendResponse({ ok: true, skipped: (msg.rows ?? []).length - rows.length });
    return true;
  }

  if (msg?.type === 'queue:state') {
    sendResponse({ ok: true, jobs: [...state.entries()].map(([id, j]) => ({ id, ...j })) });
    return true;
  }

  if (msg?.type === 'queue:forget') {
    state.delete(msg.id);
    sendResponse({ ok: true });
    return true;
  }

  if (msg?.type !== 'offscreen:download') return false;
  downloadOne(msg.url).then(
    (r) => sendResponse({ ok: true, ...r }),
    (e) => sendResponse({ ok: false, reason: e?.message ?? String(e) }),
  );
  return true; // async
});
