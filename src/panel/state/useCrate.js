import { useCallback, useEffect, useState } from 'react';
import { loadTracks } from '../../lib/api.js';
import { triage } from '../../lib/triage.js';
import { BUCKET } from '../../lib/triage.js';
import { isCratePath, nativeTarget } from '../../lib/paths.js';

const CACHE_TTL = 5 * 60 * 1000;
const cacheKey = (url) => `crate:${url.split('?')[0]}`;

/**
 * Which page is in front.
 *
 * The ?url= query param is only a hint — it's set when the in-page button opens
 * the panel and absent every other way the panel can appear (toolbar, already
 * docked, after a navigation). Trusting it alone made the panel report "no URL"
 * while sitting beside the playlist.
 */
async function resolvePageUrl() {
  const hint = new URLSearchParams(location.search).get('url');
  if (hint) return hint;
  const res = await chrome.runtime.sendMessage({ type: 'get-page-url' }).catch(() => null);
  return res?.url ?? null;
}

/** The background worker prefetches on navigation; use that if it landed. */
async function cachedOrLoad(url) {
  const key = cacheKey(url);
  try {
    const { [key]: hit } = await chrome.storage.session.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL) return hit.result;
  } catch {
    // session storage unavailable — fall through and fetch
  }
  return loadTracks(url);
}

/**
 * A row for a page the local downloader handles.
 *
 * There is no API call here and deliberately no metadata beyond the tab's own
 * title: yt-dlp reads the real title, artist and artwork at download time and
 * writes them into the file. Duplicating that guesswork in the panel would only
 * create a second answer that disagrees with the one on disk.
 */
async function nativeCrate(url) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  // YouTube prepends the unread notification count to document.title, so the
  // tab reads "(8) Real Title - YouTube" and the 8 is about your subscriptions
  // rather than about the video. yt-dlp writes the real title into the file
  // either way; this is only what the panel shows while it works.
  const title = (tab?.title ?? 'YouTube')
    .replace(/^\s*\(\d+\)\s*/, '')
    .replace(/\s*[-–]\s*YouTube\s*$/i, '')
    .trim() || 'YouTube';

  const row = {
    id: `native:${url}`,
    source: 'native',
    title,
    rawTitle: title,
    artist: '',
    artistDeclared: false,
    isrc: null, genre: null, album: null, year: null,
    durationMs: 0,
    permalink: url,
    artwork: null,
    license: null,
    previewOnly: false,
    drmOnly: false,
    downloadCount: 0,
    bucket: BUCKET.STREAM,
    kind: 'native',
    url: null,
  };
  return { title, rows: [row] };
}

const triageable = (url) => {
  try {
    const u = new URL(url);
    return u.hostname.endsWith('soundcloud.com') && isCratePath(u.pathname);
  } catch {
    return false;
  }
};

/**
 * Loads the crate for whatever page is in front, and follows you as you browse.
 *
 * Returns 'loading' | 'idle' | 'ready' | 'error'. Idle is a real state, not an
 * empty list: on a page with no track list every control describes a download
 * that can't happen, so the panel hides them rather than offering a Download
 * button with nothing to download.
 */
export function useCrate() {
  const [state, setState] = useState('loading');
  const [crate, setCrate] = useState({ title: '', rows: [], tracks: new Map(), url: null });
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const url = await resolvePageUrl();

    // Pages the bridge handles come first: they are not SoundCloud and the
    // triage rules would reject them.
    if (url && nativeTarget(url)) {
      const { title, rows } = await nativeCrate(url);
      setCrate({ url, title, rows, tracks: new Map(rows.map((r) => [r.id, r])) });
      setState('ready');
      return;
    }

    if (!url || !triageable(url)) {
      setCrate({ title: '', rows: [], tracks: new Map(), url });
      setState('idle');
      return;
    }

    try {

      const result = await cachedOrLoad(url);
      const list = Array.isArray(result) ? result : result.tracks;
      // The playlist title becomes an album tag only when SoundCloud says it's
      // an album — a mix called "remixes !!" is not the album its tracks are on.
      const album = Array.isArray(result) ? null : result.album;

      setCrate({
        url,
        title: Array.isArray(result) ? 'Single track' : result.title,
        rows: triage(list, { album }).rows,
        tracks: new Map(list.filter(Boolean).map((t) => [t.id, t])),
      });
      setState('ready');
    } catch (e) {
      setError(e.message);
      setState('error');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // The panel stays docked while you browse, so it has to follow. Without this
  // it keeps showing whichever crate was open when it launched — worse than
  // showing nothing, because it looks correct and isn't.
  useEffect(() => {
    const maybe = (url) => { if (url && url !== crate.url) load(); };
    const onUpdated = (_id, info, tab) => {
      if (tab.active && info.status === 'complete') maybe(tab.url);
    };
    const onActivated = async ({ tabId }) => {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      maybe(tab?.url);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onActivated.addListener(onActivated);
    return () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onActivated.removeListener(onActivated);
    };
  }, [crate.url, load]);

  return { state, crate, error };
}
