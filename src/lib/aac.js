// Encode PCM to AAC and wrap it in a standard MP4.
//
// The gap this fills: asking for M4A when the source was lossless. Every other
// target had a path — AIFF decodes, MP3 encodes through LAME — but M4A fell
// through to `toPcm`, which wrote *AIFF audio into a .m4a container*. A file
// that lies about its format is worse than a missing one, because it fails at
// the deck rather than in the panel.
//
// Nothing here re-encodes AAC that we already have: the HLS path still remuxes
// its existing AAC losslessly (remux.js). This is only for sources that were
// never AAC to begin with.
//
// The encoder is the browser's own. Chrome's WebCodecs AudioEncoder does AAC
// natively, so this needs no library — unlike MP3, which has no browser encoder
// at all and is why lamejs is in the tree.

import {
  box, u32, u16, ascii, stts, stsz, stsc, stco, buildUdta,
} from './remux.js';

// AAC-LC. The `.2` is the audio object type; `mp4a.40.5` (HE-AAC) would halve
// the bitrate but is not something club decks can be relied on to decode.
const CODEC = 'mp4a.40.2';

// One AAC frame. Fixed by the format, and the sample duration every entry in
// the time-to-sample table is built from.
const FRAME = 1024;

/**
 * MPEG-4 descriptors carry a variable-length size: seven bits per byte, with
 * the top bit meaning "another byte follows".
 *
 * An AudioSpecificConfig is two or five bytes, so every length here fits in one
 * — but writing the short form unconditionally is the kind of shortcut that
 * silently produces an unplayable file the first time it doesn't.
 */
function descriptorLength(n) {
  const out = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (out.length) byte |= 0x80;
    out.unshift(byte);
  } while (n > 0);
  return out;
}

const descriptor = (tag, ...payloads) => {
  const body = payloads.flatMap((p) => [...p]);
  return [tag, ...descriptorLength(body.length), ...body];
};

/**
 * The esds box: how a player learns the sample rate, channel count and profile
 * of the AAC inside.
 *
 * `asc` is the AudioSpecificConfig, taken from the encoder's own
 * `decoderConfig.description` rather than assembled by hand. Hand-rolling it
 * from the sample rate and channel count is exactly how you get output that is
 * silent, mono, or plays at the wrong speed — the encoder already knows, so ask
 * it.
 */
function esds(asc, bitrate) {
  return box('esds', u32(0), descriptor(0x03,
    [...u16(0), 0x00],                      // ES_ID 0, no flags
    descriptor(0x04,
      [0x40],                               // MPEG-4 Audio
      [0x15],                               // audio stream
      [0x00, 0x00, 0x00],                   // buffer size — 0 is "unspecified"
      u32(bitrate), u32(bitrate),           // max / average
      descriptor(0x05, asc),
    ),
    descriptor(0x06, [0x02]),               // SLConfig: predefined
  ));
}

/** The mp4a sample entry, describing one audio track's format. */
const mp4a = (channels, sampleRate, asc, bitrate) =>
  box('mp4a',
    [0, 0, 0, 0, 0, 0], u16(1),             // reserved, data reference index
    u16(0), u16(0), u32(0),                 // version, revision, vendor
    u16(channels), u16(16),                 // channel count, sample size
    u16(0), u16(0),                         // predefined, reserved
    // 16.16 fixed point. Rates above 65535 can't be expressed and are written
    // as 0, which is what the spec says to do — the real rate is in mdhd.
    u32(sampleRate < 65536 ? sampleRate << 16 : 0),
    esds(asc, bitrate),
  );

// The unity transform. Required in both mvhd and tkhd even for audio, where
// nothing will ever consult it.
const UNITY_MATRIX = [
  ...u32(0x00010000), ...u32(0), ...u32(0),
  ...u32(0), ...u32(0x00010000), ...u32(0),
  ...u32(0), ...u32(0), ...u32(0x40000000),
];

const mvhd = (timescale, duration) =>
  box('mvhd', u32(0), u32(0), u32(0), u32(timescale), u32(duration),
    u32(0x00010000),                        // rate 1.0
    u16(0x0100),                            // volume 1.0
    u16(0), u32(0), u32(0),                 // reserved
    UNITY_MATRIX,
    ...Array.from({ length: 6 }, () => u32(0)),   // predefined
    u32(2),                                 // next track id
  );

const tkhd = (duration) =>
  box('tkhd', [0, 0, 0, 0x07],              // enabled | in movie | in preview
    u32(0), u32(0), u32(1), u32(0), u32(duration),
    u32(0), u32(0),                         // reserved
    u16(0), u16(0),                         // layer, alternate group
    u16(0x0100), u16(0),                    // volume 1.0, reserved
    UNITY_MATRIX,
    u32(0), u32(0),                         // width, height — audio has neither
  );

const mdhd = (timescale, duration) =>
  box('mdhd', u32(0), u32(0), u32(0), u32(timescale), u32(duration),
    u16(0x55c4),                            // 'und' packed 5 bits per letter
    u16(0),
  );

const hdlr = () =>
  box('hdlr', u32(0), u32(0), ascii('soun'), u32(0), u32(0), u32(0), [0]);

/** Encode an AudioBuffer's channels to AAC frames via WebCodecs. */
async function encodeAac(channels, sampleRate, bitrate) {
  if (typeof AudioEncoder === 'undefined') {
    throw new Error('WebCodecs AudioEncoder unavailable');
  }
  const config = {
    codec: CODEC,
    sampleRate,
    numberOfChannels: channels.length,
    bitrate,
  };
  const { supported } = await AudioEncoder.isConfigSupported(config);
  if (!supported) throw new Error(`AAC encoding unsupported at ${sampleRate}Hz`);

  const frames = [];
  let asc = null;
  let failure = null;

  const encoder = new AudioEncoder({
    output: (chunk, metadata) => {
      // The config arrives with the first chunk and only that one.
      const description = metadata?.decoderConfig?.description;
      if (description && !asc) asc = new Uint8Array(description.slice ? description.slice(0) : description);
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      frames.push(bytes);
    },
    error: (e) => { failure = e; },
  });
  encoder.configure(config);

  // Interleaved because AudioData's f32 planar layout wants one plane per
  // channel contiguously; f32-planar takes exactly that, so no interleave is
  // needed — the channels go in back to back.
  const total = channels[0].length;
  const planar = new Float32Array(total * channels.length);
  channels.forEach((c, i) => planar.set(c, i * total));

  encoder.encode(new AudioData({
    format: 'f32-planar',
    sampleRate,
    numberOfFrames: total,
    numberOfChannels: channels.length,
    timestamp: 0,
    data: planar,
  }));

  await encoder.flush();
  encoder.close();

  if (failure) throw failure;
  if (!frames.length) throw new Error('encoder produced no frames');
  if (!asc) throw new Error('encoder gave no AudioSpecificConfig');
  return { frames, asc };
}

/**
 * Decode anything the browser can read, re-encode as AAC, and wrap it in a
 * standard (non-fragmented) MP4.
 *
 * @param {number} bitrate  256k — the ceiling worth spending on AAC, and what
 *   SoundCloud's own top tier encodes at, so this never looks worse than the
 *   stream it might replace.
 */
export async function toM4a(blob, meta = null, artwork = null, bitrate = 256_000) {
  const bytes = await blob.arrayBuffer();
  // decodeAudioData detaches its input, so pass a copy — the caller still needs
  // the original to fall back to if this throws.
  const ctx = new OfflineAudioContext(2, 1, 44100);
  const decoded = await ctx.decodeAudioData(bytes.slice(0));

  const count = Math.min(decoded.numberOfChannels, 2);
  const channels = [];
  for (let i = 0; i < count; i++) channels.push(decoded.getChannelData(i));

  const { sampleRate } = decoded;
  const { frames, asc } = await encodeAac(channels, sampleRate, bitrate);

  // Every AAC frame is the same 1024 samples, so the sample table is uniform —
  // stts collapses it to a single run.
  const samples = frames.map((f) => ({ size: f.length, duration: FRAME }));
  const duration = frames.length * FRAME;

  const udta = meta ? buildUdta(meta, artwork) : new Uint8Array(0);

  // The mdat offset depends on the moov's size, and the moov contains that
  // offset — circular. Build once with a placeholder to measure, then again
  // with the real value. The size can't change between the two: stco holds a
  // fixed-width u32 either way.
  const build = (chunkOffset) =>
    box('moov',
      mvhd(sampleRate, duration),
      box('trak',
        tkhd(duration),
        box('mdia',
          mdhd(sampleRate, duration),
          hdlr(),
          box('minf',
            box('smhd', u32(0), u16(0), u16(0)),
            box('dinf', box('dref', u32(0), u32(1), box('url ', [0, 0, 0, 1]))),
            box('stbl',
              box('stsd', u32(0), u32(1), mp4a(count, sampleRate, asc, bitrate)),
              stts(samples), stsc(samples.length), stsz(samples), stco(chunkOffset),
            ),
          ),
        ),
      ),
      udta,
    );

  const ftyp = box('ftyp', ascii('M4A '), u32(512), ascii('M4A isomiso2'));
  const probe = build(0);
  const mdatStart = ftyp.length + probe.length + 8;
  const moov = build(mdatStart);

  const audioLength = samples.reduce((a, s) => a + s.size, 0);
  const mdatHeader = new Uint8Array([...u32(audioLength + 8), ...ascii('mdat')]);

  const audio = new Uint8Array(audioLength);
  let w = 0;
  for (const f of frames) { audio.set(f, w); w += f.length; }

  return new Blob([ftyp, moov, mdatHeader, audio], { type: 'audio/mp4' });
}
