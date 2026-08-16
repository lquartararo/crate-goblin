// Self-updating, for an extension that can't be self-hosted.
//
// Chrome only allows extension installs from the Web Store on Windows and
// macOS. A .crx with an `update_url` on your own server updates itself on Linux
// and under enterprise policy, and nowhere else — so the normal answer for
// distributing to a few people doesn't exist here.
//
// What does work: the extension stays loaded unpacked from a git checkout, a
// launchd agent pulls that checkout on a timer, and this notices the version on
// disk has moved and reloads. chrome.runtime.reload() on an unpacked extension
// re-reads from disk, so the pull is what actually delivers the update and this
// is only what makes it take effect without anyone clicking Reload.
//
// The ordering doesn't need coordinating. If the pull hasn't landed yet the
// versions still match, nothing happens, and the next check picks it up.

// Where to look. Points at the built output, because that's what gets loaded —
// the source manifest and the built one carry the same version, but reading the
// one that ships means a half-committed build can't advertise itself as ready.
const REPO = 'lquartararo/soundcloud-crate';
const BRANCH = 'main';
const REMOTE_MANIFEST = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/dist/manifest.json`;

const ALARM = 'crate:update-check';
// Three hours. This is a DJ tool used in bursts, not a service — checking more
// often spends requests to find nothing, and a few hours' lag on an update
// nobody is waiting for costs nothing.
const CHECK_MINUTES = 180;
// Not on the first tick after install: a browser restart shouldn't fire a
// network request before the user has done anything.
const FIRST_CHECK_MINUTES = 5;

/**
 * Parse a dotted integer version, or null if it isn't one.
 *
 * Validated by shape rather than by parsing and checking for NaN, because
 * Number('') is 0 — so an empty or missing version reads as 0.0.0 and compares
 * as a real, very old release instead of as the garbage it is.
 */
function parse(v) {
  const s = String(v ?? '').trim();
  return /^\d+(\.\d+)*$/.test(s) ? s.split('.').map(Number) : null;
}

/**
 * Compare dotted integer versions. 1 if a > b, -1 if a < b, 0 if equal.
 *
 * Unparseable input on either side returns 0 — the caller only acts on 1, so
 * "I can't tell" and "no update" lead to the same safe outcome.
 */
export function compareVersions(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;

  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    // Missing trailing fields are zero, so 0.3 and 0.3.0 compare equal rather
    // than looking like an endless update.
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * Does this manifest describe something Chrome could actually load?
 *
 * A reload is not free to get wrong: it happens on someone else's machine, and
 * a half-pushed build leaves the extension broken with no obvious cause and no
 * way back except loading it by hand. So a newer version number alone isn't
 * enough — the manifest has to still name the pieces that make it an extension.
 */
export function looksLoadable(manifest) {
  return Boolean(
    manifest
    && manifest.manifest_version === 3
    && manifest.version
    && manifest.background?.service_worker
    && manifest.side_panel?.default_path,
  );
}

async function check() {
  let remote;
  try {
    // no-store: a cached manifest would keep reporting the old version for as
    // long as the CDN felt like it, which for a three-hour poll means missing
    // updates entirely rather than merely late.
    const res = await fetch(REMOTE_MANIFEST, { cache: 'no-store' });
    if (!res.ok) return;
    remote = await res.json();
  } catch {
    // Offline, rate-limited, repo moved. All the same here: try again later.
    return;
  }

  if (!looksLoadable(remote)) return;

  const running = chrome.runtime.getManifest().version;
  if (compareVersions(remote.version, running) !== 1) return;

  // Only reloads if the pull has already put the new files on disk. If it
  // hasn't, this reloads into the same version, the check runs again, and
  // eventually the two line up — so the two schedules never need to agree.
  console.log(`[crate] updating ${running} → ${remote.version}`);
  chrome.runtime.reload();
}

// Registered at module scope, not inside the scheduler: MV3 evicts this worker
// constantly, and a listener added later doesn't exist when the alarm wakes it.
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) check();
});

/** Start the timer. Safe to call on every worker start — create() is idempotent. */
export function scheduleUpdateChecks() {
  chrome.alarms?.create(ALARM, {
    delayInMinutes: FIRST_CHECK_MINUTES,
    periodInMinutes: CHECK_MINUTES,
  });
}
