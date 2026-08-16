// Per-bucket download routing.
//
// This file used to be a download engine. It is now only the routing: which of
// the three ways to get a track applies, and what to do when one of them fails.
//
// The engine moved to yt-dlp and ffmpeg behind the native bridge. That deleted
// hls.js, aac.js, mp3.js, pcm.js, remux.js, id3.js, tag.js, tagread.js and the
// MP3 worker — roughly 1,350 lines whose entire job was doing, inside a browser
// tab, what those two do outside it. They do it better: real ffmpeg instead of
// lamejs and a hand-written ID3 writer, and repaired on a schedule by people
// who do nothing else, which matters far more than either when SoundCloud
// changes something.
//
// What could not move stayed, because it needs a browser and a session:
//
//   gates    clicking through Hypeddit and friends — two thirds of a crate
//   lucida   a page, a challenge, and cookies
//   routing  deciding which of those a track needs
//
// Runs in the offscreen document rather than the service worker: the gate and
// lucida paths still handle blobs, and MV3 workers have no URL.createObjectURL.

import { getOAuthToken } from './api.js';
import { BUCKET } from './triage.js';
import { host } from './host.js';
import { fetchTrack } from './lucida.js';

// Rekordbox and Serato both key off the filename when tags are thin, and a
// slash in a title will silently nest it into a folder you didn't ask for.
export function filename(row, ext, folder) {
  const clean = (s) =>
    (s ?? '')
      .replace(/[/\\?%*:|"<>]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
  const artist = clean(row.artist);
  const title = clean(row.title);
  // Artists routinely bake "Artist - " into the title already; don't double it.
  const joined = artist && title && !title.toLowerCase().startsWith(artist.toLowerCase())
    ? `${artist} - ${title}`
    : title || artist;

  // A name that cleans down to nothing — a title that was all punctuation, or a
  // row missing both fields — makes chrome.downloads reject the filename and
  // silently fall back to the URL's own basename, which is how a track ends up
  // on disk as a bare CDN uuid. The id is ugly but it is ours, and it still
  // points at the track.
  const base = joined || `soundcloud-${row.id}`;
  const name = ext ? `${base}.${ext}` : base;

  // A crate lands in its own folder rather than twenty files loose in Downloads
  // among everything else you saved this week. chrome.downloads treats a
  // forward slash as a subdirectory, and it is the one character that stays
  // meaningful here, which is why clean() strips slashes out of the parts.
  return folder ? `${clean(folder)}/${name}` : name;
}

const save = (blob, name) => host.save(blob, name);

// Below this, whatever came back is an error page or a truncated fragment
// rather than a track.
const MIN_PLAUSIBLE_BYTES = 128 * 1024;

/**
 * What to say when the only live streams are encrypted.
 *
 * SoundCloud serves monetised tracks as encrypted HLS in two schemes and lets
 * the client pick: `cbc-` carries a FairPlay `skd://` key for Apple, `ctr-`
 * declares Widevine and PlayReady for everyone else. In Chrome it is Widevine.
 * Named generically, since the specific system doesn't change the outcome.
 *
 * Session makes no difference, so this no longer asks about one. Measured
 * against a live MONETIZE / AD_SUPPORTED track with a valid OAuth header
 * attached: the encrypted transcodings resolve 200 and every plain one —
 * mp3_1_0 hls, mp3_1_0 progressive, abr_sq — returns 404, exactly as they do
 * signed out. The plain entries are advertised but vestigial.
 */
const drmMessage = () => 'DRM-protected, no plain stream offered';

// --------------------------------------------------------------- the bridge

/**
 * Hand a URL to yt-dlp and let it fetch, convert and tag.
 *
 * Everything that is just "a URL SoundCloud will serve" comes through here:
 * the artist's original when they left downloads on, and the transcodes when
 * they didn't. yt-dlp picks the best available and does the conversion with
 * ffmpeg, which is the same decision tree this file used to hold and a better
 * implementation of the part underneath it.
 */
async function viaBridge(row, opts, onProgress, label = 'yt-dlp') {
  onProgress?.({ phase: 'native' });

  // Progress arrives as broadcasts while the worker holds the port, because
  // connectNative is not available in an offscreen document.
  const relay = (m) => {
    if (m?.type === 'native:progress' && m.id === row.id) {
      onProgress?.({ phase: 'native', text: m.text });
    }
  };
  chrome.runtime.onMessage.addListener(relay);

  try {
    // A Go+ session is handed better transcodings than an anonymous one, and
    // yt-dlp has no session of its own. The extension is already inside one, so
    // it lends the header — rather than yt-dlp reading Chrome's cookie jar,
    // which on macOS raises a keychain prompt.
    const token = await getOAuthToken().catch(() => null);

    const res = await chrome.runtime.sendMessage({
      type: 'native:download',
      job: {
        id: row.id,
        url: row.permalink,
        format: opts.container ?? 'aiff',
        media: opts.media ?? 'audio',
        folder: opts.folder,
        headers: token ? { Authorization: `OAuth ${token}` } : undefined,
      },
    });
    if (!res?.ok) throw new Error(res?.reason ?? 'the downloader failed');
    return { via: `${label} → ${res.name.split('.').pop()}`, bytes: 0, savedAs: res.name };
  } finally {
    chrome.runtime.onMessage.removeListener(relay);
  }
}

/**
 * A file the browser had to fetch itself, converted and tagged by ffmpeg.
 *
 * Gates need a session and lucida needs a page, so those two arrive as a blob
 * rather than as a URL yt-dlp could take. It goes to disk and then out to the
 * same converter, so there is still exactly one answer to "make this the format
 * that was asked for".
 */
async function convertOnDisk(blob, row, opts, onProgress) {
  onProgress?.({ phase: 'remuxing' });

  // A staging name, because the converter names the finished file. Two of them
  // in flight at once would otherwise collide on a shared folder.
  //
  // The folder is agreed with the host, which sweeps anything left here by a
  // conversion that died — see STAGING in crate-goblin-host.py. Renaming it
  // needs both sides.
  const id = await save(blob, `crate-goblin-staging/${crypto.randomUUID()}`);
  const found = await chrome.runtime.sendMessage({ type: 'host:path', id });
  if (!found?.ok) throw new Error('the browser saved the file somewhere it could not name');

  const res = await chrome.runtime.sendMessage({
    type: 'native:convert',
    job: {
      path: found.path,
      format: opts.container ?? 'aiff',
      folder: opts.folder,
      name: filename(row, '').replace(/\.$/, ''),
      // The browser has the artwork and the file usually does not.
      artwork: row.artwork,
      tags: {
        title: row.title || undefined,
        artist: row.artist || undefined,
        album: row.album || undefined,
        date: row.year || undefined,
      },
    },
  });
  if (!res?.ok) throw new Error(res?.reason ?? 'conversion failed');
  return { ext: res.name.split('.').pop(), bytes: blob.size, savedAs: res.name };
}

// ----------------------------------------------------------------- the gate

async function grabViaGate(row, opts, onProgress) {
  onProgress?.({ phase: 'gate' });

  // Pass the name we'd have used, so a browser-driven download lands with the
  // right filename instead of the gate's own.
  const res = await chrome.runtime.sendMessage({
    type: 'gate:attempt',
    url: row.url,
    filename: filename(row, '').replace(/\.$/, ''),
  });
  if (!res?.ok) {
    // unlock.js has always reported the trail of what it managed to do and this
    // threw it away, so every gate failure read the same regardless of whether
    // it found nothing, clicked and got nothing back, or hit a paywall. The
    // difference is the whole diagnosis.
    const trail = res?.did?.length ? ` — ${res.did.join(', ')}` : '';
    throw new Error(`${res?.reason || 'gate did not yield a file'}${trail}`);
  }

  // The gate produced a blob:/data: download from its own page, which we can't
  // refetch from here. Rare now that http(s) downloads are intercepted, but when
  // it happens the file is on disk in whatever format the gate chose, so say
  // exactly that rather than reporting a bare success.
  if (res.viaBrowser) {
    const ext = res.filename?.match(/\.(\w+)$/)?.[1]?.toLowerCase() ?? '?';
    return { via: `gate → ${ext} (saved by the browser — not converted or tagged)`, bytes: 0 };
  }

  if (!res.fileUrl) throw new Error('gate reported success without a file');

  const file = await fetch(res.fileUrl);
  if (!file.ok) throw new Error(`gate file ${file.status}`);

  const type = file.headers.get('content-type') ?? '';
  if (/text\/html/i.test(type)) throw new Error('gate returned a page, not a file');

  const blob = await file.blob();
  if (blob.size < MIN_PLAUSIBLE_BYTES) throw new Error(`gate file too small (${blob.size} B)`);

  try {
    const out = await convertOnDisk(blob, row, opts, onProgress);
    return { via: `gate → ${out.ext}`, bytes: out.bytes, savedAs: out.savedAs };
  } catch (e) {
    // The gate worked and the conversion did not. Reported apart from a gate
    // that refused, because "the markup moved again" is expected and this is a
    // fault in our own plumbing — collapsing both into "gate failed" hides the
    // one worth fixing behind the one that is routine.
    e.afterUnlock = true;
    throw e;
  }
}

// --------------------------------------------------------------- the lucida

/**
 * The last resort: hand the track's SoundCloud URL to lucida.to.
 *
 * Only reached when nothing else worked. Every other path in this tool talks to
 * SoundCloud and nobody else, and this one tells a third party what you're
 * downloading.
 */
async function grabViaLucida(row, opts, onProgress) {
  onProgress?.({ phase: 'lucida' });

  // Title only, and deliberately not the artist.
  //
  // Prepending it seemed obviously right — a bare title like "Arizona B"
  // matches half the catalogue — but measured, it takes a query from two hits
  // to zero. SoundCloud's artist is whoever *uploaded* the track, which for
  // edits and bootlegs is rarely who's credited on the commercial release, so
  // it reads as a term that must match and nothing does.
  //
  // Tried most specific first: brackets often carry a real distinction ("(Radio
  // Edit)"), so the verbatim title leads, and only if that finds nothing do we
  // loosen. The matched title comes back in the status either way, which is the
  // real guard against a wrong hit.
  const title = (row.title ?? '').trim();
  const queries = [...new Set([
    title,
    title.replace(/[()[\]]/g, ' ').replace(/\s+/g, ' ').trim(),
    title.replace(/\s*[([].*$/, '').trim(),
  ].filter(Boolean))];

  const { blob, service, title: matched } = await fetchTrack(row.permalink, {
    queries,
    onProgress: (p) => onProgress?.({ phase: 'lucida', service: p?.service }),
  });
  if (blob.size < MIN_PLAUSIBLE_BYTES) throw new Error(`lucida file too small (${blob.size} B)`);

  const out = await convertOnDisk(blob, row, opts, onProgress);

  // Name the service, and the matched title when it differs from ours. This
  // isn't the SoundCloud upload — it's a different master from a different
  // platform, matched by metadata. For a remix or a bootleg a title match is
  // not proof of the same edit, and that is worth seeing before it's in a set
  // rather than after.
  const differs = matched && row.title
    && matched.trim().toLowerCase() !== row.title.trim().toLowerCase();
  return {
    via: `lucida/${service} → ${out.ext}${differs ? ` · matched "${matched}"` : ''}`,
    bytes: out.bytes,
    matchedFrom: service,
  };
}

/**
 * Everything after SoundCloud, in order of how good the result is.
 *
 * One fallback, because there is one worth having: a lucida match is a real
 * commercial master, often lossless. The original error is what gets reported
 * when the fallback also fails — the reason SoundCloud wouldn't serve the track
 * is the useful one, and "lucida needs a browser check" on top would bury it.
 */
async function orLucida(attempt, row, opts, onProgress) {
  try {
    return await attempt();
  } catch (e) {
    if (e.lucidaTried || !row.permalink) throw e;

    onProgress?.({ phase: 'fallback', reason: `${e.message} — looking elsewhere` });
    try {
      return await grabViaLucida(row, opts, onProgress);
    } catch (inner) {
      // A challenge is actionable in a way the original error isn't, so it's
      // the one worth surfacing.
      if (inner.name === 'LucidaChallenge') throw inner;
    }

    throw e;
  }
}

// ------------------------------------------------------------------ routing

/**
 * Route one row to the right strategy.
 *
 * `mode`
 *   'best'    — originals, then gate automation, falling back to streams
 *   'stream'  — streams only; never touch originals or gates
 *
 * `gatedPolicy` (mode 'best' only)
 *   'auto'    — run the gate automation, fall back to the stream if it fails
 *   'stream'  — skip the gate entirely and take the stream
 *
 * row.url stays intact either way, so the Buy link is still there on the row if
 * you want the real file by hand. Nothing here is fire-and-forget: a failed gate
 * always degrades to a real file rather than a gap in the crate.
 */
export async function downloadRow(row, track, opts = {}, onProgress) {
  // lucida is a fallback for SoundCloud, and only for SoundCloud. It matches a
  // track against streaming services by name, so handing it a YouTube video
  // means searching Tidal for "(8) slayr와 테토의 만남!? …" — it opens a tab,
  // finds nothing, and buries yt-dlp's actual error underneath.
  if (row.source === 'native') return route(row, track, opts, onProgress);

  return orLucida(() => route(row, track, opts, onProgress), row, opts, onProgress);
}

async function route(row, track, opts = {}, onProgress) {
  const { mode = 'best', gatedPolicy = 'auto' } = opts;

  // Anything the bridge handles by URL — YouTube, and now SoundCloud's own
  // streams and originals. The file never comes back through here: Chrome caps
  // a native message at 1MB, so yt-dlp writes it and reports the path.
  if (row.source === 'native') return viaBridge(row, opts, onProgress);

  if (row.previewOnly) {
    // SoundCloud offered only snipped transcodings. A truncated file in a crate
    // is worse than a missing one — you find out mid-set — so this refuses
    // rather than saving 30 seconds of a track. Not a dead end: orLucida
    // catches this and tries elsewhere.
    throw new Error('SoundCloud only offered a 30 second preview');
  }

  // Known DRM — route out before trying anything here.
  //
  // Nothing below can serve an encrypted stream, so walking the chain spends a
  // round trip per candidate, plus a gate tab if it's also gated, to arrive at a
  // failure we could already name.
  //
  // Two sources of "known": triage marks tracks offering nothing but encrypted
  // transcodings, and the panel folds in the remembered set — tracks that also
  // advertise plain entries which turn out to 404, and so only reveal
  // themselves once attempted.
  if (row.drmOnly) {
    if (!row.permalink) throw new Error(drmMessage());
    try {
      return await grabViaLucida(row, opts, onProgress);
    } catch (e) {
      // Tagged so the wrapper doesn't try lucida a second time.
      e.lucidaTried = true;
      throw e;
    }
  }

  // Stream-only: never touch a gate. yt-dlp is told to take the transcodes and
  // leave the artist's original alone, which is the one thing this mode means.
  if (mode === 'stream') return viaBridge(row, opts, onProgress, 'stream');

  // A free original and a stream are the same call now. yt-dlp checks
  // `downloadable` and `has_downloads_left` itself — the same two fields triage
  // reads — and takes the original when they're set, so the fallback this used
  // to need for artists who revoke downloads without clearing the flag is
  // yt-dlp's problem rather than a branch here.
  if (row.bucket === BUCKET.FREE) return viaBridge(row, opts, onProgress, 'original');

  if (row.bucket === BUCKET.GATED) {
    // Stores are attempted too now. They used to short-circuit straight to the
    // stream on the grounds that a checkout is not a gate with a stubborn
    // button — true of a Beatport release, and wrong often enough to matter:
    // "BUY = FREE DL" is a real title, and Bandcamp's name-your-price is a
    // store link to a free file. Trying costs a tab and a few seconds, and the
    // fallback is the same stream it would have taken anyway.
    //
    // What makes this safe is on the other side: unlock.js will not click a
    // control that reads as money — cart, checkout, pay, subscribe, pre-order —
    // so it can take a free download off a store page and cannot begin buying
    // anything. A file that only appears past a real checkout is one this tool
    // does not get, which is the right outcome.
    if (gatedPolicy === 'auto') {
      try {
        return await grabViaGate(row, opts, onProgress);
      } catch (e) {
        // A gate refusing is the expected case, not an exception: the markup
        // shifts constantly. Take the stream and keep the gate queued so it is
        // still recoverable by hand — this is why row.url survives.
        onProgress?.({ phase: 'fallback', reason: e.message });
        const res = await viaBridge(row, opts, onProgress);
        // Say which half broke. `unlocked, then ${reason}` means the gate gave
        // up a file and something on our side lost it, which is a bug rather
        // than a fact about the internet.
        const why = e.afterUnlock
          ? `unlocked, then ${e.message}`
          // Was the bare word "failed". A gate that is actually a shop, one
          // whose markup moved, and one that clicked through to nothing are
          // three different situations, and only the middle one is worth
          // anyone's time.
          : e.message.replace(/\s+—\s+/g, ' · ');
        return { ...res, via: `${res.via} (${why})`, gateFailed: true };
      }
    }

    return viaBridge(row, opts, onProgress);
  }

  return viaBridge(row, opts, onProgress);
}
