// Talking to the local downloader.
//
// Everything the extension cannot do itself happens out here. YouTube stopped
// serving media URLs to any browser context, and the token that unlocks them
// needs an eval that Manifest V3 forbids in an extension page — so the work goes
// to yt-dlp, which is maintained by people who do nothing else and updates
// itself monthly when YouTube shifts.
//
// The audio never crosses this channel. Chrome caps a native message at 1MB and
// a track is many times that, so yt-dlp writes the file and only the path comes
// back. That also means the conversion and tagging happen out there, which is
// why a YouTube download is not routed through finalize().

const HOST = 'sh.crate.goblin';

// Answered once per worker life. The bridge is either installed or it is not,
// and asking on every track would spawn a process to learn nothing.
let probed = null;

/** @returns {Promise<{ok: boolean, version: string|null, reason?: string}>} */
export async function probeBridge() {
  probed ??= new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    try {
      chrome.runtime.sendNativeMessage(HOST, { type: 'probe' }, (res) => {
        // lastError is how "not installed" arrives, and it must be read inside
        // the callback or Chrome logs it as unchecked.
        const err = chrome.runtime.lastError;
        if (err) return done({ ok: false, version: null, reason: err.message });
        // Everything the host said, not the three fields the first caller
        // happened to need. It also reports ffmpeg, the JS runtime and the log
        // path, and narrowing here is why the about box called a working ffmpeg
        // missing — the field never left this function.
        done({
          ...res,
          ok: Boolean(res?.ok),
          version: res?.version ?? null,
          reason: res?.ok ? undefined : 'yt-dlp is not installed',
        });
      });
    } catch (e) {
      done({ ok: false, version: null, reason: e?.message ?? String(e) });
    }

    // A host that never answers would otherwise hang the first download
    // forever, with the row saying nothing.
    setTimeout(() => done({ ok: false, version: null, reason: 'the bridge did not answer' }), 8000);
  });
  return probed;
}

/**
 * Convert a file the browser already put on disk, and tag it.
 *
 * Gates and lucida hand back a real file in whatever format the source had.
 * One conversion implementation, and it is ffmpeg's — this used to be done in
 * the extension with lamejs and a hand-written ID3 writer.
 */
export async function convertNative(job) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = chrome.runtime.connectNative(HOST);
    } catch (e) {
      return reject(new Error(`the converter is not installed (${e?.message ?? e})`));
    }
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      try { port.disconnect(); } catch { /* already gone */ }
      fn(arg);
    };
    port.onMessage.addListener((msg) => {
      if (msg?.type === 'done') finish(resolve, { path: msg.path, name: msg.name, bytes: msg.bytes });
      // Not an error: the file was fine, just worse than what is on offer.
      else if (msg?.type === 'worse') finish(resolve, { worse: true, kbps: msg.kbps });
      else if (msg?.type === 'error') finish(reject, new Error(msg.reason ?? 'conversion failed'));
    });
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      finish(reject, new Error(err?.message ?? 'the converter stopped unexpectedly'));
    });
    port.postMessage({ type: 'convert', ...job });
  });
}

/** Clear staging files a cancelled row left behind. Never throws. */
export async function discardNative(id) {
  return new Promise((resolve) => {
    let port;
    try { port = chrome.runtime.connectNative(HOST); } catch { return resolve(false); }
    const done = (v) => { try { port.disconnect(); } catch { /* gone */ } resolve(v); };
    port.onMessage.addListener(() => done(true));
    port.onDisconnect.addListener(() => { chrome.runtime.lastError; resolve(false); });
    port.postMessage({ type: 'discard', id });
    setTimeout(() => done(false), 4000);
  });
}

export function forgetBridge() {
  probed = null;
}

/**
 * Hand a URL to yt-dlp and wait for the file.
 *
 * A long-lived port rather than a single message, because a download reports
 * progress and can outlast any request timeout.
 */
// Live downloads, so one can be stopped. Keyed by row id.
const live = new Map();

/** Stop a download in flight. The host exits when its stdin closes. */
export function cancelNative(id) {
  const port = live.get(id);
  if (!port) return false;
  try { port.disconnect(); } catch { /* already gone */ }
  live.delete(id);
  return true;
}

export function downloadNative({ id, url, format, media, folder, headers }, onProgress) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = chrome.runtime.connectNative(HOST);
    } catch (e) {
      return reject(new Error(`the downloader is not installed (${e?.message ?? e})`));
    }

    if (id != null) live.set(id, port);

    let finished = false;
    const finish = (fn, arg) => {
      if (finished) return;
      finished = true;
      if (id != null) live.delete(id);
      try { port.disconnect(); } catch { /* already gone */ }
      fn(arg);
    };

    port.onMessage.addListener((msg) => {
      if (msg?.type === 'progress') onProgress?.(msg.text);
      else if (msg?.type === 'done') {
        finish(resolve, { path: msg.path, name: msg.name, source: msg.source, bytes: msg.bytes });
      }
      else if (msg?.type === 'error') finish(reject, new Error(msg.reason ?? 'download failed'));
    });

    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      finish(reject, new Error(err?.message ?? 'the downloader stopped unexpectedly'));
    });

    port.postMessage({ type: 'download', url, format, media, folder, headers });
  });
}
