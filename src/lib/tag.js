// Applies metadata to a finished audio blob.
//
// Rekordbox and Serato both fall back to the filename when tags are empty, so
// untagged files import as a wall of "Artist - Title" strings with no genre, no
// artwork and nothing to sort on. Everything written here already came back
// from api-v2 during triage; it just wasn't being used.
//
// Per-format mechanics differ:
//   mp3   ID3v2 goes at the head of the file
//   aiff  ID3v2 rides inside an `ID3 ` chunk, and FORM's size has to grow
//   m4a   iTunes atoms live in moov/udta — handled in remux.js, which is
//         already rebuilding moov and so can size it correctly in one pass

import { buildId3 } from './id3.js';
import { readExistingTags } from './tagread.js';

const MAX_ARTWORK_BYTES = 4 * 1024 * 1024;

/** Pull the cover art once per track. Failure is never fatal — tags still go on. */
export async function fetchArtwork(url) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;

    const mime = res.headers.get('content-type') ?? 'image/jpeg';
    if (!/^image\//.test(mime)) return null;

    const bytes = new Uint8Array(await res.arrayBuffer());
    // SoundCloud's -original- artwork is occasionally enormous; a cover that
    // bloats every file past its audio isn't worth embedding.
    if (bytes.length > MAX_ARTWORK_BYTES) return null;

    return { mime, bytes };
  } catch {
    return null;
  }
}

/**
 * Map a triage row onto tag fields, writing only what SoundCloud actually
 * tells us. Guessing is worse than leaving a field empty — an empty field
 * reads as "unknown", a wrong one reads as fact and propagates into your
 * library the moment Rekordbox imports it.
 *
 * Deliberately absent:
 *   bpm / key    never exposed by the API. Rekordbox detects both on import.
 *   album        only known when the track sits in an album (see albumFor).
 *   year         only from release_date. `created_at` is the *upload* date,
 *                which for a re-upload or a back-catalogue post can be years
 *                off — a plausible wrong year is worse than none.
 */
export function metaFromRow(row) {
  return {
    title: row.title,
    // publisher_metadata.artist is what the uploader declared; falling back to
    // the account name is a guess, because promo and label channels post other
    // people's music. triage.js marks which one this came from.
    artist: row.artist,
    album: row.album ?? null,
    genre: row.genre,
    isrc: row.isrc,
    year: row.year ?? null,
    comment: row.permalink,
  };
}

/**
 * Drop any field the file already answers for itself.
 *
 * A master from the artist is usually tagged properly, and SoundCloud's own
 * strings are frequently worse — titles carry "(FREE DOWNLOAD)", "[OUT NOW]"
 * and label prefixes. Overwriting a clean tag with that is a downgrade.
 */
export async function mergeWithExisting(blob, ext, meta, artwork) {
  const present = await readExistingTags(blob, ext);
  if (!present.size) return { meta, artwork, filled: Object.keys(meta) };

  const merged = {};
  const filled = [];
  for (const [field, value] of Object.entries(meta)) {
    // `comment` has no meaningful "already present" test and is ours to set.
    if (value != null && (field === 'comment' || !present.has(field))) {
      merged[field] = value;
      filled.push(field);
    }
  }
  return { meta: merged, artwork: present.has('artwork') ? null : artwork, filled };
}

// ------------------------------------------------------------------- mp3

const concat = (parts) => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
};

// SoundCloud's MP3s may already carry a tag; replacing it beats stacking a
// second one, which some parsers read and others ignore.
function stripExistingId3(bytes) {
  if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return bytes;
  const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) |
               ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
  return bytes.subarray(10 + size);
}

async function tagMp3(blob, meta, artwork) {
  const audio = stripExistingId3(new Uint8Array(await blob.arrayBuffer()));
  return new Blob([buildId3(meta, artwork), audio], { type: 'audio/mpeg' });
}

// ------------------------------------------------------------------ aiff

// AIFF carries ID3 in its own chunk. Chunks are word-aligned and FORM's size
// field covers everything after the "AIFF" type, so both need updating.
async function tagAiff(blob, meta, artwork) {
  const src = new Uint8Array(await blob.arrayBuffer());
  const tag = buildId3(meta, artwork);

  const pad = tag.length & 1 ? 1 : 0;
  const chunk = new Uint8Array(8 + tag.length + pad);
  chunk.set([0x49, 0x44, 0x33, 0x20]); // "ID3 "
  new DataView(chunk.buffer).setUint32(4, tag.length); // big-endian
  chunk.set(tag, 8);

  const out = concat([src, chunk]);
  // FORM size = everything after the 8-byte FORM header.
  new DataView(out.buffer).setUint32(4, out.length - 8);
  return new Blob([out], { type: 'audio/aiff' });
}

// ------------------------------------------------------------------ apply

/**
 * Tag a blob in place of its untagged self. Never throws: a tagging failure
 * must not cost you a track that already downloaded cleanly.
 *
 * m4a is a no-op here — remux.js embeds its atoms while building moov.
 */
export async function applyTags(blob, ext, meta, artwork) {
  try {
    if (ext === 'mp3') return await tagMp3(blob, meta, artwork);
    if (ext === 'aiff') return await tagAiff(blob, meta, artwork);
    return blob;
  } catch {
    return blob;
  }
}
