import { drmOnly } from './hls.js';
import { splitArtistTitle } from './naming.js';

// Sorting a playlist into the three buckets.
//
// Measured against 100 live tracks: 24% were directly grabbable, 67% carried a
// purchase_url (70% of those Hypeddit), the rest stream-only. Your own crates
// will skew differently, but gates dominating is the norm.

export const BUCKET = {
  FREE: 'free',     // artist enabled download -> original master
  GATED: 'gated',   // purchase_url -> Hypeddit/Toneden/Bandcamp/etc
  STREAM: 'stream', // nothing offered; transcode only
};

// Known download-gate hosts. Not used to bypass anything — it drives the UI so
// you can tell "click a follow button" apart from "enter a credit card".
const GATE_HOSTS = [
  'hypeddit.com', 'toneden.io', 'theartistunion.com', 'pumpyoursound.com',
  'droploud.com', 'gaterush.me', 'songrocket.com', 'fanlink.tv',
  'boostdj.co', 'supportify.ch',
];

// Places that sell you the track. Automating these is not a selector problem —
// it's a purchase, which is never something this tool should drive.
const STORE_HOSTS = [
  'bandcamp.com', 'beatport.com', 'juno.co.uk', 'traxsource.com',
  'itunes.apple.com', 'music.apple.com', 'amazon.com', 'google.com',
];

// Smart-link redirectors. They resolve to a store or a streaming service, so
// they behave like stores rather than gates — seen in the wild on label
// releases, where every "purchase_url" was a smarturl.it or iTunes link.
const SMARTLINK_HOSTS = [
  'smarturl.it', 'ffm.to', 'lnk.to', 'orcd.co', 'found.ee',
  'distrokid.com', 'push.fm', 'linktr.ee', 'hyperfollow.com',
];

const hostMatches = (host, list) =>
  list.some((h) => host === h || host.endsWith('.' + h));

function gateKind(purchaseUrl) {
  let host;
  try {
    host = new URL(purchaseUrl).hostname.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
  if (hostMatches(host, GATE_HOSTS)) return 'gate';
  if (hostMatches(host, STORE_HOSTS)) return 'store';
  if (hostMatches(host, SMARTLINK_HOSTS)) return 'smartlink';
  return 'unknown';
}

/** Whether unlock automation could plausibly help. Buying can't be automated. */
export const isAutomatable = (row) =>
  row.bucket === BUCKET.GATED && row.kind !== 'store' && row.kind !== 'smartlink';

export function classify(track) {
  // A free original beats a gate — if the artist already gave it away, take it.
  if (track.downloadable && track.has_downloads_left) {
    return { bucket: BUCKET.FREE, kind: 'original' };
  }
  if (track.purchase_url) {
    return {
      bucket: BUCKET.GATED,
      kind: gateKind(track.purchase_url),
      url: track.purchase_url,
      label: track.purchase_title || 'Buy / Download',
    };
  }
  return { bucket: BUCKET.STREAM, kind: 'transcode' };
}

// Whether *this session* can only get a preview.
//
// Do NOT use `policy === 'SNIP'` for this. `policy` is a catalog property of the
// track — subscription-tier content stays SNIP even for a Go+ subscriber who can
// play it in full. Gating on it refuses downloads that would have worked.
//
// The api-v2 response is session-relative, so the honest signal is what you were
// actually handed. Anonymous on a SNIP track: only `mp3_0_1` transcodings, all
// `snipped: true`, `duration: 30000` against `full_duration: 211905`. With Go+
// the same track returns unsnipped transcodings at full length.
export function isPreviewOnly(track) {
  const transcodings = track.media?.transcodings ?? [];
  if (transcodings.length && transcodings.every((t) => t.snipped === true)) return true;

  // Belt and braces for older responses that omit `snipped`. Real tracks differ
  // from full_duration by milliseconds; a preview differs by minutes.
  const { duration, full_duration: full } = track;
  return Boolean(full && duration && duration < full * 0.9);
}

// Release year, and only when SoundCloud actually states one.
//
// `created_at` is the *upload* date. For a re-upload, a back-catalogue post or
// a track shared long after release it can be years out, and a confidently
// wrong year propagates into your library the moment Rekordbox imports it.
// No year at all is honest; a plausible wrong one is not.
function releaseYear(track) {
  const stated = track.release_date || track.display_date;
  const year = stated && Number(String(stated).slice(0, 4));
  return Number.isInteger(year) && year > 1900 && year < 2100 ? String(year) : null;
}

/**
 * @param context  { album } — the playlist title, but only when the playlist is
 *   genuinely an album. A user-made mix called "remixes !!" is not the album
 *   these tracks belong to, and writing it as one would be inventing a fact.
 */
export function summarize(track, context = {}) {
  const t = classify(track);
  const declared = track.publisher_metadata?.artist;

  // Declared artist beats the account name: promo and label channels post
  // other people's music, so the uploader is not reliably the artist.
  const credited = declared || track.user?.username || 'Unknown';
  // Then tidy the pair. See naming.js — it only acts on what it can corroborate
  // and leaves anything ambiguous exactly as SoundCloud gave it.
  const named = splitArtistTitle({
    title: track.title,
    artist: credited,
    artistDeclared: Boolean(declared),
  });

  return {
    id: track.id,
    title: named.title,
    // What SoundCloud actually called it, kept so the change is auditable and
    // so a bad split can be diagnosed without re-fetching the track.
    rawTitle: track.title,
    artist: named.artist,
    artistDeclared: Boolean(declared),
    isrc: track.publisher_metadata?.isrc ?? null, // best key for dedupe vs your library
    genre: track.genre ?? null,
    album: context.album ?? null,
    year: releaseYear(track),
    durationMs: track.full_duration || track.duration,
    permalink: track.permalink_url,
    artwork: track.artwork_url?.replace('-large.', '-t500x500.') ?? null,
    license: track.license,
    previewOnly: isPreviewOnly(track),
    // Known before anything is attempted, so a crate of these doesn't queue
    // twenty tracks that each walk a fallback chain and fail identically.
    drmOnly: drmOnly(track),
    downloadCount: track.download_count ?? 0,
    ...t,
  };
}

export function triage(tracks, context = {}) {
  const rows = tracks.filter(Boolean).map((t) => summarize(t, context));
  return {
    rows,
    counts: {
      [BUCKET.FREE]: rows.filter((r) => r.bucket === BUCKET.FREE).length,
      [BUCKET.GATED]: rows.filter((r) => r.bucket === BUCKET.GATED).length,
      [BUCKET.STREAM]: rows.filter((r) => r.bucket === BUCKET.STREAM).length,
      previewOnly: rows.filter((r) => r.previewOnly).length,
    },
  };
}
