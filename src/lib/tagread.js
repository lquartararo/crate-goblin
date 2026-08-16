// Detect which tag fields a file already carries.
//
// Needed so we fill gaps instead of overwriting. A master downloaded from the
// artist frequently arrives properly tagged, and SoundCloud's own strings are
// often worse than what's already embedded — titles carry "(FREE DOWNLOAD)",
// "[OUT NOW]", label prefixes and so on. Replacing a clean tag with that is a
// downgrade dressed up as a feature.
//
// Only presence is reported, not values: the decision is "is this field
// already answered", and reading the value would mean handling every text
// encoding for no benefit.

const FIELD_BY_ID3 = {
  TIT2: 'title', TPE1: 'artist', TALB: 'album', TCON: 'genre',
  TYER: 'year', TDRC: 'year', TSRC: 'isrc', APIC: 'artwork', TBPM: 'bpm',
};

const FIELD_BY_ATOM = {
  '\xa9nam': 'title', '\xa9ART': 'artist', '\xa9alb': 'album',
  '\xa9gen': 'genre', '\xa9day': 'year', covr: 'artwork', tmpo: 'bpm',
};

const ascii = (bytes, at, len) =>
  String.fromCharCode(...bytes.subarray(at, at + len));

// ------------------------------------------------------------------- ID3v2

function readId3(bytes, offset = 0) {
  const found = new Set();
  if (bytes.length < offset + 10) return found;
  if (ascii(bytes, offset, 3) !== 'ID3') return found;

  const major = bytes[offset + 3];
  const size =
    ((bytes[offset + 6] & 0x7f) << 21) | ((bytes[offset + 7] & 0x7f) << 14) |
    ((bytes[offset + 8] & 0x7f) << 7) | (bytes[offset + 9] & 0x7f);

  let p = offset + 10;
  const end = Math.min(bytes.length, p + size);

  while (p + 10 <= end) {
    const id = ascii(bytes, p, 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break; // padding, or we've lost the thread

    const view = new DataView(bytes.buffer, bytes.byteOffset + p + 4, 4);
    // v2.4 made frame sizes synchsafe; v2.3 and earlier are plain 32-bit.
    const raw = view.getUint32(0);
    const frameSize = major >= 4
      ? ((raw & 0x7f000000) >> 3) | ((raw & 0x7f0000) >> 2) | ((raw & 0x7f00) >> 1) | (raw & 0x7f)
      : raw;

    // A frame holding only its encoding byte is empty in practice.
    if (FIELD_BY_ID3[id] && frameSize > 1) found.add(FIELD_BY_ID3[id]);
    p += 10 + frameSize;
  }
  return found;
}

// AIFF keeps its ID3 tag inside an `ID3 ` chunk rather than at the head.
function readAiff(bytes) {
  if (ascii(bytes, 0, 4) !== 'FORM') return new Set();
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  let p = 12;
  while (p + 8 <= bytes.length) {
    const id = ascii(bytes, p, 4);
    const size = view.getUint32(p + 4);
    if (id === 'ID3 ') return readId3(bytes, p + 8);
    p += 8 + size + (size & 1); // chunks are word-aligned
    if (size <= 0) break;
  }
  return new Set();
}

// -------------------------------------------------------------------- MP4

function readMp4(bytes) {
  const found = new Set();
  const view = new DataView(bytes.buffer, bytes.byteOffset);

  const walk = (start, end, path) => {
    let p = start;
    while (p + 8 <= end) {
      let size = view.getUint32(p);
      const type = ascii(bytes, p + 4, 4);
      let header = 8;
      if (size === 1) { size = Number(view.getBigUint64(p + 8)); header = 16; }
      else if (size === 0) size = end - p;
      if (size < header) return;

      if (path === 'ilst' && FIELD_BY_ATOM[type]) found.add(FIELD_BY_ATOM[type]);

      if (type === 'moov' || type === 'udta') walk(p + header, p + size, type);
      // `meta` is a full box: 4 bytes of version/flags before its children.
      else if (type === 'meta') walk(p + header + 4, p + size, 'meta');
      else if (type === 'ilst') walk(p + header, p + size, 'ilst');

      p += size;
    }
  };

  walk(0, bytes.length, 'root');
  return found;
}

/**
 * @returns {Promise<Set<string>>} field names already present in the file
 *   ('title' | 'artist' | 'album' | 'genre' | 'year' | 'isrc' | 'artwork' | 'bpm')
 */
export async function readExistingTags(blob, ext) {
  try {
    // 512KB is well past any sane tag block, including embedded artwork, and
    // avoids pulling a 40MB master into memory just to read its header.
    const head = new Uint8Array(await blob.slice(0, 512 * 1024).arrayBuffer());

    if (ext === 'mp3') return readId3(head);
    if (ext === 'aiff' || ext === 'aif') return readAiff(head);
    if (ext === 'm4a' || ext === 'mp4') return readMp4(head);
    // FLAC uses Vorbis comments and WAV usually carries nothing. Reporting
    // "nothing known" is the safe answer: it means we leave the file alone
    // rather than assuming we know better.
    return new Set();
  } catch {
    return new Set();
  }
}
