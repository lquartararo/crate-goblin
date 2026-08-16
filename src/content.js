// Injects controls into SoundCloud.
//
//   Every track card, anywhere  →  "Get", downloads that one track, no panel
//   Crate pages (playlist/album/profile)  →  "Download playlist" / "Download tracks"
//
// The earlier version only mounted on a dedicated track page, which missed
// where the listening actually happens: the feed, search results, a profile's
// track list, the tracks inside a playlist. Those are all track cards with
// their own action bar, so the button belongs on each of them.
//
// SoundCloud is a SPA that recycles DOM aggressively, so everything here has to
// survive re-render and must never double-mount.

// A plain static import: the bundler inlines it, so nothing module-shaped
// survives to runtime.
//
// This was a dynamic import() before the build step existed, because a
// manifest-declared content script is a classic script and a top-level `import`
// would be a syntax error. With a bundler that reverses — Rollup resolves
// dynamic imports using `import.meta.url`, which is *itself* module-only syntax,
// so the emitted file failed to parse and none of the buttons appeared.
import { isTrackPath, isCratePath, crateKind, nativeTarget } from './lib/paths.js';
import { markDataUrl } from './lib/goblin.js';

const CRATE_BTN = 'sc-crate-btn';
const TRACK_BTN = 'sc-crate-get';
// The text lives in its own element. Status updates used to assign
// btn.textContent, which replaces every child — with a mark in there that would
// delete it on the first "Getting…" and never bring it back.
const LABEL = 'sc-crate-label';

// Drawn once for the page, however many buttons end up on it.
let MARK = null;
const markUrl = () => (MARK ??= markDataUrl('#f6edf0'));

const BTN_STYLE = [
  'display:inline-flex',
  'align-items:center',
  'gap:7px',
  'padding:6px 13px',
  'font:500 12px/1 inherit',
  'letter-spacing:.04em',
  'color:#f6edf0',
  'background:#7a1e4b',
  'border:0',
  'border-radius:99px',
  'cursor:pointer',
  'white-space:nowrap',
  'transition:opacity 150ms ease',
].join(';');

function makeButton(id, label, onClick) {
  const btn = document.createElement('button');
  btn.id = id;
  btn.className = id;
  btn.type = 'button';
  btn.style.cssText = BTN_STYLE;

  // Identity without a per-instance cost: one shared image, no listeners, no
  // paint loop. The panel's goblin watches the cursor because there is exactly
  // one of it on a surface you opened; fifty of them on a playlist page would
  // be fifty pointermove handlers competing with the site you are listening to.
  const mark = document.createElement('span');
  mark.style.cssText = [
    'width:16px', 'height:16px', 'flex:none',
    `background:url(${markUrl()}) center/contain no-repeat`,
    'image-rendering:pixelated',
  ].join(';');

  const text = document.createElement('span');
  text.className = LABEL;
  text.textContent = label;

  btn.append(mark, text);
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();   // cards are clickable; don't navigate on our click
    onClick(e);
  });
  return btn;
}

// Brief inline feedback. These buttons are the only surface these actions have,
// so failing silently would leave nothing at all to go on.
function flash(btn, text, revertAfter = 2600) {
  const el = btn.querySelector(`.${LABEL}`) ?? btn;
  el.dataset.label ??= el.textContent;
  el.textContent = text;
  btn.style.opacity = '.75';
  clearTimeout(btn._t);
  btn._t = setTimeout(() => {
    el.textContent = el.dataset.label;
    btn.style.opacity = '1';
  }, revertAfter);
}

// ------------------------------------------------------------- track cards

/**
 * Find the track this action bar belongs to.
 *
 * Rather than chase SoundCloud's class names — which differ between the feed,
 * search, playlist rows and profile — walk up a few levels and take the first
 * anchor whose href looks like a track permalink. Returning null is meaningful:
 * it's how a playlist's own hero action bar is told apart from a track's.
 */
function trackUrlFor(bar) {
  let node = bar;
  for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
    for (const a of node.querySelectorAll('a[href^="/"]')) {
      const path = a.getAttribute('href').split('?')[0];
      if (isTrackPath(path)) return new URL(path, location.origin).href;
    }
  }
  return null;
}

const mounted = new WeakSet();

function mountTrackButtons() {
  for (const bar of document.querySelectorAll('.soundActions, .listenEngagement__actions')) {
    if (mounted.has(bar) || bar.querySelector(`.${TRACK_BTN}`)) continue;

    const url = trackUrlFor(bar);
    if (!url) continue;   // playlist hero, not a track

    mounted.add(bar);
    const btn = makeButton(TRACK_BTN, 'Get', (e) => quickDownload(e.currentTarget, url));
    btn.style.marginLeft = '6px';
    bar.appendChild(btn);
  }
}

async function quickDownload(btn, url) {
  if (btn.disabled) return;
  btn.disabled = true;
  flash(btn, 'Getting…', 120_000);

  try {
    const res = await chrome.runtime.sendMessage({ type: 'quick-download', url });
    if (res?.ok) {
      flash(btn, res.bytes ? `Saved · ${(res.bytes / 1e6).toFixed(1)} MB` : 'Saved');
    } else {
      flash(btn, res?.reason ?? 'Failed', 5000);
      console.warn('[crate] download failed:', res?.reason);
    }
  } catch (err) {
    flash(btn, 'Reload the page', 4000);
    console.warn('[crate] could not reach the extension:', err);
  } finally {
    btn.disabled = false;
  }
}

// ------------------------------------------------------------ crate button

// YouTube, handed to the local downloader rather than fetched here.
const YT_BAR = ['#top-level-buttons-computed',
                'ytd-playlist-header-renderer #top-level-buttons-computed'];

function mountNativeButton() {
  const target = nativeTarget(location.href);
  const existing = document.getElementById(CRATE_BTN);
  if (!target) return void existing?.remove();
  if (existing?.isConnected) return;

  const bar = YT_BAR.map((sel) => document.querySelector(sel)).find(Boolean);
  if (!bar) return;

  const btn = makeButton(CRATE_BTN, 'Get', (e) => openPanel(e.currentTarget));
  btn.style.marginLeft = '8px';
  bar.appendChild(btn);
}

function mountCrateButton() {
  const onCrate = isCratePath(location.pathname);
  const existing = document.getElementById(CRATE_BTN);

  if (!onCrate) return void existing?.remove();

  // A profile's track list isn't a playlist, and calling it one on every artist
  // page reads as a bug. Albums do say "playlist" — see crateKind.
  const label = crateKind(location.pathname) === 'playlist'
    ? 'Download playlist'
    : 'Download tracks';

  // Retitle in place rather than returning early. This is an SPA: going from a
  // playlist to the artist's profile keeps the same button alive, and the guard
  // that used to sit here would have left it reading "Download playlist" on a
  // page that isn't one.
  if (existing?.isConnected) {
    const text = existing.querySelector(`.${LABEL}`);
    if (text && text.textContent !== label) text.textContent = label;
    return;
  }

  // The hero bar is the one with no track of its own.
  const bars = [...document.querySelectorAll('.listenEngagement__actions, .soundActions')];
  // SoundCloud's generated sets caption themselves "Based on <track>" with a
  // real track permalink sitting right beside the hero bar, so the walk up from
  // that bar finds a track and the page ends up with every bar looking like a
  // track's. Falling back to the first hero-class bar rather than giving up: it
  // is the big engagement bar under the artwork, and `.soundActions` — the
  // per-track one — is deliberately not in the fallback.
  const bar = bars.find((b) => !trackUrlFor(b))
    ?? document.querySelector('.listenEngagement__actions');
  if (!bar) return;

  const btn = makeButton(CRATE_BTN, label, (e) => openPanel(e.currentTarget));
  btn.style.marginLeft = '8px';
  bar.appendChild(btn);
}

async function openPanel(btn) {
  flash(btn, 'Opening…', 1200);
  try {
    const res = await chrome.runtime.sendMessage({ type: 'open-panel', url: location.href });
    if (res && res.ok === false) console.warn('[crate] side panel unavailable:', res.reason);
  } catch (err) {
    flash(btn, 'Reload the page', 4000);
    console.warn('[crate] could not reach the extension:', err);
  }
}

// ------------------------------------------------------------------ mount

// A feed re-renders constantly, so a full re-scan on every mutation would run
// hundreds of times a second. Coalesce into one pass per frame.
let pending = false;
function scheduleMount() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    if (location.hostname.endsWith('youtube.com')) mountNativeButton();
    else { mountTrackButtons(); mountCrateButton(); }
  });
}

new MutationObserver(scheduleMount).observe(document.body, { childList: true, subtree: true });
scheduleMount();
