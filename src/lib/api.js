// Thin client over SoundCloud's internal api-v2.
//
// Why not yt-dlp's extractor: it discards `purchase_url`, `purchase_title` and
// `publisher_metadata.isrc` — the three fields this tool is built around.
// The raw track object carries 47 fields; we keep the ones that matter.

import { host } from './host.js';

const API = 'https://api-v2.soundcloud.com';

// ---------------------------------------------------------------- client_id

// SoundCloud stopped issuing API keys years ago. The web player embeds one in
// its JS bundles; we scrape it the same way yt-dlp does, then cache it.
// It rotates, so treat any 401/403 as "re-scrape and retry once".
async function scrapeClientId() {
  const html = await (await fetch('https://soundcloud.com/')).text();
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);

  // The id lives in one of the later chunks; walk newest-first.
  for (const src of scripts.reverse()) {
    try {
      const js = await (await fetch(src)).text();
      const hit = js.match(/client_id\s*:\s*"([0-9a-zA-Z]{32})"/);
      if (hit) return hit[1];
    } catch {
      // asset 404s happen during deploys; keep walking
    }
  }
  throw new Error('Could not find a client_id in SoundCloud\'s JS bundles.');
}

export async function getClientId({ force = false } = {}) {
  if (!force) {
    const clientId = await host.getStored('clientId');
    if (clientId) return clientId;
  }
  const clientId = await scrapeClientId();
  await host.setStored('clientId', clientId);
  return clientId;
}

// --------------------------------------------------------------------- auth

// The extension runs inside your logged-in session, so we can lift the OAuth
// token straight from the cookie jar. This is what unlocks Go+ 256k AAC and
// artist-enabled original files — both 401 for anonymous callers.
export const getOAuthToken = () => host.oauthToken();

async function authHeaders() {
  const token = await getOAuthToken();
  return token ? { Authorization: `OAuth ${token}` } : {};
}

// ------------------------------------------------------------------ fetching

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A 295-track playlist is ~6 hydration calls plus ~40 segment fetches per
// track — thousands of requests in a run. Rate limits are a certainty, not an
// edge case, so 429s and transient 5xxs back off and retry rather than failing
// the track. Exponential with a floor, honouring Retry-After when offered.
const MAX_ATTEMPTS = 4;

async function call(path, params = {}, { retryOnAuthFail = true, attempt = 1 } = {}) {
  const clientId = await getClientId();
  const url = new URL(path.startsWith('http') ? path : API + path);
  url.searchParams.set('client_id', clientId);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let res;
  try {
    res = await fetch(url, { headers: await authHeaders() });
  } catch (e) {
    // Network blip rather than a rejection from SoundCloud.
    if (attempt < MAX_ATTEMPTS) {
      await sleep(500 * 2 ** (attempt - 1));
      return call(path, params, { retryOnAuthFail, attempt: attempt + 1 });
    }
    throw e;
  }

  if ((res.status === 401 || res.status === 403) && retryOnAuthFail) {
    await getClientId({ force: true });
    return call(path, params, { retryOnAuthFail: false, attempt });
  }

  if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
    const after = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(after) && after > 0 ? after * 1000 : 500 * 2 ** (attempt - 1);
    await sleep(wait);
    return call(path, params, { retryOnAuthFail, attempt: attempt + 1 });
  }

  if (!res.ok) throw new Error(`api-v2 ${res.status} on ${url.pathname}`);
  return res.json();
}

export const resolve = (url) => call('/resolve', { url });

// ---------------------------------------------------------------- hydration

// Playlist responses interleave full track objects with id-only stubs, e.g.
//   {"id":47127631,"kind":"track","monetization_model":"AD_SUPPORTED","policy":"MONETIZE"}
// Miss this and tracks silently vanish from the triage. Stubs are the ones
// without a `purchase_url` key at all (present-but-null means it's a full object).
const isStub = (t) => !('purchase_url' in t);

export async function hydrate(tracks) {
  const stubs = tracks.filter(isStub);
  if (!stubs.length) return tracks;

  const byId = new Map();
  // /tracks?ids= caps out well below typical playlist sizes; chunk it.
  for (let i = 0; i < stubs.length; i += 50) {
    const ids = stubs.slice(i, i + 50).map((t) => t.id).join(',');
    const full = await call('/tracks', { ids });
    for (const t of full) byId.set(t.id, t);
  }

  // Preserve playlist order — it's the DJ's running order.
  return tracks.map((t) => (isStub(t) ? byId.get(t.id) ?? t : t));
}

/**
 * The URN for one of SoundCloud's own generated sets, or null.
 *
 * These live at /discover/sets/<slug> — personalized tracks, the weekly mixes —
 * and /resolve returns 404 for every one of them, which is why the page looked
 * unsupported. They have their own endpoint, keyed by URN rather than by URL.
 *
 * The colons stay raw. Percent-encoding the slug gets {"errors":["Invalid
 * urn"]} back; the unencoded form parses.
 */
export function systemPlaylistUrn(pageUrl) {
  try {
    const parts = new URL(pageUrl).pathname.split('/').filter(Boolean);
    if (parts.length !== 3 || parts[0] !== 'discover' || parts[1] !== 'sets') return null;
    return `soundcloud:system-playlists:${decodeURIComponent(parts[2])}`;
  } catch {
    return null;
  }
}

// Fetch a playlist/set/user page and return fully-hydrated track objects.
export async function loadTracks(pageUrl) {
  // Generated sets are read off the page rather than fetched. /resolve 404s on
  // them and /system-playlists/:urn wants a urn the URL does not contain — the
  // permalink in the address bar is not it, which is what the 404 on
  // soundcloud:system-playlists:personalized-tracks::… was saying. Every one of
  // them is personalised, so there is no public example to work the real urn out
  // from either. The page is served with the playlist already in it.
  if (systemPlaylistUrn(pageUrl)) {
    const page = await chrome.runtime.sendMessage({ type: 'page:hydration' }).catch(() => null);
    if (!page?.tracks?.length) {
      throw new Error('could not read this set from the page — try reloading it');
    }
    return {
      title: page.title ?? 'Selection',
      album: page.isAlbum ? page.title : null,
      tracks: await hydrate(page.tracks),
    };
  }

  const data = await resolve(pageUrl);

  if (data.kind === 'track') return [data];

  if (data.kind === 'playlist' || data.kind === 'system-playlist') {
    return {
      title: data.title,
      // Only an actual album names the album. SoundCloud flags this explicitly,
      // and a user-made mix titled "remixes !!" is not the album its tracks
      // belong to — writing it as one would invent a fact the tags then assert.
      album: data.is_album ? data.title : null,
      tracks: await hydrate(data.tracks ?? []),
    };
  }

  if (data.kind === 'user') {
    // Unlike playlists, user listings are genuinely paginated — a profile with
    // 500 tracks returns the first page and a next_href. Stopping at one page
    // silently truncates the crate, which looks like the artist has less
    // material rather than like a bug.
    const collected = [];
    let next = null;

    do {
      const page = next
        ? await call(next)
        : await call(`/users/${data.id}/tracks`, { limit: 200 });
      collected.push(...(page.collection ?? []));
      next = page.next_href ?? null;
    } while (next && collected.length < 2000); // sanity stop on huge profiles

    return { title: `${data.username} — tracks`, tracks: await hydrate(collected) };
  }

  throw new Error(`Unsupported page kind: ${data.kind}`);
}

// Resolve a transcoding's signed, short-lived media URL.
export const resolveTranscoding = (t) => call(t.url).then((r) => r.url);

// Artist-enabled original file (the actual WAV/AIFF/FLAC they uploaded).
// 401 here means not logged in; 403 means the artist revoked it.
export async function originalDownloadUrl(trackId) {
  const r = await call(`/tracks/${trackId}/download`);
  return r.redirectUri ?? null;
}
