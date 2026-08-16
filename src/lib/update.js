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

// Read off disk, not off the network.
//
// The obvious version of this fetched the manifest from raw.githubusercontent —
// which works only for a public repo. This one is private, so that request 404s
// forever and the check silently never fires. Authenticating it would mean
// shipping a token in source that every friend gets a copy of.
//
// So it asks the filesystem instead. For an unpacked extension these two read
// different things:
//
//   chrome.runtime.getManifest()  what Chrome loaded, fixed until a reload
//   fetch(getURL('manifest.json'))  the bytes on disk, which the pull rewrites
//
// When they disagree, the pull has landed and a reload will pick it up. No
// network, no credentials, and it works the same whether the repo is public,
// private, or not on GitHub at all.
const DISK_MANIFEST = 'manifest.json';

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
  let onDisk;
  try {
    // no-store so this reads the file rather than whatever Chrome cached when
    // the extension loaded — which would be the version already running, and
    // would never differ.
    const res = await fetch(chrome.runtime.getURL(DISK_MANIFEST), { cache: 'no-store' });
    if (!res.ok) return;
    onDisk = await res.json();
  } catch {
    // Mid-pull, or the checkout moved. Try again on the next tick.
    return;
  }

  if (!looksLoadable(onDisk)) return;

  const running = chrome.runtime.getManifest().version;
  if (compareVersions(onDisk.version, running) !== 1) return;

  console.log(`[crate] updating ${running} → ${onDisk.version}`);
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
