// The four things the download pipeline needs from the browser, behind a seam.
//
// Offscreen documents support *only* chrome.runtime — no storage, no cookies,
// no downloads. The pipeline called all three directly, so the one-click
// download failed instantly with "Cannot read properties of undefined (reading
// 'local')" the moment it tried to read a cached client_id.
//
// So the pipeline no longer names chrome.* at all. In the panel these resolve
// to the real APIs; in the offscreen document they proxy to the service worker,
// which does have them. It also makes the pipeline testable without mocking
// half the extension surface.

const direct = {
  async getStored(key) {
    return (await chrome.storage.local.get(key))[key];
  },

  async setStored(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },

  /** Lifts the OAuth token from the logged-in session; null when signed out. */
  async oauthToken() {
    try {
      const c = await chrome.cookies.get({ url: 'https://soundcloud.com', name: 'oauth_token' });
      return c?.value ?? null;
    } catch {
      return null;
    }
  },

  /**
   * Hand a finished blob to the browser's downloader.
   *
   * Goes through the service worker even from the panel, which *does* have
   * chrome.downloads and used to call it directly. Two independent save paths
   * meant two places for naming to go wrong and only one of them under the
   * worker's onDeterminingFilename listener — which is the thing that actually
   * has the last word on what a file is called. One path, one naming rule.
   */
  async save(blobOrUrl, filename) {
    // A string is already a URL the browser can fetch itself; only a Blob needs
    // wrapping. Gate files arrive as the former, so their bytes never enter the
    // extension and CORS never applies to them.
    const isUrl = typeof blobOrUrl === 'string';
    const url = isUrl ? blobOrUrl : URL.createObjectURL(blobOrUrl);
    try {
      const res = await chrome.runtime.sendMessage({ type: 'host:save', url, filename });
      if (!res?.ok) throw new Error(res?.reason ?? 'download failed');
      return res.id;
    } finally {
      // Revoking immediately can cancel an in-flight download.
      if (!isUrl) setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  },
};

let impl = direct;

/** Swap in a different backing implementation — see offscreen.js. */
export function setHost(overrides) {
  impl = { ...direct, ...overrides };
}

// Indirect through `impl` at call time, so setHost() applies to modules that
// imported this before the swap happened.
export const host = {
  getStored: (...a) => impl.getStored(...a),
  setStored: (...a) => impl.setStored(...a),
  oauthToken: (...a) => impl.oauthToken(...a),
  save: (...a) => impl.save(...a),
};
