// Last-resort fallback: fetch a track through lucida.to.
//
// Only ever reached when everything else has failed — SoundCloud offered this
// account nothing but DRM streams, there's no artist download, and no gate
// yielded a file. Not a setting: a fallback you have to know about and switch
// on is one that is off at the moment it would have helped.
//
// Ported from https://github.com/jelni/lucida-downloader (AGPL-3.0), which is a
// client for the service rather than a downloader: all the work happens on
// their side. The protocol is four steps.
//
//   1. GET  lucida.to/?url=<track>&country=<cc>   → HTML with a hydration blob
//   2. POST lucida.to/api/load?url=/api/fetch/stream/v2  → { server, handoff }
//   3. GET  <server>.lucida.to/api/fetch/request/<handoff>            (poll)
//   4. GET  <server>.lucida.to/api/fetch/request/<handoff>/download   (bytes)
//
// The Cloudflare problem, and what it actually took:
//
// lucida.to answers automated requests with a 403 JS challenge. Their CLI can't
// clear it, so it prints instructions and exits — you solve it in a browser,
// then copy the `cf_clearance` cookie and User-Agent out of DevTools and pass
// them as flags.
//
// Being inside the browser turned out not to be enough on its own. The cookie
// does ride along and the User-Agent does match, but the request is still
// refused: Cloudflare weighs `Origin: chrome-extension://…`, `Sec-Fetch-Site:
// cross-site` and an XHR-shaped Accept as well, and those are forbidden header
// names that fetch won't let anyone set. Measured — the same request is 403
// from the extension and 200 from the page's own console.
//
// So steps 1–3 run *inside* a lucida.to tab instead, via the proxy in
// background.js. Step 4 doesn't need to: it's a different subdomain that their
// own web app hits by XHR, so it was never the challenged path, and keeping it
// a direct fetch avoids base64-ing megabytes through runtime messaging.
//
// Nothing here defeats the challenge. You clear it yourself, once, and this
// borrows the session that produces.

import JSON5 from 'json5';

const BASE = 'https://lucida.to';

// The hydration payload is spliced out of the page between these two literals.
// Matching on markup is brittle by nature; when it breaks, `resolve` says so
// with the surrounding bytes rather than throwing a bare parse error.
const PAYLOAD_START = ',{"type":"data","data":';
const PAYLOAD_END = ',"uses":{"url":1}}];';

// Errors lucida renders into the page body rather than signalling with a status.
const PAGE_ERRORS = [
  'An error occured trying to process your request.',
  'Message: "Cannot contact any valid server"',
  'An error occurred. Had an issue getting that item, try again.',
];

/** Thrown when a cross-service match finds nothing — expected, not a fault. */
export class NoMatch extends Error {
  constructor(service) {
    super(`no match on ${service}`);
    this.name = 'NoMatch';
    this.service = service;
  }
}

export class LucidaChallenge extends Error {
  constructor() {
    // No instructions. This clears on its own within a few minutes, and the
    // previous wording sent people to a site to perform a ritual that was going
    // to happen anyway — worse than saying nothing, because it implied they had
    // caused it and had to fix it.
    super('the fallback service is busy');
    this.name = 'LucidaChallenge';
  }
}

/**
 * Fetch from inside a lucida.to page, via the service worker.
 *
 * Not a plain fetch, because the extension's own request is challenged no
 * matter how valid the cf_clearance cookie is — see the note in background.js.
 * chrome.runtime is the one API the offscreen document has, so this works from
 * either context the pipeline runs in.
 */
async function pageFetch(url, init) {
  const res = await chrome.runtime.sendMessage({ type: 'lucida:fetch', url, init });
  if (!res?.ok) throw new Error(res?.reason ?? 'lucida page fetch failed');
  return res;
}

function between(html, start, end) {
  const a = html.indexOf(start);
  if (a === -1) return null;
  const b = html.indexOf(end, a + start.length);
  if (b === -1) return null;
  return html.slice(a + start.length, b);
}

/**
 * Find the same recording on another service, by searching for it.
 *
 * Not by ISRC, though that was the obvious idea and SoundCloud gives us one.
 * Measured against all five services: an ISRC query returns zero results
 * everywhere, so their search simply doesn't index it. A title query returns
 * results, which is the only thing that actually works.
 *
 * Not via their `?to=<service>` resolver either. That's what the site's
 * "resolve to a different service?" checkbox drives, and it is markedly weaker
 * than their own search — it reported no match for a track that this search
 * finds on Amazon in one query. It redirects to `failed-to=` on a miss, which
 * looked like "not available anywhere" when it meant "the resolver gave up".
 *
 * Returns the service's own track URLs, best first.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry a lucida call that came back 429.
 *
 * A crate is dozens of tracks and lucida is one small free service. Being told
 * "too many requests" is not a failure to report, it is the service asking for
 * a moment — and reporting it as an error meant a queue that hit the limit once
 * showed a page of red for tracks that would have worked seconds later.
 *
 * Long waits on purpose. The point is to stop asking, not to ask again sooner.
 */
async function withBackoff(fn, { tries = 4 } = {}) {
  for (let i = 1; ; i++) {
    const res = await fn();
    if (res.status !== 429 || i >= tries) return res;
    const stated = Number(res.headers?.['retry-after'] ?? res.retryAfter);
    const wait = Number.isFinite(stated) && stated > 0
      ? Math.min(stated * 1000, 30_000)
      : 2_000 * 2 ** (i - 1);
    await sleep(wait);
  }
}

export async function search(query, service, country = 'auto') {
  const params = new URLSearchParams({ query, service, country });
  const res = await withBackoff(() => pageFetch(`${BASE}/search?${params}`));
  if (res.status === 403) throw new LucidaChallenge();
  if (res.status === 429) throw new LucidaChallenge();
  if (res.status !== 200) throw new Error(`lucida search ${res.status}`);

  // Results are plain links back into the resolver: /?url=<encoded service url>.
  // Parsed with a regex rather than DOMParser so this behaves identically in
  // the panel and the offscreen document.
  const out = [];
  for (const m of res.body.matchAll(/\/\?url=([^"'&\s>]+)/g)) {
    let url;
    try { url = decodeURIComponent(m[1]); } catch { continue; }
    // Albums come back alongside tracks; only a track is downloadable directly.
    if (!/\/tracks?\//.test(url)) continue;
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

/**
 * Step 1 — resolve a track URL to lucida's own view of it.
 *
 * `to` asks lucida to find the same recording on another service first. That's
 * the whole reason this fallback is worth having: their SoundCloud module can't
 * currently produce a stream, so pointing them at the SoundCloud URL just
 * reproduces the failure we're already stuck on. Matching to Amazon or Tidal
 * gets an entirely different master from a platform that will actually serve it.
 *
 * The site drives this with a `<select name="to">` behind its "resolve to a
 * different service?" checkbox — a plain GET field, so it's just a query param.
 */
export async function resolve(trackUrl, { country = 'auto', to = null } = {}) {
  const params = new URLSearchParams({ url: trackUrl, country });
  if (to) params.set('to', to);
  const res = await withBackoff(() => pageFetch(`${BASE}/?${params}`));

  // Their client treats 403 as a distinct state, not a failure — it means the
  // challenge, which clears itself.
  if (res.status === 403) throw new LucidaChallenge();
  if (res.status === 429) throw new LucidaChallenge();
  if (res.status !== 200) throw new Error(`lucida resolve ${res.status}`);

  // A failed match is a 200 with a redirect, not an error status: the URL comes
  // back carrying `failed-to=<service>` and the page has no payload at all.
  const failed = /[?&]failed-to=([a-z]+)/.exec(res.url ?? '')?.[1];
  if (failed) throw new NoMatch(failed);

  const html = res.body;
  const rendered = PAGE_ERRORS.find((e) => html.includes(e));
  if (rendered) throw new Error(`lucida: ${rendered}`);

  const raw = between(html, PAYLOAD_START, PAYLOAD_END);
  if (!raw) {
    throw new Error('lucida: page payload not found — their markup has moved');
  }

  try {
    // JSON5, not JSON — this is a SvelteKit hydration blob, so its keys are
    // unquoted and JSON.parse dies on the very first one ("expected property
    // name at position 1"). The upstream client reaches for json5 here for the
    // same reason; I'd guessed as much in this error message and then parsed it
    // strictly anyway, which cost a round trip to find out.
    return JSON5.parse(raw);
  } catch (e) {
    throw new Error(`lucida: payload did not parse (${e.message}); starts: ${raw.slice(0, 80)}`);
  }
}

/**
 * Step 2 — ask for a download.
 *
 * `csrf` is per-track, with the page-level token as the fallback the upstream
 * client passes as `secondary`.
 */
export async function requestDownload({ url, csrf, csrfFallback, expiry, country = 'auto' }) {
  const res = await withBackoff(() => pageFetch(`${BASE}/api/load?url=%2Fapi%2Ffetch%2Fstream%2Fv2`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Shape taken from the site's own request rather than the Rust client's
    // struct, which differs in three ways that all reached the server:
    //   private   false, not true — that flag is theirs, not a privacy setting
    //   upload    still disabled, but it names a service even so
    //   secondary omitted entirely when absent, rather than sent as null
    body: JSON.stringify({
      account: { id: country, type: 'country' },
      compat: false,
      // Never take a downscaled copy — the entire reason for reaching this far
      // is that the stream we could get was unusable.
      downscale: 'original',
      handoff: true,
      metadata: true,
      private: false,
      token: csrfFallback
        ? { expiry, primary: csrf, secondary: csrfFallback }
        : { expiry, primary: csrf },
      upload: { enabled: false, service: 'pixeldrain' },
      url,
    }),
  }));

  if (res.status === 403) throw new LucidaChallenge();
  if (res.status === 429) throw new LucidaChallenge();
  if (res.status !== 200) throw new Error(`lucida load ${res.status}`);

  let body;
  try { body = JSON.parse(res.body); }
  catch { throw new Error('lucida: load returned non-JSON'); }
  if (body?.error) throw new Error(`lucida: ${body.error}`);
  if (!body?.server || !body?.handoff) throw new Error('lucida: no handoff returned');
  return body;
}

/** Steps 3 and 4 — wait for it to be ready, then take the bytes. */
export async function fetchPrepared({ server, handoff }, { onProgress, signal } = {}) {
  const base = `https://${server}.lucida.to/api/fetch/request/${handoff}`;
  const deadline = Date.now() + 5 * 60_000;
  let wait = 700;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('cancelled');
    // Straight from the extension, *not* through the page.
    //
    // This is a different origin from lucida.to, and since Chrome 85 a content
    // script's fetch obeys CORS as though the page had made it — host
    // permissions stop exempting it. Polling from inside the tab is therefore
    // cross-origin with no CORS headers coming back, which surfaces as a bare
    // "Failed to fetch". The extension has host access to *.lucida.to and
    // bypasses CORS outright, and these endpoints were never the challenged
    // ones: only the HTML page is.
    const res = await fetch(base, { credentials: 'include' });
    // 404 and 500 are terminal upstream; anything else is worth another pass.
    if (res.status === 404 || res.status === 500) throw new Error(`lucida status ${res.status}`);
    if (res.ok) {
      const s = await res.json();
      if (s?.status === 'completed' || s?.status === 'done') break;
      if (s?.status === 'error') throw new Error(`lucida: ${s.message ?? 'processing failed'}`);
      onProgress?.(s);
    }
    // Backs off rather than sitting at a flat 2s: most requests are ready
    // quickly and a fixed interval spends up to two seconds doing nothing on
    // every one of them, while a slow one doesn't need to be asked as often.
    await new Promise((r) => setTimeout(r, wait));
    wait = Math.min(Math.round(wait * 1.6), 4000);
  }

  const dl = await fetch(`${base}/download`, { credentials: 'include' });
  if (!dl.ok) throw new Error(`lucida download ${dl.status}`);
  return dl.blob();
}

// Tried in order. Amazon first because it matches the widest catalogue of the
// four and serves a plain file; Yandex last because its catalogue is the least
// likely to hold western club material.
export const RESOLVE_ORDER = ['amazon', 'tidal', 'deezer', 'yandex'];

/**
 * The whole thing, for one track.
 *
 * Walks the services until one matches. Returns the blob along with which
 * service it came from, because that's not a detail to hide: this is a
 * different master from a different platform, and a title match on a remix or
 * bootleg is not a guarantee of the same edit.
 */
export async function fetchTrack(trackUrl, { country = 'auto', queries, onProgress, signal } = {}) {
  // A search needs words, not a permalink.
  const attempts = (queries?.length ? queries : [trackUrl]);

  // Services in parallel, query variants in sequence.
  //
  // Walking services one at a time meant a track that isn't on Amazon paid for
  // every query variant against Amazon before Tidal was even tried — up to
  // twelve sequential round trips to conclude "no match", all while holding a
  // worker slot. Fanning out costs the same number of requests but takes as
  // long as the slowest one instead of the sum.
  //
  // Promise.all preserves order, so `find` still picks by RESOLVE_ORDER
  // priority rather than by whichever host answered first.
  for (const q of attempts) {
    onProgress?.({ stage: 'matching', service: RESOLVE_ORDER.join('/') });
    const rounds = await Promise.all(RESOLVE_ORDER.map(async (service) => {
      try {
        return { service, hits: await search(q, service, country) };
      } catch (e) {
        // A challenge is fatal for every service, not just this one.
        if (e.name === 'LucidaChallenge') throw e;
        return { service, hits: [] };
      }
    }));

    const win = rounds.find((r) => r.hits.length);
    if (win) return fromHit(win.hits[0], win.service, { country, onProgress, signal });
  }

  throw new Error(`no match on ${RESOLVE_ORDER.join(', ')}`);
}

async function fromHit(hit, service, { country, onProgress, signal }) {
  onProgress?.({ stage: 'matched', service });
  const page = await resolve(hit, { country });

  const track = pickTrack(page, hit);
  if (!track) throw new Error('lucida: no downloadable track in the payload');

  const handoff = await requestDownload({
    url: track.url ?? hit,
    csrf: track.csrf,
    csrfFallback: track.csrfFallback,
    expiry: page.token_expiry,
    country,
  });

  const blob = await fetchPrepared(handoff, { onProgress, signal });
  return { blob, service, title: page?.info?.title ?? null };
}

/**
 * Pull the track and its csrf out of the payload.
 *
 * The two shapes carry it in completely different places, which is not
 * discoverable by looking for a `csrf` field:
 *
 *   album  each entry in `info.tracks` has its own `csrf` / `csrfFallback`
 *   track  there is *no* csrf anywhere — the page-level `token` is the csrf,
 *          and there's no fallback
 *
 * A SoundCloud permalink always resolves to the single-track shape, so the
 * second case is the one that actually runs. Searching for a csrf field found
 * nothing and every row failed with "no downloadable track".
 */
function pickTrack(page, trackUrl) {
  const info = page?.info;
  if (!info) return null;

  if (info.type === 'track') {
    return { url: info.url ?? trackUrl, csrf: page.token, csrfFallback: null };
  }

  if (info.type === 'album' && Array.isArray(info.tracks)) {
    // Match the one we asked for; an album's first entry is rarely it.
    const hit = info.tracks.find((t) => t?.url === trackUrl) ?? info.tracks[0];
    if (!hit) return null;
    return { url: hit.url, csrf: hit.csrf ?? page.token, csrfFallback: hit.csrfFallback ?? null };
  }

  return null;
}
