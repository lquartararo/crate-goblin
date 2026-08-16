// Classifying SoundCloud URLs.
//
// Extracted from the content script so it can be tested: buried in there it
// silently misread /feed as a crate and /you/library and /charts/top as tracks,
// because the first path segment isn't always a username.

// SoundCloud's own top-level routes. None of these is a user, so nothing under
// them is a track permalink.
const APP_ROUTES = new Set([
  'feed', 'discover', 'charts', 'stations', 'search', 'upload', 'settings',
  'you', 'notifications', 'messages', 'pro', 'premium', 'imprint', 'terms',
  'privacy', 'jobs', 'mobile', 'tags', 'people', 'stream', 'library',
]);

// Sub-pages of a real user that are listings rather than a single track.
const USER_SUBPAGES = new Set([
  'sets', 'tracks', 'albums', 'reposts', 'likes', 'following', 'followers',
  'comments', 'popular-tracks', 'stats', 'insights',
]);

const segments = (pathname) => pathname.split('/').filter(Boolean);

/** `/user/track` — a single track's permalink. */
export function isTrackPath(pathname) {
  const parts = segments(pathname);
  return parts.length === 2 && !APP_ROUTES.has(parts[0]) && !USER_SUBPAGES.has(parts[1]);
}

/**
 * A page with a track list worth downloading: a profile, its tracks/albums
 * tabs, or a playlist. Explicitly not /feed or /discover — those are feeds of
 * many unrelated crates, so "download this playlist" would be meaningless.
 */
export function isCratePath(pathname) {
  const parts = segments(pathname);
  if (!parts.length || APP_ROUTES.has(parts[0])) return false;
  if (isTrackPath(pathname)) return false;

  if (parts.length === 1) return true;                                  // profile
  if (parts.length === 2) return USER_SUBPAGES.has(parts[1]);           // tracks / albums
  return parts.length === 3 && parts[1] === 'sets';                     // playlist
}

/**
 * What kind of crate a path is, for labelling the in-page button.
 *
 * 'playlist' | 'profile' | null.
 *
 * Albums are deliberately not a case. They live under /sets/ exactly like
 * playlists, and nothing in the URL separates them — SoundCloud only tells them
 * apart by `set_type` on the API response, which the content script never
 * fetches. Guessing from the DOM would mean scraping a badge that moves, to win
 * one word. "Playlist" is right for the common case and never wrong enough to
 * matter.
 */
export function crateKind(pathname) {
  if (!isCratePath(pathname)) return null;
  const parts = segments(pathname);
  return parts.length === 3 && parts[1] === 'sets' ? 'playlist' : 'profile';
}

const YT_HOST = /(^|\.)youtube\.com$|(^|\.)youtu\.be$/;

/**
 * The same question for YouTube.
 *
 * Separate from the SoundCloud rules rather than folded into them: the two
 * sites agree on nothing structurally, and the one thing that reads as a
 * playlist on both is spelled completely differently.
 *
 * Only `list=` counts as a crate. A watch URL that carries one is a video being
 * played *in the context of* a playlist, which is not the same as asking for
 * the playlist, and treating it as one would queue 200 tracks because someone
 * clicked a video from a mix.
 */
export function classifyYouTube(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!YT_HOST.test(u.hostname)) return null;

  if (u.hostname.endsWith('youtu.be')) return u.pathname.length > 1 ? 'track' : null;
  if (u.pathname === '/playlist' && u.searchParams.get('list')) return 'crate';
  if (u.pathname === '/watch' && u.searchParams.get('v')) return 'track';
  return null;
}

/** Same question, for a full URL rather than a path. */
export function classify(url) {
  try {
    const { hostname, pathname } = new URL(url);
    if (hostname !== 'soundcloud.com' && hostname !== 'www.soundcloud.com') return null;
    if (isTrackPath(pathname)) return 'track';
    if (isCratePath(pathname)) return 'crate';
    return null;
  } catch {
    return null;
  }
}

/**
 * Which service a URL belongs to, whether or not the page is one we can use.
 *
 * Distinct from classify() and classifyYouTube(), which both answer "is there
 * something here to download" and return null for a home page, a channel or a
 * feed. Knowing you are on YouTube but not on a video is what lets the empty
 * state say so, instead of offering to send you to a site you are already on.
 *
 * @returns {'soundcloud'|'youtube'|null}
 */
export function serviceOf(url) {
  try {
    const { hostname } = new URL(url);
    if (/^(www\.)?soundcloud\.com$/.test(hostname)) return 'soundcloud';
    if (YT_HOST.test(hostname)) return 'youtube';
    return null;
  } catch {
    return null;
  }
}

/**
 * A page the local downloader can take, when the extension itself cannot.
 *
 * Deliberately narrow. yt-dlp supports around 1800 sites and this could wave at
 * all of them, but a button that appears everywhere and works sometimes is
 * worse than one that appears where it is known to work.
 */
export function nativeTarget(url) {
  const kind = classifyYouTube(url);
  return kind ? { kind, source: 'native' } : null;
}
