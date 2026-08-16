// ID3v2.3 tag builder — used for MP3 (prepended) and AIFF (as an `ID3 ` chunk).
//
// v2.3 rather than v2.4 on purpose: frame sizes are plain 32-bit integers
// instead of synchsafe, and every DJ tool reads it. Rekordbox handles 2.4, but
// older Serato builds and hardware are patchier, and there is nothing here that
// needs a 2.4-only feature.
//
// Text is written as UTF-16 with a BOM (encoding byte 0x01). v2.3 officially
// allows only ISO-8859-1 and UTF-16, and track titles are full of accents, box
// characters and non-Latin scripts — Latin-1 would mangle them.

const ascii = (s) => [...s].map((c) => c.charCodeAt(0) & 0xff);

// UTF-16LE with byte-order mark, as v2.3 requires.
function utf16(text) {
  const out = [0xff, 0xfe];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp > 0xffff) {
      // Surrogate pair — emoji in titles is common enough to matter.
      const v = cp - 0x10000;
      const hi = 0xd800 + (v >> 10);
      const lo = 0xdc00 + (v & 0x3ff);
      out.push(hi & 0xff, hi >> 8, lo & 0xff, lo >> 8);
    } else {
      out.push(cp & 0xff, cp >> 8);
    }
  }
  return out;
}

const u32be = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

// The tag header size field is synchsafe: 7 bits per byte, so no byte can look
// like an MPEG sync word. Frame sizes in v2.3 are NOT synchsafe.
const synchsafe = (n) => [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];

const frame = (id, body) => [...ascii(id), ...u32be(body.length), 0, 0, ...body];

const textFrame = (id, value) =>
  value ? frame(id, [0x01, ...utf16(String(value))]) : [];

// COMM is not a text frame, despite looking like one. It carries a 3-byte
// language code and a short description before the actual comment; writing it
// as plain text makes parsers read "eng" as the byte-order mark and drop the
// frame entirely.
const commentFrame = (value) =>
  value
    ? frame('COMM', [
        0x01,
        ...ascii('eng'),
        0xff, 0xfe, 0, 0,       // empty UTF-16 description + terminator
        ...utf16(String(value)),
      ])
    : [];

/**
 * Attached picture frame. `type` 0x03 is "front cover", which is what every
 * library app looks for — other values get ignored or shown as extras.
 */
function pictureFrame(mime, bytes) {
  return frame('APIC', [
    0x01,                       // description encoding (UTF-16)
    ...ascii(mime), 0,          // MIME is always Latin-1, null-terminated
    0x03,                       // front cover
    0xff, 0xfe, 0, 0,           // empty UTF-16 description + terminator
    ...bytes,
  ]);
}

/**
 * @param {object} meta  { title, artist, album, genre, isrc, year, comment }
 * @param {{mime: string, bytes: Uint8Array}|null} artwork
 * @returns {Uint8Array} a complete ID3v2.3 tag
 */
export function buildId3(meta, artwork = null) {
  const frames = [
    ...textFrame('TIT2', meta.title),
    ...textFrame('TPE1', meta.artist),
    ...textFrame('TALB', meta.album),
    ...textFrame('TCON', meta.genre),
    ...textFrame('TSRC', meta.isrc),   // ISRC — the reliable cross-library key
    ...textFrame('TYER', meta.year),
    ...textFrame('TBPM', meta.bpm),
    ...commentFrame(meta.comment),
    ...(artwork ? pictureFrame(artwork.mime, artwork.bytes) : []),
  ];

  return new Uint8Array([
    ...ascii('ID3'), 0x03, 0x00, 0x00,
    ...synchsafe(frames.length),
    ...frames,
  ]);
}
