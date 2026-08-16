// Injects controls into SoundCloud and YouTube.
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
import { isTrackPath, isCratePath, crateKind, classifyYouTube } from './lib/paths.js';

const CRATE_BTN = 'sc-crate-btn';
const TRACK_BTN = 'sc-crate-get';

const BTN_STYLE = [
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
  btn.textContent = label;
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
  btn.dataset.label ??= btn.textContent;
  btn.textContent = text;
  btn.style.opacity = '.75';
  clearTimeout(btn._t);
  btn._t = setTimeout(() => {
    btn.textContent = btn.dataset.label;
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

// YouTube's own controls, mounted in its action row.
//
// Kept separate from the SoundCloud path rather than generalised: the two sites
// share no markup, and a single "find the action bar" helper that satisfied
// both would be a selector nobody could reason about. The button label is the
// only thing they have in common.
const YT_BAR = [
  '#top-level-buttons-computed',        // watch page action row
  'ytd-playlist-header-renderer #top-level-buttons-computed',
];

function mountYouTubeButton() {
  const kind = classifyYouTube(location.href);
  const existing = document.getElementById(CRATE_BTN);

  if (!kind) return void existing?.remove();

  const label = kind === 'crate' ? 'Download playlist' : 'Get';
  if (existing?.isConnected) {
    if (existing.textContent !== label) existing.textContent = label;
    return;
  }

  const bar = YT_BAR.map((sel) => document.querySelector(sel)).find(Boolean);
  if (!bar) return;

  const btn = makeButton(CRATE_BTN, label, (e) =>
    kind === 'crate' ? openPanel(e.currentTarget) : quickDownload(e.currentTarget, location.href));
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
    if (existing.textContent !== label) existing.textContent = label;
    return;
  }

  // The hero bar is the one with no track of its own.
  const bar = [...document.querySelectorAll('.listenEngagement__actions, .soundActions')]
    .find((b) => !trackUrlFor(b));
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
    if (location.hostname.endsWith('youtube.com')) {
      mountYouTubeButton();
    } else {
      mountTrackButtons();
      mountCrateButton();
    }
  });
}

new MutationObserver(scheduleMount).observe(document.body, { childList: true, subtree: true });
scheduleMount();
