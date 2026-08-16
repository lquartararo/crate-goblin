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
  if (row.previewOnly) throw new Error('Go+ preview only — sign in for the full track');

  const res = await downloadRow(row, tracks[0], await currentOptions(), () => {});


  return { title: `${row.artist} — ${row.title}`, via: res.via, bytes: res.bytes };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'offscreen:download') return false;
  downloadOne(msg.url).then(
    (r) => sendResponse({ ok: true, ...r }),
    (e) => sendResponse({ ok: false, reason: e?.message ?? String(e) }),
  );
  return true; // async
});
