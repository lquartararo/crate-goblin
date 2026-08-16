// Per-bucket download routing.
//
// Runs in the panel page, not the service worker: MV3 workers have no
// URL.createObjectURL, and streaming a 40-segment track through one is a
// fight you don't need to have.

import { resolveTranscoding, originalDownloadUrl, getOAuthToken } from './api.js';
import { fetchHlsAudio, rankTranscodings, drmOnly } from './hls.js';
import { remuxToStandardMp4 } from './remux.js';
import { toM4a } from './aac.js';
import { toPcm } from './pcm.js';
import { toMp3 } from './mp3.js';
import { applyTags, fetchArtwork, metaFromRow, mergeWithExisting } from './tag.js';
import { BUCKET, isAutomatable } from './triage.js';
import { host } from './host.js';
import { fetchTrack } from './lucida.js';

// Rekordbox and Serato both key off the filename when tags are thin, and a
// slash in a title will silently nest it into a folder you didn't ask for.
function filename(row, ext, folder) {
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

const AUDIO_EXT = /\.(wav|aiff?|flac|mp3|m4a|ogg)(?:$|[?#])/i;

const extFromUrl = (url, fallback) =>
  url.match(AUDIO_EXT)?.[1]?.toLowerCase() ?? fallback;

const FROM_MIME = {
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/aiff': 'aiff', 'audio/x-aiff': 'aiff',
  'audio/flac': 'flac', 'audio/x-flac': 'flac',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
};

/**
 * Work out what a gate actually handed us.
 *
 * The URL is the least reliable of the three signals — plenty of gates serve
 * from a path with no extension at all, and guessing 'mp3' there meant a WAV
 * got labelled mp3 and skipped conversion. Content-Disposition is what the
 * server says the file is called, so it wins; the MIME type is the backstop.
 */
function extFromResponse(res, fallback = 'mp3') {
  const disposition = res.headers.get('content-disposition') ?? '';
  const named = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i)?.[1];
  const fromName = named && decodeURIComponent(named).match(AUDIO_EXT)?.[1];
  if (fromName) return fromName.toLowerCase();

  const fromUrl = res.url.match(AUDIO_EXT)?.[1];
  if (fromUrl) return fromUrl.toLowerCase();

  const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  return FROM_MIME[mime] ?? fallback;
}

const LOSSLESS = /^(wav|aiff?|flac)$/i;

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
 * signed out. The plain entries are advertised but vestigial. Earlier wording
 * told people to sign in and retry, which is advice that cannot work and sends
 * someone hunting for a problem on their own end.
 */
const drmMessage = () => 'DRM-protected, no plain stream offered';

/**
 * Bring a directly-acquired file (artist original, or whatever a gate handed
 * over) in line with the chosen format, and tag it.
 *
 * This used to refuse to transcode a lossless master down to a lossy target: if
 * you asked for MP3 and the artist uploaded a WAV, you kept the WAV. The
 * reasoning was that throwing away a master to save disk is a bad trade — but
 * it's not the call to make silently. Picking MP3 means wanting MP3 everywhere,
 * usually because something downstream has to read it, and a crate that is
 * mostly MP3 with unexplained 60 MB WAVs in it is worse than one that's
 * consistent. Worse still, WAV is the one format applyTags can't write, so
 * those kept files were also the only untagged, art-less ones in the crate.
 *
 * So: the requested container always wins. The only fallback is a failed
 * conversion, where keeping the original beats losing the track.
 */
async function finalize(blob, sourceExt, row, opts, onProgress) {
  const { container = 'aiff', tags = true } = opts;
  const meta = tags ? metaFromRow(row) : null;
  const artwork = tags ? await fetchArtwork(row.artwork) : null;

  const ext = sourceExt.replace(/^aif$/, 'aiff');

  if (ext !== container) {
    onProgress?.({ phase: 'decoding' });
    try {
      // m4a had no branch here and fell through to toPcm, which wrote AIFF
      // audio into a file named .m4a — a container lying about its contents,
      // which fails at the deck rather than in the panel.
      //
      // It tags itself, unlike the others: iTunes atoms live inside moov, so
      // they have to be written while the container is built rather than
      // bolted on afterwards. That's why applyTags is a no-op for m4a.
      let out;
      if (container === 'm4a') {
        out = await toM4a(blob, meta, artwork);
      } else {
        const converted = container === 'mp3'
          ? await toMp3(blob)
          : await toPcm(blob, container === 'wav' ? 'wav' : 'aiff');
        out = meta ? await applyTags(converted, container, meta, artwork) : converted;
      }
      await save(out, filename(row, container, opts.folder));
      return {
        ext: container,
        converted: true,
        from: LOSSLESS.test(ext) ? ext : null,
        bytes: out.size,
      };
    } catch (e) {
      // The file is already downloaded and playable; only the conversion
      // failed. Keeping it in its original form is strictly better than losing
      // it over a container preference.
      onProgress?.({ phase: 'fallback', reason: `convert failed: ${e.message}` });
    }
  }

  const out = meta ? await tagPreservingExisting(blob, ext, meta, artwork) : blob;
  await save(out, filename(row, ext, opts.folder));
  return { ext, bytes: out.size };
}

// Fill only the gaps. Applies to files we keep as-is; a converted file has no
// tags to preserve, so those get the full set written fresh.
async function tagPreservingExisting(blob, ext, meta, artwork) {
  const merged = await mergeWithExisting(blob, ext, meta, artwork);
  if (!merged.filled.length && !merged.artwork) return blob; // already complete
  return applyTags(blob, ext, merged.meta, merged.artwork);
}

/**
 * Save an MP3 SoundCloud handed us, converting when the chosen format isn't it.
 *
 * Only PCM targets convert. Asking for m4a and being given a progressive MP3
 * means the AAC wasn't available at all — and re-encoding MP3 into AAC would
 * stack a second lossy generation on the first purely to satisfy a container
 * preference. That's a worse trade than the wrong extension, so m4a keeps the
 * MP3. Decoding to PCM is lossless from here, so aiff/wav convert cleanly.
 */
async function fromMp3Source(raw, row, container, meta, artwork, onProgress, folder) {
  if (container === 'aiff' || container === 'wav') {
    onProgress?.({ phase: 'decoding' });
    try {
      const pcm = await toPcm(raw, container);
      const out = meta ? await applyTags(pcm, container, meta, artwork) : pcm;
      await save(out, filename(row, container, folder));
      return { suffix: ` → ${container}`, bytes: out.size };
    } catch (e) {
      onProgress?.({ phase: 'fallback', reason: `${container} decode failed: ${e.message}` });
    }
  }
  const out = meta ? await applyTags(raw, 'mp3', meta, artwork) : raw;
  await save(out, filename(row, 'mp3', folder));
  return { suffix: '', bytes: out.size };
}

// --------------------------------------------------------------- strategies

// Bucket B: hand the gate to the automation and take whatever file it exposes.
//
// Deliberately strict about what counts as success. A gate that returns an HTML
// error page, a 30-byte placeholder, or a redirect back to itself must read as
// failure so the caller drops to the stream — a broken file in a crate is worse
// than a lower-bitrate one, because you don't find out until you play it.
const MIN_PLAUSIBLE_BYTES = 128 * 1024;

async function grabViaGate(row, opts, onProgress) {
  onProgress?.({ phase: 'gate' });

  // Pass the name we'd have used, so a browser-driven download lands with the
  // right filename instead of the gate's own.
  const res = await chrome.runtime.sendMessage({
    type: 'gate:attempt',
    url: row.url,
    filename: filename(row, '').replace(/\.$/, ''),
  });
  if (!res?.ok) throw new Error(res?.reason || 'gate did not yield a file');

  // The gate produced a blob:/data: download from its own page, which we can't
  // refetch from here. Rare now that http(s) downloads are intercepted and run
  // through the pipeline, but when it happens the file is on disk in whatever
  // format the gate chose, unconverted and untagged — so say exactly that
  // rather than reporting a bare success.
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

  const out = await finalize(blob, extFromResponse(file), row, opts, onProgress);
  return { via: `gate → ${out.ext}${out.from ? ` (from ${out.from})` : ''}`, bytes: out.bytes };
}

// Bucket A: the actual master the artist uploaded. Needs a logged-in session.
async function grabOriginal(row, opts, onProgress) {
  const url = await originalDownloadUrl(row.id);
  if (!url) throw new Error('Artist download returned no URL');

  onProgress?.({ phase: 'downloading' });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`original ${res.status}`);
  const blob = await res.blob();

  const out = await finalize(blob, extFromResponse(res, 'wav'), row, opts, onProgress);
  return { via: `original → ${out.ext}${out.from ? ` (from ${out.from})` : ''}`, bytes: out.bytes };
}

// Bucket C (and the gated fallback): best available transcode.
//
// `container` decides what lands on disk. Nothing here re-encodes audio.
//
//   'aiff'  decode the AAC to PCM. ~10x bigger, identical sound, plays on
//           anything. Default, because SoundCloud's AAC is VBR and VBR is the
//           known trigger for stutter on older club decks — and a track that
//           dies mid-set costs more than disk does.
//   'm4a'   keep the AAC, rewrite the container losslessly. Best quality per
//           byte there is: same audio AIFF decodes from, ~1/10th the size.
//   'mp3'   SoundCloud's own 128k MP3, fetched directly. Lower quality than
//           either of the above, but one lossy generation rather than two —
//           transcoding the AAC would stack a second. For maximum reach.
//
// 'wav' and 'fragmented' still work and are kept as internal fallbacks when a
// decode or remux fails; they're just not worth a slot in the UI.
async function grabStream(row, track, { container = 'aiff', tags = true, folder } = {}, onProgress) {
  const meta = tags ? metaFromRow(row) : null;
  // One artwork fetch per track, shared by whichever container path wins.
  const artwork = tags ? await fetchArtwork(row.artwork) : null;

  const authenticated = Boolean(await getOAuthToken());
  // Asking for mp3 means taking the progressive stream rather than the AAC.
  const candidates = rankTranscodings(track, { preferAac: container !== 'mp3', authenticated });
  if (!candidates.length) {
    throw new Error(drmOnly(track) ? drmMessage() : 'No usable transcoding offered');
  }

  // Advertised presets aren't always servable — abr_sq 404s without auth, and
  // legacy entries go stale. Walk down until one actually resolves.
  let t, mediaUrl, lastErr;
  for (const candidate of candidates) {
    try {
      mediaUrl = await resolveTranscoding(candidate);
      t = candidate;
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!t) {
    // Every candidate 404'd. The usual cause is that the plain transcodings are
    // still advertised but no longer served, leaving only the encrypted streams
    // we skip — so lead with what's actually true. Dumping the signed URL that
    // failed told you nothing you could act on.
    const hasDrmAlternatives = (track.media?.transcodings ?? [])
      .some((x) => /^(ctr|cbc)-encrypted/.test(x.format?.protocol ?? ''));
    if (hasDrmAlternatives) throw new Error(drmMessage());
    throw new Error(`No transcoding resolved (last: ${lastErr?.message})`);
  }

  // Progressive is a single signed file — one fetch, nothing to assemble.
  if (t.format.protocol === 'progressive') {
    onProgress?.({ phase: 'downloading' });
    const raw = await (await fetch(mediaUrl)).blob();
    const out = await fromMp3Source(raw, row, container, meta, artwork, onProgress, folder);
    return { via: `${t.preset} progressive${out.suffix}`, bytes: out.bytes };
  }

  onProgress?.({ phase: 'segments' });
  const blob = await fetchHlsAudio(mediaUrl, (done, total) =>
    onProgress?.({ phase: 'segments', done, total }),
  );

  const isMp3 = t.format.mime_type?.includes('mpeg');
  if (isMp3) {
    // HLS MP3 segments are raw frames; concatenation is already a valid MP3.
    const out = await fromMp3Source(blob, row, container, meta, artwork, onProgress, folder);
    return { via: `${t.preset} hls${out.suffix}`, bytes: out.bytes };
  }

  // PCM is a decode, not a remux — no point rewriting the container first.
  if (container === 'aiff' || container === 'wav') {
    onProgress?.({ phase: 'decoding' });
    try {
      const pcm = await toPcm(blob, container);
      const out = meta ? await applyTags(pcm, container, meta, artwork) : pcm;
      await save(out, filename(row, container, folder));
      return { via: `${t.preset} hls → ${container}`, bytes: out.size };
    } catch (e) {
      onProgress?.({ phase: 'fallback', reason: `${container} decode failed: ${e.message}` });
      // fall through to the m4a paths below rather than losing the track
    }
  }

  if (container === 'fragmented') {
    // No tagging here: atoms are written while moov is rebuilt, and this path
    // exists precisely to skip that rebuild.
    await save(blob, filename(row, 'm4a', folder));
    return { via: `${t.preset} hls (fragmented)`, bytes: blob.size };
  }

  onProgress?.({ phase: 'remuxing' });
  try {
    const std = remuxToStandardMp4(await blob.arrayBuffer(), meta, artwork);
    await save(std, filename(row, 'm4a', folder));
    return { via: `${t.preset} hls → standard mp4`, bytes: std.size };
  } catch (e) {
    // The audio is already downloaded and fine — only the container rewrite
    // failed. Keeping the fragmented file costs CDJ compatibility; throwing
    // away a fully-downloaded track costs you the track. Save it and say so.
    onProgress?.({ phase: 'fallback', reason: `remux failed: ${e.message}` });
    await save(blob, filename(row, 'm4a', folder));
    return { via: `${t.preset} hls (fragmented — remux failed)`, bytes: blob.size, remuxFailed: true };
  }
}

/**
 * The last resort: hand the track's SoundCloud URL to lucida.to.
 *
 * Only reached when nothing else worked. Opt-in, and deliberately so — every
 * other path in this tool talks to SoundCloud and nobody else, and this one
 * tells a third party what you're downloading. Off unless you turn it on.
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
    title.replace(/[()\[\]]/g, ' ').replace(/\s+/g, ' ').trim(),
    title.replace(/\s*[([].*$/, '').trim(),
  ].filter(Boolean))];

  const { blob, service, title: matched } = await fetchTrack(row.permalink, {
    queries,
    onProgress: (p) => onProgress?.({ phase: 'lucida', service: p?.service }),
  });
  if (blob.size < MIN_PLAUSIBLE_BYTES) throw new Error(`lucida file too small (${blob.size} B)`);

  // lucida returns FLAC where it can, so trust the blob's own type over the
  // extension — there's no filename in the response to read one from.
  const ext = FROM_MIME[(blob.type ?? '').split(';')[0].trim().toLowerCase()] ?? 'flac';
  const out = await finalize(blob, ext, row, opts, onProgress);

  // Name the service, and the matched title when it differs from ours. This
  // isn't the SoundCloud upload — it's a different master from a different
  // platform, matched by metadata. For a remix or a bootleg a title match is
  // not proof of the same edit, and that is worth seeing before it's in a set
  // rather than after.
  const differs = matched && row.title && matched.trim().toLowerCase() !== row.title.trim().toLowerCase();
  return {
    via: `lucida/${service} → ${out.ext}${differs ? ` · matched "${matched}"` : ''}`,
    bytes: out.bytes,
    matchedFrom: service,
  };
}

/**
 * Run `attempt`, and if it fails and the fallback is enabled, try lucida.
 *
 * The original error is what gets reported when the fallback also fails: the
 * reason SoundCloud wouldn't serve the track is the useful one, and "lucida
 * needs a browser check" on top of it would bury it.
 */
async function orLucida(attempt, row, opts, onProgress) {
  try {
    return await attempt();
  } catch (e) {
    if (e.lucidaTried || !row.permalink) throw e;
    onProgress?.({ phase: 'fallback', reason: `${e.message} — trying lucida` });
    try {
      return await grabViaLucida(row, opts, onProgress);
    } catch (inner) {
      // A challenge is actionable in a way the original error isn't, so it's
      // the one worth surfacing.
      if (inner.name === 'LucidaChallenge') throw inner;
      throw e;
    }
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
  // One place for the fallback, wrapping the whole routing tree: every
  // terminal path below ends in a stream attempt, so anything that escapes
  // here has genuinely exhausted SoundCloud.
  return orLucida(() => route(row, track, opts, onProgress), row, opts, onProgress);
}

async function route(row, track, opts = {}, onProgress) {
  const { mode = 'best', gatedPolicy = 'auto' } = opts;

  if (row.previewOnly) {
    // SoundCloud offered only snipped transcodings. A truncated file in a crate
    // is worse than a missing one — you find out mid-set — so this refuses
    // rather than saving 30 seconds of a track.
    //
    // States the fact and stops there. It used to add "check you are signed
    // in", which is the same unfalsifiable advice the DRM message carried: for
    // someone already signed in with Go+ it sends them auditing their own
    // account for a fault that isn't there. Unlike DRM, a session genuinely can
    // be the cause here — but so can the track simply being subscriber-only,
    // and the message can't tell which, so it shouldn't imply it can.
    //
    // Not a dead end either way: orLucida catches this and tries elsewhere.
    throw new Error('SoundCloud only offered a 30 second preview');
  }

  // Known DRM — route out before trying anything here.
  //
  // Nothing below can serve an encrypted stream, so walking the chain spends a
  // resolve round trip per candidate, plus a gate tab if it's also gated, to
  // arrive at a failure we could already name. Worse, it reports that failure
  // as a `warn` fallback first, so the row flickers through a reason that isn't
  // the real one.
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
      // Tagged so the wrapper doesn't immediately try lucida a second time.
      e.lucidaTried = true;
      throw e;
    }
  }

  // Stream-only: one path, no originals, no gate tabs opened at all.
  if (mode === 'stream') return grabStream(row, track, opts, onProgress);

  if (row.bucket === BUCKET.FREE) {
    try {
      return await grabOriginal(row, opts, onProgress);
    } catch (e) {
      // Artists revoke downloads without clearing the flag; fall back rather
      // than failing the whole batch.
      onProgress?.({ phase: 'fallback', reason: e.message });
      return grabStream(row, track, opts, onProgress);
    }
  }

  if (row.bucket === BUCKET.GATED) {
    // A store or smart-link isn't a gate with a stubborn button — it's a
    // checkout. Running the unlock automation at one wastes seconds and could
    // never succeed, so take the stream and leave the link queued for you.
    if (gatedPolicy === 'auto' && !isAutomatable(row)) {
      onProgress?.({ phase: 'fallback', reason: `${row.kind} link — not automatable` });
      const res = await grabStream(row, track, opts, onProgress);
      return { ...res, via: `${res.via} (${row.kind} link queued)`, gateFailed: true };
    }

    if (gatedPolicy === 'auto') {
      try {
        return await grabViaGate(row, opts, onProgress);
      } catch (e) {
        // The expected case, not an exception: gate markup shifts constantly.
        // Take the stream and keep the gate queued so it's still recoverable
        // by hand — this is why row.url survives a failed attempt.
        onProgress?.({ phase: 'fallback', reason: e.message });
        const res = await grabStream(row, track, opts, onProgress);
        return { ...res, via: `${res.via} (gate failed)`, gateFailed: true };
      }
    }

    return grabStream(row, track, opts, onProgress);
  }

  return grabStream(row, track, opts, onProgress);
}
