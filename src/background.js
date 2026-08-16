// Service worker: opens the panel, runs gate attempts in throwaway tabs, and
// proxies lucida requests through a real page. Network and file work lives in
// the panel.

import { loadTracks } from './lib/api.js';
import { scheduleUpdateChecks } from './lib/update.js';
import { classify, classifyYouTube } from './lib/paths.js';

const PANEL = 'src/panel/panel.html';

// Loaded unpacked from a git checkout, so it updates itself — see update.js.
scheduleUpdateChecks();

// --------------------------------------------------------------- toolbar
//
// An extension cannot pin itself to the toolbar; that is the user's decision
// and Chrome guards it. What it can do is stop looking inert on the pages where
// it has something to offer.
//
// So the icon carries a badge on a SoundCloud page it can act on, and nothing
// anywhere else. Once pinned, that is the difference between a permanently
// identical icon and one that tells you it noticed where you are.
const BADGE = { crate: '\u2022', track: '\u2022' };

async function markTab(tabId, url) {
  const kind = url ? (classify(url) ?? classifyYouTube(url)) : null;
  try {
    await chrome.action.setBadgeText({ tabId, text: kind ? BADGE[kind] ?? '' : '' });
    if (kind) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#7a1e4b' });
      await chrome.action.setTitle({
        tabId,
        title: kind === 'crate' ? 'Crate Goblin: download this playlist'
                                : 'Crate Goblin: download this track',
      });
    } else {
      await chrome.action.setTitle({ tabId, title: 'Crate Goblin' });
    }
  } catch {
    // Tab closed mid-update. Nothing to do and nothing worth reporting.
  }
}

// ------------------------------------------------------------------ prefetch

// Resolving a crate is several round trips — a resolve, then batched hydration
// for every id-only stub, which on a 295-track playlist is six more calls. Done
// when the panel opens, all of that latency is visible. Done when you land on
// the page, the panel opens on data that's already there.
const CRATE_PATH = /^https:\/\/soundcloud\.com\/[^/]+(\/(sets\/[^/]+|tracks|albums)?\/?)?(\?.*)?$/;
const CACHE_TTL = 5 * 60 * 1000;
const PREFETCH_DELAY = 1200;

let prefetchTimer = null;

const cacheKey = (url) => `crate:${url.split('?')[0]}`;

/**
 * Cache in session storage rather than a module variable: MV3 workers are
 * evicted whenever they go idle, which is most of the time, and a prefetch that
 * dies with the worker is no prefetch at all.
 */
async function prefetch(url) {
  const key = cacheKey(url);
  const { [key]: hit } = await chrome.storage.session.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return;

  try {
    const result = await loadTracks(url);
    await chrome.storage.session.set({ [key]: { at: Date.now(), result } });
  } catch {
    // Prefetch is an optimisation; a failure here must stay invisible. The
    // panel will try again itself and report properly if it also fails.
  }
}

// Debounced, so scrolling past a profile on the way somewhere else doesn't
// spend a hydration pass on it.
function schedulePrefetch(url) {
  if (!CRATE_PATH.test(url)) return;
  clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(() => prefetch(url), PREFETCH_DELAY);
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  // The badge follows every navigation, not just completed ones in the active
  // tab: a SPA route change on soundcloud.com never reports `complete` again.
  if (info.status || info.url) markTab(tabId, tab.url);
  if (tab.active && info.status === 'complete' && tab.url) schedulePrefetch(tab.url);
});
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  markTab(tabId, tab?.url);
  if (tab?.url) schedulePrefetch(tab.url);
});

// Gates are frequently short-code links (hypeddit.com/kavg3u) that redirect to
// the real page. Budgets are tight on purpose: four of these run concurrently,
// so a generous timeout multiplies into minutes of a crate sitting still.
const GATE_LOAD_TIMEOUT = 9_000;
const REDIRECT_SETTLE = 700;

// The side panel rather than a popup or a new tab.
//
// A toolbar popup would close the moment you click back onto the page, and
// downloads run *in the panel* — MV3 service workers have no
// URL.createObjectURL — so a batch would die halfway through. An injected
// in-page overlay avoids that but inherits soundcloud.com's CSP, which can
// block fetches to the media CDNs the downloader depends on.
//
// The side panel is a real extension page: its own origin, its own CSP, blob
// URLs and fetch behave exactly as they do in a tab. It also docks beside the
// page, so you keep browsing the crate while it works.
const panelPath = (pageUrl) => `${PANEL}?url=${encodeURIComponent(pageUrl)}`;

// open() has to happen inside the user-gesture window that the content script's
// click opened, and that window is short. The previous version awaited
// setOptions first, spending the gesture on configuration before ever calling
// open — so the click did nothing at all.
//
// Nothing needs configuring any more: the panel asks which page is in front
// rather than being told through its path. So this is one call, immediately.
const openSidePanel = (tab) => chrome.sidePanel.open({ tabId: tab.id });

// Toolbar icon opens the panel too, so it works from anywhere on the site.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

// Gate services run white-label custom domains — music.boostdj.co serves
// byte-identical Hypeddit pages, fanlink.tv serves ToneDen. The manifest's
// fixed match list silently skips those: no content script, so the gate looks
// like it failed when the automation never ran at all.
//
// So rather than trusting the static registration, check whether the script is
// actually live in the tab and inject it if not. Injection is scoped to tabs we
// opened for a gate, which is why the extension asks for origins at batch time
// instead of claiming <all_urls> in the manifest.
async function ensureInjected(tabId, { force = false } = {}) {
  try {
    if (force) throw new Error('reinject');
    const alive = await chrome.tabs.sendMessage(tabId, { type: 'gate:ping' });
    if (alive?.ok) return;
  } catch {
    // No listener on the other end — the static match list didn't cover this
    // host. Expected on white-label domains; inject below.
  }

  // MAIN world first: suppress.js has to replace window.open before the page's
  // own handlers run, or the first click still spawns a popup.
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['src/gate/suppress.js'],
    world: 'MAIN',
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['src/gate/unlock.js'],
  });
}

// Resolve once the tab finishes loading, or bail if it never does. Gate pages
// that hang on a third-party script would otherwise leave the tab open forever.
// Wait for the tab to settle, following redirects.
//
// The naive version resolved on the first `status === 'complete'`, which on a
// short-code gate is the *redirect* page — so the content script got injected
// into a document about to be replaced, found no controls, and burned the whole
// timeout before failing. Instead, treat each complete as provisional: wait a
// beat, and if the URL moved again, keep waiting.
//
// Resolves rather than rejects on timeout: a page still pulling third-party
// scripts is often perfectly usable, and the unlock attempt is a better judge
// of that than the load event is.
function waitForSettle(tabId) {
  return new Promise((resolve) => {
    const deadline = Date.now() + GATE_LOAD_TIMEOUT;
    let settleTimer = null;

    const finish = () => {
      clearTimeout(settleTimer);
      clearTimeout(hardStop);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };

    const hardStop = setTimeout(finish, GATE_LOAD_TIMEOUT);

    function listener(id, info) {
      if (id !== tabId) return;
      // A fresh navigation cancels the pending settle — we're mid-redirect.
      if (info.status === 'loading') { clearTimeout(settleTimer); return; }
      if (info.status !== 'complete') return;

      clearTimeout(settleTimer);
      const remaining = deadline - Date.now();
      settleTimer = setTimeout(finish, Math.max(0, Math.min(REDIRECT_SETTLE, remaining)));
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Open the gate out of the way, let unlock.js work it, then clean up.
//
// Returns { ok, fileUrl } for a link we can fetch ourselves, { ok, viaBrowser }
// when the gate drove the download itself, or { ok: false, reason }.
//
// That middle case matters: plenty of gates respond to the download button by
// starting a browser download rather than revealing a link. unlock.js sees no
// link and reports failure, so without watching chrome.downloads we'd fall back
// to a stream while the real file sat in Downloads under the gate's own name.
// How long to keep watching chrome.downloads after the gate attempt resolves.
//
// Gates routinely start the download a beat after the click that triggered it —
// a redirect, a token exchange, a slow CDN. We used to drop both listeners the
// moment attemptGate returned, so those late downloads landed unwatched and
// unnamed, which is where the occasional file called
// `07cb16c1-f8ae-4c19-….mp3` came from: no listener left to name it, so Chrome
// fell back to the CDN's URL basename.
const LATE_DOWNLOAD_GRACE_MS = 4000;

// Upper bound on how long a stored gate record stays eligible to name a
// download. Covers the unlock timeout plus a slow CDN, and no longer — a record
// that outlived its attempt would rename whatever you downloaded next.
const GATE_WATCH_TTL_MS = 30_000;

// One listener pair for the whole worker, with the per-attempt state in here.
//
// These were added and removed around each attempt, which broke as soon as the
// grace window above meant a pair outlived its call: a crate of gated tracks
// had dozens registered at once and chrome.downloads.onDeterminingFilename
// caps how many it accepts, so the batch died with "Too many listeners".
// Registering once and keeping the *state* in a list costs nothing and has no
// ceiling.
const pendingGates = [];

// ...mirrored into session storage, because module state here is not durable.
//
// This is a service worker: Chrome evicts it after ~30s without an event, and a
// gate attempt spends most of its life awaiting page settles and sleeps, which
// don't hold it open. The worker dies mid-attempt, the module re-evaluates with
// an empty list, and the download that finally arrives finds no gate to belong
// to — so it goes unnamed and un-intercepted and lands as a bare CDN uuid.
// That's the random filename, and it's why the earlier in-memory fix only
// helped intermittently: it worked exactly when the worker happened to survive.
//
// Session storage is the right lifetime — it outlives the worker and is cleared
// when the browser closes, which is also when any pending gate stops mattering.
const WATCH_KEY = 'gateWatch';

async function readWatches() {
  try {
    const { [WATCH_KEY]: list = [] } = await chrome.storage.session.get(WATCH_KEY);
    return list;
  } catch {
    return [];
  }
}

async function writeWatches(list) {
  try {
    await chrome.storage.session.set({ [WATCH_KEY]: list });
  } catch {
    // session storage unavailable — the in-memory list still covers the common
    // case where the worker survives the attempt.
  }
}

/**
 * Which attempt owns a download that just started.
 *
 * Newest first: DownloadItem carries no tab id, so with several gates in flight
 * there's nothing to match on but recency — and the most recently opened gate
 * is overwhelmingly the likeliest owner of a download starting right now.
 */
async function currentGate() {
  const now = Date.now();
  for (let i = pendingGates.length - 1; i >= 0; i--) {
    if (pendingGates[i].expires > now) return pendingGates[i];
  }
  // Nothing in memory — either there genuinely is no gate open, or this worker
  // is a fresh instance that has lost the one there is.
  const stored = await readWatches();
  for (let i = stored.length - 1; i >= 0; i--) {
    if (stored[i].expires > now) return stored[i];
  }
  return null;
}

// Ignore our own blob saves from the panel — only page-driven downloads count.
chrome.downloads.onCreated.addListener(async (item) => {
  if (item.url?.startsWith('blob:')) return;
  const gate = await currentGate();
  if (!gate) return;
  // Only meaningful on the in-memory record; a revived worker reads the URL back
  // off the download itself.
  gate.captured = item;

  // Take the download away from the browser and hand the URL back so the bytes
  // go through the same pipeline as everything else — converted to the
  // requested format, tagged, artwork embedded, and with a real byte count to
  // report. Left to the browser these landed raw: the gated tracks were the
  // only files in a crate with no tags and no cover, in whatever format the
  // artist happened to upload.
  //
  // The trade: if the URL turns out to be single-use and our refetch 403s, we
  // have already cancelled the browser's copy. That degrades to the stream
  // fallback — a worse file, but never a missing one.
  //
  if (/^https?:/i.test(item.url ?? '')) {
    // Promises, not callbacks, and the outcome of the cancel is the answer.
    //
    // A small file from a fast CDN can finish between onCreated firing and this
    // running — this handler awaits currentGate() first, which is enough time.
    // Cancelling a finished download is an error, not a no-op, and the callback
    // form reports it through runtime.lastError, which surfaces as an unchecked
    // warning in the console however diligently it's read.
    //
    // Testing item.state first doesn't help: `item` is a snapshot taken when
    // the event fired, so it still says in_progress long after the download has
    // landed. The only trustworthy signal is what cancel itself does.
    //
    //   resolves  we stopped it in time — erase the record and refetch the URL
    //   rejects   it already finished, so the bytes are on disk; refetching
    //             would leave two copies with Chrome uniquifying the second
    // Ask what state it's in *now*. `item` is a snapshot from when the event
    // fired and still says in_progress long after the download has landed, so
    // it can't answer this. A small file from a fast CDN routinely finishes
    // while this handler is still awaiting currentGate().
    const [live] = await chrome.downloads.search({ id: item.id }).catch(() => []);
    if (live && live.state !== 'in_progress') {
      gate.alreadyOnDisk = true;
      return;
    }

    chrome.downloads.cancel(item.id).then(
      () => chrome.downloads.erase({ id: item.id }).catch(() => {}),
      // Still possible: it can finish between the search above and this call.
      // The promise form reports that as a rejection rather than through
      // runtime.lastError, so there is nothing left to go unchecked.
      () => { gate.alreadyOnDisk = true; },
    );
  }
});

// What we asked each of our own blob saves to be called, keyed by its URL.
//
// The `filename` option on downloads.download() is documented as a *suggestion*
// — this listener outranks it. Registering the name here and answering from it
// is the only way to be sure, and it's cheap: a save is registered microseconds
// before its download is created.
const pendingSaves = new Map();
// Bounded so a download that never materialises can't pin an entry forever.
const SAVE_NAME_TTL_MS = 60_000;

function rememberSave(url, filename) {
  pendingSaves.set(url, { filename, at: Date.now() });
  for (const [k, v] of pendingSaves) {
    if (Date.now() - v.at > SAVE_NAME_TTL_MS) pendingSaves.delete(k);
  }
}

function forgetSave(url) {
  pendingSaves.delete(url);
}

// Name it properly on the way in; there's no renaming a download after the fact.
//
// Looking a gate up means a round trip to session storage, so this may have to
// answer asynchronously — which the API allows, on the condition that a listener
// returning true calls suggest() exactly once, on every path. Miss one and the
// download hangs unnamed forever.
chrome.downloads.onDeterminingFilename?.addListener((item, suggest) => {
  // `url` is not always populated this early, so check both.
  const url = item.url || item.finalUrl || '';

  // One of ours. Answer synchronously from what we registered, so the name can
  // never depend on the download() option being honoured.
  const mine = pendingSaves.get(url) ?? (url.startsWith('blob:') ? null : undefined);
  if (mine) {
    forgetSave(url);
    suggest({ filename: mine.filename, conflictAction: 'uniquify' });
    return true;
  }
  // A blob save we somehow have no record of — still ours, so leave Chrome's
  // own determination alone rather than overriding it with a default.
  if (mine === null) return false;

  currentGate()
    .then((gate) => {
      const ext = item.filename?.match(/\.(\w+)$/)?.[1] ?? 'mp3';
      if (gate?.name) suggest({ filename: `${gate.name}.${ext}`, conflictAction: 'uniquify' });
      else keep();
    })
    .catch(keep);

  // Bare suggest() does NOT mean "leave it alone" — it means "use Chrome's
  // default", which throws away the filename passed to downloads.download().
  // This listener sees every download in the extension, so that turned each
  // save it touched into the blob URL's uuid. Echo the suggestion back instead.
  function keep() {
    if (item.filename) suggest({ filename: item.filename });
    else suggest();
  }

  return true;
});

async function attemptGate(url, suggestedName) {
  let tab;
  // A finite horizon rather than Infinity: this record has to be written to
  // storage, and a stranded one there would rename every unrelated download
  // until the browser closed.
  const watch = { name: suggestedName, captured: null, expires: Date.now() + GATE_WATCH_TTL_MS };
  pendingGates.push(watch);
  await writeWatches([
    ...(await readWatches()).filter((w) => w.expires > Date.now()),
    { name: suggestedName, expires: watch.expires },
  ]);

  try {
    tab = await chrome.tabs.create({ url, active: false });
    await waitForSettle(tab.id);

    // A gate that redirects straight to a file never runs our content script.
    const current = await chrome.tabs.get(tab.id);
    if (/\.(mp3|wav|aiff?|flac|m4a|zip)(\?|$)/i.test(current.url ?? '')) {
      return { ok: true, fileUrl: current.url };
    }

    await ensureInjected(tab.id);

    let res = await chrome.tabs.sendMessage(tab.id, { type: 'gate:unlock' });

    // One retry against the settled document. If a late redirect swapped the
    // page out from under the first attempt, the script we talked to belonged
    // to a document that no longer exists — re-injecting gets us the real one.
    if (!res?.ok && /no download control/.test(res?.reason ?? '')) {
      await ensureInjected(tab.id, { force: true });
      res = await chrome.tabs.sendMessage(tab.id, { type: 'gate:unlock' });
    }
    if (res?.ok) return res;

    // unlock.js found no link — but the click may still have started a
    // download, possibly one that hasn't been created yet. Give it a moment
    // rather than declaring failure while the file is on its way.
    if (!watch.captured) await waitForCapture(() => watch.captured, LATE_DOWNLOAD_GRACE_MS);
    if (watch.captured) return fromCapture(watch.captured, watch.alreadyOnDisk);
    return res ?? { ok: false, reason: 'gate did not respond' };
  } catch (e) {
    if (watch.captured) return fromCapture(watch.captured, watch.alreadyOnDisk);
    return { ok: false, reason: e.message };
  } finally {
    // The entry outlives the call by the grace window so a download that starts
    // after we return is still named and intercepted, then drops out. Both
    // copies are shortened together — leaving the stored one at its full TTL
    // would let a finished gate keep claiming later downloads.
    const until = Date.now() + LATE_DOWNLOAD_GRACE_MS;
    watch.expires = until;
    readWatches()
      .then((list) => writeWatches(
        list.map((w) => (w.name === watch.name ? { ...w, expires: until } : w))
            .filter((w) => w.expires > Date.now()),
      ))
      .catch(() => {});

    setTimeout(() => {
      const i = pendingGates.indexOf(watch);
      if (i !== -1) pendingGates.splice(i, 1);
      readWatches()
        .then((list) => writeWatches(list.filter((w) => w.expires > Date.now())))
        .catch(() => {});
    }, LATE_DOWNLOAD_GRACE_MS);
    if (tab?.id) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

/** An intercepted download becomes a normal fetchable URL wherever possible. */
function fromCapture(item, alreadyOnDisk = false) {
  // Finished before we could take it — refetching would duplicate it.
  if (alreadyOnDisk) return { ok: true, viaBrowser: true, filename: item.filename };
  if (/^https?:/i.test(item.url ?? '')) return { ok: true, fileUrl: item.url };
  // blob:/data: from the page itself — we cancelled nothing and can't refetch
  // it from here, so the browser's own copy is the file.
  return { ok: true, viaBrowser: true, filename: item.filename };
}

/** Poll for a late-arriving download until it shows up or the window closes. */
function waitForCapture(get, ms) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (get() || Date.now() - started >= ms) return resolve();
      setTimeout(tick, 150);
    };
    tick();
  });
}

// ------------------------------------------------------- lucida page proxy
//
// Requests to lucida.to have to originate from a lucida.to page, not from the
// extension. Cloudflare weighs `Origin: chrome-extension://…`, `Sec-Fetch-Site:
// cross-site` and an XHR-shaped Accept alongside the cf_clearance cookie, and
// challenges a cross-site request for an HTML page even when that cookie is
// perfectly valid. Those headers are all on fetch's forbidden list, so there is
// no way to make the extension's own request look like a visit. Measured: the
// identical fetch is 403 from the extension and 200 from the page's console.
//
// It can't be an iframe either — lucida.to sends `X-Frame-Options: SAMEORIGIN`,
// so an offscreen document can't host it. That leaves a real tab, opened on
// demand and closed again, which is what the gate automation already does.
//
// Only the challenged HTML/JSON steps go through here. The audio itself is
// fetched by the caller, because handing megabytes back through runtime
// messaging means base64 — messaging is JSON, so an ArrayBuffer doesn't survive
// the trip — and that is a 33% size penalty on every track to solve a problem
// the caller doesn't have.
const LUCIDA_URL = 'https://lucida.to/';
// Closed once a batch has stopped using it. Long enough to span the gaps
// between tracks in a queue, short enough not to sit in the tab strip.
const LUCIDA_IDLE_MS = 45_000;

let lucidaTab = null;      // { id, ours } — `ours` gates whether we may close it
let lucidaOpening = null;  // in-flight open, so four concurrent rows share one
let lucidaIdle = null;

async function ensureLucidaTab() {
  // Reuse a tab the user already has open, and never close that one.
  if (lucidaTab) {
    const alive = await chrome.tabs.get(lucidaTab.id).catch(() => null);
    if (alive) return lucidaTab;
    lucidaTab = null;
  }

  const existing = await chrome.tabs.query({ url: 'https://lucida.to/*' }).catch(() => []);
  if (existing.length) {
    lucidaTab = { id: existing[0].id, ours: false };
    return lucidaTab;
  }

  lucidaOpening ??= (async () => {
    const tab = await chrome.tabs.create({ url: LUCIDA_URL, active: false });
    await waitForSettle(tab.id);
    lucidaTab = { id: tab.id, ours: true };
    return lucidaTab;
  })().finally(() => { lucidaOpening = null; });

  return lucidaOpening;
}

function touchLucidaTab() {
  clearTimeout(lucidaIdle);
  lucidaIdle = setTimeout(() => {
    if (lucidaTab?.ours) chrome.tabs.remove(lucidaTab.id).catch(() => {});
    lucidaTab = null;
  }, LUCIDA_IDLE_MS);
}

/** Run one fetch inside the lucida.to page and hand back status + body text. */
async function lucidaPageFetch(url, init) {
  const tab = await ensureLucidaTab();
  touchLucidaTab();

  const [out] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    // Isolated world is enough: a content script's fetch carries the page's
    // origin and cookies, which is the whole point. Staying out of MAIN avoids
    // touching anything the page itself defines.
    func: async (u, i) => {
      try {
        const r = await fetch(u, { ...(i ?? {}), credentials: 'include' });
        // The final URL matters as much as the body: lucida signals a failed
        // cross-service match by redirecting to `?failed-to=<service>` rather
        // than by status code, so without this the caller can't tell a miss
        // from a parse problem.
        return { ok: true, status: r.status, url: r.url, body: await r.text() };
      } catch (e) {
        return { ok: false, reason: e?.message ?? String(e) };
      }
    },
    args: [url, init ?? null],
  });

  if (!out?.result) throw new Error('lucida page did not respond');
  if (!out.result.ok) throw new Error(out.result.reason);
  return out.result;
}

// Only one offscreen document may exist at a time, and creating it races with
// itself if two clicks land together — hold the in-flight promise so the second
// caller waits on the first rather than throwing.
let offscreenReady = null;

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) return;

  offscreenReady ??= chrome.offscreen
    .createDocument({
      url: 'src/offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Assemble downloaded audio into a Blob for chrome.downloads.',
    })
    .finally(() => { offscreenReady = null; });

  await offscreenReady;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // ---- host proxy for the offscreen document ----------------------------
  //
  // Offscreen documents support only chrome.runtime, so storage, cookies and
  // downloads all have to come through here. Without this the pipeline died on
  // its first call with "Cannot read properties of undefined (reading 'local')".

  if (msg.type === 'host:get') {
    chrome.storage.local.get(msg.key).then((r) => sendResponse({ value: r[msg.key] }));
    return true;
  }

  if (msg.type === 'host:set') {
    chrome.storage.local.set({ [msg.key]: msg.value }).then(() => sendResponse({ ok: true }));
    return true;
  }

  // The panel asks so it can say which tier the quality is coming from.
  if (msg.type === 'session:get') {
    import('./lib/session.js')
      .then((m) => m.currentSession())
      .then(sendResponse, () => sendResponse({ signedIn: false, goPlus: false, plan: null }));
    return true;
  }

  if (msg.type === 'host:oauth') {
    chrome.cookies
      .get({ url: 'https://soundcloud.com', name: 'oauth_token' })
      .then((c) => sendResponse({ token: c?.value ?? null }))
      .catch(() => sendResponse({ token: null }));
    return true;
  }

  // Queue traffic needs the offscreen document alive before it can arrive.
  if (msg.type === 'queue:run' || msg.type === 'queue:state' || msg.type === 'queue:forget') {
    (async () => {
      try {
        await ensureOffscreen();
        sendResponse(await chrome.runtime.sendMessage(msg));
      } catch (e) {
        sendResponse({ ok: false, reason: e?.message ?? String(e) });
      }
    })();
    return true;
  }

  if (msg.type === 'lucida:fetch') {
    lucidaPageFetch(msg.url, msg.init).then(
      (r) => sendResponse({ ok: true, ...r }),
      (e) => sendResponse({ ok: false, reason: e?.message ?? String(e) }),
    );
    return true;
  }

  if (msg.type === 'host:save') {
    // The blob stays in the context that made it; only its URL crosses, which
    // works because every extension context shares one origin.
    //
    // The name is registered here *as well as* being passed to download(),
    // because the `filename` option is only a suggestion — onDeterminingFilename
    // gets the last word, and going through it is the only way to be certain.
    // Files were landing as the blob URL's own uuid (`adac74d0-….mp3`) despite
    // the pipeline computing the right name, which is what that option being
    // overridden looks like from the outside.
    if (msg.filename) rememberSave(msg.url, msg.filename);

    chrome.downloads.download({ url: msg.url, filename: msg.filename, saveAs: false }, (id) => {
      const err = chrome.runtime.lastError;
      if (err) {
        forgetSave(msg.url);
        console.warn('[crate] download rejected', { filename: msg.filename, reason: err.message });
        return sendResponse({ ok: false, reason: err.message });
      }
      // What Chrome actually called it, which is not always what we asked for.
      // If these ever diverge again this says so outright instead of leaving it
      // to be inferred from the Downloads folder.
      chrome.downloads.search({ id }, ([item] = []) => {
        if (chrome.runtime.lastError) return;   // nothing to compare against
        const got = item?.filename?.split(/[/\\]/).pop();
        if (got && msg.filename && got !== msg.filename) {
          console.warn('[crate] filename overridden by Chrome', { asked: msg.filename, got });
        }
      });
      sendResponse({ ok: true, id });
    });
    return true;
  }

  // One-click download straight from a track page. Deliberately does not open
  // the panel — that's the entire point of the button.
  if (msg.type === 'quick-download') {
    (async () => {
      try {
        await ensureOffscreen();
        const res = await chrome.runtime.sendMessage({ type: 'offscreen:download', url: msg.url });
        sendResponse(res ?? { ok: false, reason: 'no response from the worker' });
      } catch (e) {
        sendResponse({ ok: false, reason: e?.message ?? String(e) });
      }
    })();
    return true;
  }

  if (msg.type === 'open-panel') {
    if (!sender.tab) return false;
    openSidePanel(sender.tab)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => {
        // Never swallow this. The earlier `.catch(() => {})` turned every
        // failure into a button that silently did nothing, which is the worst
        // possible outcome — no panel, no error, nothing to debug.
        //
        // Side panel support varies by Chrome version and gesture propagation
        // is fiddly, so fall back to the full tab: the button always does
        // something, and the reason comes back to the page.
        chrome.tabs.create({ url: chrome.runtime.getURL(panelPath(sender.tab.url)) });
        sendResponse({ ok: false, reason: e?.message ?? String(e) });
      });
    return true; // async response
  }

  // The panel asks which page it's looking at rather than trusting a query
  // param. It can be opened from the toolbar, be already docked, or survive a
  // navigation — in all of those the ?url= never gets set, and the panel came
  // up reporting "No URL" while sitting right next to the playlist.
  if (msg.type === 'get-page-url') {
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(([tab]) => sendResponse({ url: tab?.url ?? null }));
    return true;
  }

  // Escape hatch to the wide view: the side panel is narrow, and a 295-track
  // crate is easier to work in a full tab.
  if (msg.type === 'open-tab') {
    chrome.tabs.create({ url: chrome.runtime.getURL(panelPath(msg.url)) });
    return false;
  }

  if (msg.type === 'gate:attempt') {
    attemptGate(msg.url, msg.filename).then(sendResponse);
    return true;
  }

  return false;
});
