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
import { createLimiter } from './lib/limiter.js';

const ask = (type, payload) => chrome.runtime.sendMessage({ type, ...payload });

setHost({
  getStored: (key) => ask('host:get', { key }).then((r) => r?.value),
  setStored: (key, value) => ask('host:set', { key, value }),
  oauthToken: () => ask('host:oauth').then((r) => r?.token ?? null),

  async save(blob, filename) {
    const url = URL.createObjectURL(blob);
    try {
      const res = await ask('host:save', { url, filename });
      if (!res?.ok) throw new Error(res?.reason ?? 'download failed');
      return res.id;
    } finally {
      // Long enough for the download to have been read off the URL.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
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
const scPool = createLimiter(4);
const lucidaPool = createLimiter(3);

/** id -> the last status pushed, so a reopened panel can catch up. */
const state = new Map();

function push(id, patch) {
  state.set(id, { ...(state.get(id) ?? {}), ...patch });
  // Fire and forget: with no panel open there is no receiver, and that is the
  // normal case rather than an error.
  chrome.runtime.sendMessage({ type: 'queue:progress', id, patch }).catch(() => {});
}

async function runBatch({ rows, tracks, opts, crateTitle }) {
  const byId = new Map((tracks ?? []).map((t) => [t.id, t]));

  for (const row of rows) {
    push(row.id, { row, crate: crateTitle, text: 'queued', cls: 'working',
                   inFlight: false, done: false, leaving: false, progress: 0 });
  }

  const base = { crate: crateTitle, inFlight: true, done: false, leaving: false };

  await Promise.allSettled(rows.map((row) => (row.drmOnly ? lucidaPool : scPool)(async () => {
    push(row.id, { ...base, row, text: 'starting', cls: 'working' });
    try {
      const res = await downloadRow(row, byId.get(row.id), { ...opts, folder: crateTitle }, (p) => {
        if (p.phase === 'segments' && p.total) {
          push(row.id, { ...base, text: `segments ${p.done}/${p.total}`, cls: 'working',
                         progress: p.done / p.total });
        } else if (p.phase === 'fallback') {
          push(row.id, { ...base, text: p.reason ?? 'falling back', cls: 'warn' });
        } else {
          const label = { remuxing: 'remuxing', decoding: 'decoding', gate: 'working the gate' };
          const text = p.phase === 'lucida'
            ? (p.service ? `looking on ${p.service}` : 'looking elsewhere')
            : label[p.phase] ?? 'downloading';
          push(row.id, { ...base, text, cls: 'working' });
        }
      });

      const size = res.bytes ? ` · ${(res.bytes / 1e6).toFixed(1)} MB` : '';
      const failed = Boolean(res.gateFailed);
      push(row.id, { text: `${res.via}${size}`, cls: failed ? 'warn' : 'ok',
                     inFlight: false, done: true, progress: 1 });
    } catch (e) {
      push(row.id, { text: e.message, cls: 'err', inFlight: false, done: true });
    }
  })));
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
