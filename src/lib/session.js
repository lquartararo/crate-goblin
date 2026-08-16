// Which SoundCloud account is signed in, and what it is entitled to.
//
// Worth being clear about what this is *not* for. The download path doesn't
// need it: SoundCloud marks the premium stream on each transcoding with
// `quality: 'hq'`, so a Go+ session simply gets better entries in the list and
// rankTranscodings takes them. Nothing has to ask what plan you're on.
//
// This exists so the interface can say why the quality is what it is. "128k
// because you're signed out" and "128k because SoundCloud only offered that"
// look identical in a downloads folder, and only one of them is fixable.

import { host } from './host.js';

const ME = 'https://api-v2.soundcloud.com/me';

// A plan doesn't change between one crate and the next. Cached in memory rather
// than storage because both contexts that ask are long-lived, and a stale
// answer after an upgrade costs one wrong caption.
const TTL_MS = 30 * 60_000;
let cache = null;

/** Free accounts report this; anything else is some paid tier. */
const FREE = /^(free|none)$/i;

export function forgetSession() {
  cache = null;
}

/**
 * @returns {Promise<{signedIn: boolean, goPlus: boolean, plan: string|null}>}
 *
 * Never throws. Every failure resolves to signed-out, because the only thing
 * that depends on this is a caption, and a caption must not be able to break a
 * download.
 */
export async function currentSession() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;

  const value = { signedIn: false, goPlus: false, plan: null };

  try {
    const token = await host.oauthToken();
    if (token) {
      value.signedIn = true;

      const res = await fetch(ME, { headers: { Authorization: `OAuth ${token}` } });
      if (res.ok) {
        const me = await res.json();

        // Read the plan defensively rather than matching a known string. The
        // exact product id for Go+ is not something this could verify without a
        // subscribed account, and guessing one would silently report every
        // subscriber as free. Anything that isn't explicitly free counts, and
        // the raw id is carried through so it can be checked against reality.
        const subs = me?.consumer_subscriptions;
        const product = Array.isArray(subs)
          ? subs.map((s) => s?.product?.id).find(Boolean) ?? null
          : null;

        value.plan = product;
        value.goPlus = Boolean(product) && !FREE.test(product);
      }
    }
  } catch {
    // Offline, revoked token, endpoint moved. All the same: assume nothing.
  }

  cache = { at: Date.now(), value };
  return value;
}
