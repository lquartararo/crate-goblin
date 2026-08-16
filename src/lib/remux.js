// Fragmented MP4 -> standard MP4, in pure JS. No ffmpeg.wasm, no transcode.
//
// Why this exists: concatenating HLS segments gives a *fragmented* MP4
// (`File type ID: mp4f`, one moof/mdat pair per segment). CoreAudio, VLC and
// ffmpeg all read that happily — so it plays fine on a laptop. Hardware players
// reading a USB stick are far less forgiving, and Rekordbox copies the original
// file to the stick rather than normalising it. For a DJ that's the difference
// between "works at home" and "works in the booth".
//
// The fix is purely structural: fMP4 scatters its timing across per-fragment
// `trun` tables; a standard MP4 wants one flat set of sample tables in `moov`.
// Same AAC frames either way, so this is lossless and byte-identical in audio.

export const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
export const u16 = (v) => [(v >>> 8) & 255, v & 255];
export const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

export function box(type, ...payloads) {
  const body = payloads.flatMap((p) => (p instanceof Uint8Array ? [...p] : p));
  return new Uint8Array([...u32(body.length + 8), ...ascii(type), ...body]);
}

// ------------------------------------------------------------ box walking

// Yields top-level boxes at `start`. MP4 is a flat TLV tree, so the same walker
// serves every nesting level.
function* walk(view, start = 0, end = view.byteLength) {
  let off = start;
  while (off + 8 <= end) {
    let size = view.getUint32(off);
    const type = String.fromCharCode(
      view.getUint8(off + 4), view.getUint8(off + 5),
      view.getUint8(off + 6), view.getUint8(off + 7),
    );
    let header = 8;
    if (size === 1) {
      // 64-bit extended size; audio never needs the high word.
      size = Number(view.getBigUint64(off + 8));
      header = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < header) return; // malformed; bail rather than loop forever
    yield { type, start: off, end: off + size, body: off + header };
    off += size;
  }
}

function find(view, path, start = 0, end = view.byteLength) {
  const [head, ...rest] = path;
  for (const b of walk(view, start, end)) {
    if (b.type !== head) continue;
    return rest.length ? find(view, rest, b.body, b.end) : b;
  }
  return null;
}

// ------------------------------------------------------- fragment parsing

// Pull per-sample size + duration out of every traf, and note where the
// samples actually live so we can copy the frames verbatim.
function readFragments(view) {
  const samples = [];

  for (const moof of walk(view)) {
    if (moof.type !== 'moof') continue;

    // mdat immediately follows its moof in every fMP4 SoundCloud serves.
    let mdat = null;
    for (const b of walk(view, moof.end)) {
      if (b.type === 'mdat') { mdat = b; break; }
      if (b.type === 'moof') break;
    }
    if (!mdat) continue;

    for (const traf of walk(view, moof.body, moof.end)) {
      if (traf.type !== 'traf') continue;

      const tfhd = find(view, ['tfhd'], traf.body, traf.end);
      let defDuration = 0, defSize = 0;
      if (tfhd) {
        const flags = view.getUint32(tfhd.body) & 0xffffff;
        let p = tfhd.body + 8; // version/flags + track_id
        if (flags & 0x01) p += 8;  // base-data-offset
        if (flags & 0x02) p += 4;  // sample-description-index
        if (flags & 0x08) { defDuration = view.getUint32(p); p += 4; }
        if (flags & 0x10) { defSize = view.getUint32(p); p += 4; }
      }

      for (const trun of walk(view, traf.body, traf.end)) {
        if (trun.type !== 'trun') continue;

        const flags = view.getUint32(trun.body) & 0xffffff;
        const count = view.getUint32(trun.body + 4);
        let p = trun.body + 8;
        if (flags & 0x001) p += 4; // data-offset
        if (flags & 0x004) p += 4; // first-sample-flags

        // Samples sit back-to-back in mdat; track a running cursor so that a
        // second trun in the same fragment picks up where the first stopped.
        let cursor = mdatCursor.get(mdat.body) ?? mdat.body;

        for (let i = 0; i < count; i++) {
          let duration = defDuration, size = defSize;
          if (flags & 0x100) { duration = view.getUint32(p); p += 4; }
          if (flags & 0x200) { size = view.getUint32(p); p += 4; }
          if (flags & 0x400) p += 4; // sample-flags
          if (flags & 0x800) p += 4; // composition-time-offset

          samples.push({ offset: cursor, size, duration });
          cursor += size;
        }
        mdatCursor.set(mdat.body, cursor);
      }
    }
  }
  return samples;
}

// Per-mdat write cursor, so multiple truns in one fragment stay contiguous.
const mdatCursor = new Map();

// ----------------------------------------------------------- table builders

export function stts(samples) {
  // Run-length encode durations. AAC is constant-rate, so this collapses to
  // one or two entries for a whole track.
  const runs = [];
  for (const s of samples) {
    const last = runs[runs.length - 1];
    if (last && last.delta === s.duration) last.count++;
    else runs.push({ count: 1, delta: s.duration });
  }
  return box('stts', u32(0), u32(runs.length),
    runs.flatMap((r) => [...u32(r.count), ...u32(r.delta)]));
}

export const stsz = (samples) =>
  box('stsz', u32(0), u32(0), u32(samples.length),
    samples.flatMap((s) => u32(s.size)));

// We copy every sample into one contiguous mdat, so the whole track is a
// single chunk: stsc says "chunk 1 holds all N samples", stco holds one offset.
// Emitting a chunk per sample also works but bloats stco by 4 bytes a frame.
export const stsc = (count) =>
  box('stsc', u32(0), u32(1), [...u32(1), ...u32(count), ...u32(1)]);

export const stco = (offset) => box('stco', u32(0), u32(1), u32(offset));

// -------------------------------------------------------------- itunes tags

// iTunes-style metadata lives in moov/udta/meta/ilst. Bolting it onto a
// finished file means shifting mdat and rewriting every chunk offset, which is
// why it's built here instead: we're already sizing moov in two passes, so an
// extra child costs nothing and stco stays correct for free.
const utf8 = (s) => new TextEncoder().encode(s);

// Each tag's value is wrapped in a `data` atom whose type flags the payload:
// 1 = UTF-8 text, 13 = JPEG, 14 = PNG.
const dataAtom = (type, payload) => box('data', u32(type), u32(0), payload);

const textAtom = (name, value) =>
  value ? box(name, dataAtom(1, utf8(String(value)))) : new Uint8Array(0);

export function buildUdta(meta, artwork) {
  const items = [
    textAtom('\xa9nam', meta.title),
    textAtom('\xa9ART', meta.artist),
    textAtom('\xa9alb', meta.album),
    textAtom('\xa9gen', meta.genre),
    textAtom('\xa9day', meta.year),
    textAtom('\xa9cmt', meta.comment),
  ];

  if (meta.isrc) {
    // No standard atom for ISRC, so use the freeform container iTunes defines.
    items.push(box('----',
      box('mean', u32(0), utf8('com.apple.iTunes')),
      box('name', u32(0), utf8('ISRC')),
      dataAtom(1, utf8(meta.isrc))));
  }

  if (artwork) {
    items.push(box('covr', dataAtom(/png/i.test(artwork.mime) ? 14 : 13, artwork.bytes)));
  }

  const nonEmpty = items.filter((i) => i.length);
  if (!nonEmpty.length) return new Uint8Array(0);

  return box('udta',
    box('meta',
      u32(0), // meta is a full box: version + flags before its children
      box('hdlr', u32(0), u32(0), ascii('mdir'), ascii('appl'), u32(0), u32(0), u32(0)),
      box('ilst', ...nonEmpty)));
}

// ------------------------------------------------------------------ remux

/**
 * @param {ArrayBuffer} buffer  init segment + media segments, concatenated
 * @returns {Blob} standard (non-fragmented) MP4, `File type ID: m4af`
 */
export function remuxToStandardMp4(buffer, meta = null, artwork = null) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  mdatCursor.clear();

  const moov = find(view, ['moov']);
  if (!moov) throw new Error('no moov box — was the init segment fetched first?');

  const samples = readFragments(view);
  if (!samples.length) throw new Error('no samples found in fragments');

  // Reuse the init segment's own descriptors. stsd carries the AAC/esds config;
  // rebuilding it by hand is how you end up with silent or mono output.
  const stsd = find(view, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd']);
  const mdhd = find(view, ['moov', 'trak', 'mdia', 'mdhd']);
  const hdlr = find(view, ['moov', 'trak', 'mdia', 'hdlr']);
  const tkhd = find(view, ['moov', 'trak', 'tkhd']);
  const mvhd = find(view, ['moov', 'mvhd']);
  if (!stsd || !mdhd || !hdlr || !tkhd || !mvhd) throw new Error('init segment missing descriptors');

  const slice = (b) => bytes.subarray(b.start, b.end);

  // Media duration is in the track's own timescale (mdhd); mvhd/tkhd express
  // theirs in the *movie* timescale. They're usually both 44100 here, but
  // assuming that is how you get a track that reports the wrong length.
  const mdhdV1 = bytes[mdhd.start + 8] === 1;
  const timescale = view.getUint32(mdhd.start + (mdhdV1 ? 28 : 20));
  const duration = samples.reduce((a, s) => a + s.duration, 0);

  const mvhdV1 = bytes[mvhd.start + 8] === 1;
  const movieTimescale = view.getUint32(mvhd.start + (mvhdV1 ? 28 : 20));
  const movieDuration = Math.round((duration * movieTimescale) / timescale);

  // fMP4 leaves all three durations at 0 — the real timing lives in the truns.
  // Version 0 stores 32-bit at one offset, version 1 stores 64-bit at another.
  const patch = (b, v0Off, v1Off, value) => {
    const copy = slice(b).slice();
    const dv = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
    if (copy[8] === 1) dv.setBigUint64(v1Off, BigInt(value));
    else dv.setUint32(v0Off, value);
    return copy;
  };

  const mvhdOut = patch(mvhd, 24, 32, movieDuration);
  const tkhdOut = patch(tkhd, 28, 36, movieDuration);
  const mdhdOut = patch(mdhd, 24, 32, duration);

  // The mdat offset depends on the moov's size, and the moov contains that
  // offset — circular. Build once with a placeholder to measure, then again
  // with the real value. The size can't change between the two: stco holds a
  // fixed-width u32 either way.
  const udta = meta ? buildUdta(meta, artwork) : new Uint8Array(0);

  const build = (chunkOffset) =>
    box('moov',
      mvhdOut,
      box('trak',
        tkhdOut,
        box('mdia',
          mdhdOut,
          slice(hdlr),
          box('minf',
            box('smhd', u32(0), u16(0), u16(0)),
            box('dinf', box('dref', u32(0), u32(1), box('url ', [0, 0, 0, 1]))),
            box('stbl', slice(stsd), stts(samples), stsc(samples.length), stsz(samples), stco(chunkOffset)),
          ),
        ),
      ),
      udta,
    );

  const ftyp = box('ftyp', ascii('M4A '), u32(512), ascii('M4A isomiso2'));
  const probe = build(0);
  const mdatStart = ftyp.length + probe.length + 8;
  const moovOut = build(mdatStart);

  const audioLength = samples.reduce((a, s) => a + s.size, 0);
  const mdatHeader = new Uint8Array([...u32(audioLength + 8), ...ascii('mdat')]);

  const audio = new Uint8Array(audioLength);
  let w = 0;
  for (const s of samples) {
    audio.set(bytes.subarray(s.offset, s.offset + s.size), w);
    w += s.size;
  }

  return new Blob([ftyp, moovOut, mdatHeader, audio], { type: 'audio/mp4' });
}
