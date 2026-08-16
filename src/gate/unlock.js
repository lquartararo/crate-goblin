// Runs in the extension's isolated world on gate pages.
//
// Shaped by inspecting live gates rather than guessing. Four hosts, three
// shapes:
//
//   Hypeddit        <a id="downloadProcess" class="hype-btn ... dp">, live from
//                   page load, no social steps rendered at all
//   PumpYourSound   <button type="submit">Download</button>, behind a Cookiebot
//                   overlay that intercepts clicks until dismissed
//   ToneDen         no download control, only an email capture form. Not
//                   automated: handing out an address to reach a stream we can
//                   already fetch is a bad trade, so these fall back instead
//   TheArtistUnion  404. Gate links rot; that has to fail fast, not hang
//
// None of them gated behind clickable follow/like/repost controls, so the old
// generic step-walking is gone. If some gate does need it, this reports failure
// and the track falls back to the stream, with the Buy link still on the row for
// anyone who wants the real file by hand.

const DOWNLOAD_SELECTORS = [
  '#downloadProcess',                    // Hypeddit
  'a.hype-btn.dp',                       // Hypeddit, if the id moves
  '[id*="download" i][class*="btn" i]',
];

const DOWNLOAD_TEXT = /\bfree\s*download\b|\bdownload\b|\bget\s+track\b/i;

// Consent overlays sit above everything and swallow the click. Declining is
// both the privacy-preserving choice and enough to clear the overlay — there's
// never a reason to accept tracking to reach a download.
const DECLINE_SELECTORS = [
  '#CybotCookiebotDialogBodyButtonDecline',      // Cookiebot (PumpYourSound)
  '[id*="decline" i]', '[class*="decline" i]',
  '[id*="reject" i]', '[class*="reject" i]',
];

// Droploud's decline control carries the wording only in its text — its id and
// class say nothing about rejecting. Selector matching alone walks straight
// past it and the overlay keeps eating clicks.
const DECLINE_TEXT = /^\s*(reject|decline|deny|refuse)\b|only.*(necessary|essential)/i;

// Guard against the opposite mistake: never let a text match land on "Accept
// all" or "Allow selection", which sit next to it in the same banner.
const ACCEPT_TEXT = /\b(accept|allow|agree|got it|ok)\b/i;

// Never click these whatever they say — legal pages, and any consent control
// that isn't an explicit decline.
const NEVER_CLICK = '[href*="/privacy"],[href*="/legal"],[href*="/dmca"],[href*="/terms"]';

const AUDIO_EXT = /\.(mp3|wav|aiff?|flac|m4a|zip)(\?|$)/i;
// Four gates run concurrently, so every second here is multiplied. A gate that
// hasn't shown a control in ten seconds is not about to.
const TIMEOUT_MS = 10_000;
const SETTLE_MS = 600;

// "complete" only means the document loaded, not that the gate has painted —
// several of these render their controls from JS afterwards. Bailing the moment
// the first pass comes up empty would write off a perfectly automatable gate
// before its button exists, and the failure looks identical to a real one.
// Give it a few passes (~2.8s) before concluding there's nothing here.
const EMPTY_PASSES_BEFORE_GIVING_UP = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const visible = (el) => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
};

const enabled = (el) =>
  !el.disabled &&
  el.getAttribute('aria-disabled') !== 'true' &&
  !/\b(disabled|inactive|locked)\b/.test(el.className || '');

const usable = (el) => el && visible(el) && enabled(el) && !el.closest(NEVER_CLICK);

// ------------------------------------------------------------------ finders

function findDownload() {
  for (const sel of DOWNLOAD_SELECTORS) {
    for (const el of document.querySelectorAll(sel)) if (usable(el)) return el;
  }
  // Fall back to labelled controls, but only genuinely interactive ones. A
  // broad `[class*="button"]` sweep also matches layout wrappers — on a real
  // Hypeddit page "hype-sidebar-buttons-wrapper" rendered the text "Download"
  // while being a container. Clicking it does nothing but looks like progress.
  for (const el of document.querySelectorAll('button, a, [role="button"], input[type="submit"]')) {
    if (usable(el) && DOWNLOAD_TEXT.test((el.innerText || el.value || '').trim())) return el;
  }
  return null;
}

function findFileLink() {
  for (const a of document.querySelectorAll('a[href]')) {
    if (AUDIO_EXT.test(a.getAttribute('href') || '')) return new URL(a.href, location.href).href;
    if (a.hasAttribute('download') && visible(a)) return new URL(a.href, location.href).href;
  }
  return null;
}

/**
 * Click something, without tripping the page's own CSP.
 *
 * An `<a href="javascript:…">` treats a click as a *navigation* to that URL,
 * and most gates ship a CSP with no 'unsafe-inline', so the browser blocks it
 * and logs a violation. The page's own handlers have already run by then — the
 * click still works — but the console fills with CSP errors that look like the
 * cause of a failed gate rather than noise beside it.
 *
 * Suppressing only the default action leaves those handlers alone. Restricted
 * to `javascript:` hrefs because a real href is often how a gate navigates to
 * the file, and cancelling that would break it.
 */
function press(el) {
  if (/^javascript:/i.test(el.getAttribute?.('href') ?? '')) {
    el.addEventListener('click', (e) => e.preventDefault(), { once: true });
  }
  el.click();
}

const dismissConsent = () => {
  for (const sel of DECLINE_SELECTORS) {
    for (const el of document.querySelectorAll(sel)) {
      if (visible(el) && enabled(el)) { press(el); return true; }
    }
  }

  // Fall back to the label, for banners that name the action only in text.
  for (const el of document.querySelectorAll('button, a, [role="button"]')) {
    const label = (el.innerText || el.value || '').trim();
    if (!label || !visible(el) || !enabled(el)) continue;
    if (DECLINE_TEXT.test(label) && !ACCEPT_TEXT.test(label)) { press(el); return true; }
  }
  return false;
};

// ------------------------------------------------------------------ attempt

async function attempt() {
  const did = [];

  if (dismissConsent()) { did.push('declined consent'); await sleep(SETTLE_MS); }

  const deadline = Date.now() + TIMEOUT_MS;
  let emptyPasses = 0;

  while (Date.now() < deadline) {
    const link = findFileLink();
    if (link) return { ok: true, fileUrl: link, did };

    const download = findDownload();
    if (download) {
      did.push('clicked download');
      press(download);
      await sleep(SETTLE_MS);
      // The click may reveal a link, navigate, or start a browser download.
      // background.js watches chrome.downloads for that last case.
      const after = findFileLink();
      if (after) return { ok: true, fileUrl: after, did };
      await sleep(SETTLE_MS);
      continue;
    }

    // Nothing to click. It may just not have rendered yet, so only give up once
    // the page has stayed empty across several passes.
    //
    // An email-capture gate lands here too, and that is deliberate. Automating
    // those meant handing out an address to reach audio the stream fallback
    // already gets, and the ones that do work are double opt-in anyway: the
    // file arrives by a link in an inbox nothing here can read. Falling back
    // costs a little quality and no personal data.
    if (++emptyPasses >= EMPTY_PASSES_BEFORE_GIVING_UP) {
      return { ok: false, reason: 'no download control found on this gate', did };
    }
    await sleep(SETTLE_MS);
  }

  return { ok: false, reason: 'timed out before a file appeared', did };
}

// Only act when the panel asks; a gate you opened by hand stays manual.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Lets background.js tell "script not present" apart from "script failed",
  // so it can inject on white-label domains the match list never covered.
  if (msg?.type === 'gate:ping') { sendResponse({ ok: true }); return false; }

  if (msg?.type !== 'gate:unlock') return false;
  attempt().then(sendResponse, (e) => sendResponse({ ok: false, reason: e.message }));
  return true; // async
});
