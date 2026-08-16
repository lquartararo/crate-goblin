// AAC -> PCM (WAV or AIFF), for club hardware you don't control.
//
// The honest case for this: SoundCloud's AAC is standard AAC-LC, which modern
// CDJs handle, but it is also genuinely variable-bitrate — measured on a real
// track, 438 distinct packet sizes ranging 134-722 bytes. VBR AAC is the known
// trigger for stuttering and read errors on older decks, and AAC is variable by
// design, so no stream choice avoids it. Decoding to PCM does.
//
// It does NOT improve the sound. Decoding cannot recover what AAC discarded;
// you get a ~10x larger file that is bit-for-bit the same audio the M4A would
// have decoded to. The gain is compatibility, nothing else.
//
// AIFF is the better default of the two for a DJ library: WAV's tagging is a
// non-standard bolt-on that Rekordbox and Serato handle inconsistently, whereas
// AIFF carries ID3 properly.

// Interleave to clamped 16-bit. Decoded floats can sit fractionally outside
// [-1,1]; letting those wrap produces audible clicks rather than clipping.
function interleave16(buffer) {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const out = new Int16Array(frames * channels);
  const chans = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));

  let p = 0;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      out[p++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
  }
  return out;
}

// ------------------------------------------------------------------- WAV

export function encodeWav(buffer) {
  const samples = interleave16(buffer);
  const blockAlign = buffer.numberOfChannels * 2;
  const dataBytes = samples.length * 2;

  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  let p = 0;
  const str = (s) => { for (const ch of s) view.setUint8(p++, ch.charCodeAt(0)); };
  const u32 = (v) => { view.setUint32(p, v, true); p += 4; };
  const u16 = (v) => { view.setUint16(p, v, true); p += 2; };

  str('RIFF'); u32(36 + dataBytes); str('WAVE');
  str('fmt '); u32(16); u16(1); u16(buffer.numberOfChannels);
  u32(buffer.sampleRate); u32(buffer.sampleRate * blockAlign); u16(blockAlign); u16(16);
  str('data'); u32(dataBytes);

  // Int16Array is little-endian on every platform this runs on, matching WAV.
  return new Blob([header, samples.buffer], { type: 'audio/wav' });
}

// ------------------------------------------------------------------ AIFF

// AIFF stores the sample rate as an 80-bit IEEE 754 extended float, which has
// no native JS equivalent — hence the manual exponent/mantissa split.
function extendedFloat80(rate) {
  const out = new Uint8Array(10);
  if (rate <= 0) return out;

  const exponent = Math.floor(Math.log2(rate));
  const mantissa = rate / 2 ** exponent; // normalised to [1, 2)
  const biased = exponent + 16383;

  out[0] = (biased >> 8) & 0xff;
  out[1] = biased & 0xff;

  // 64-bit mantissa with the leading 1 stored explicitly, big-endian.
  let m = BigInt(Math.round(mantissa * 2 ** 63));
  for (let i = 9; i >= 2; i--) {
    out[i] = Number(m & 0xffn);
    m >>= 8n;
  }
  return out;
}

export function encodeAiff(buffer) {
  const samples = interleave16(buffer);
  const frames = buffer.length;
  const channels = buffer.numberOfChannels;
  const dataBytes = samples.length * 2;

  // AIFF is big-endian; Int16Array is not. Swap into a byte view.
  const be = new Uint8Array(dataBytes);
  for (let i = 0; i < samples.length; i++) {
    be[i * 2] = (samples[i] >> 8) & 0xff;
    be[i * 2 + 1] = samples[i] & 0xff;
  }

  const header = new ArrayBuffer(54);
  const view = new DataView(header);
  let p = 0;
  const str = (s) => { for (const ch of s) view.setUint8(p++, ch.charCodeAt(0)); };
  const u32 = (v) => { view.setUint32(p, v); p += 4; }; // big-endian
  const u16 = (v) => { view.setUint16(p, v); p += 2; };

  str('FORM'); u32(46 + dataBytes); str('AIFF');

  str('COMM'); u32(18);
  u16(channels); u32(frames); u16(16);
  for (const b of extendedFloat80(buffer.sampleRate)) view.setUint8(p++, b);

  str('SSND'); u32(dataBytes + 8); u32(0); u32(0); // offset, blockSize

  return new Blob([header, be], { type: 'audio/aiff' });
}

// ---------------------------------------------------------------- decode

/**
 * Decode an encoded blob (fragmented or standard MP4) and re-emit as PCM.
 * Decoding runs at the source's own rate — an AudioContext pinned to 44100
 * would silently resample anything that isn't.
 */
export async function toPcm(blob, format = 'aiff') {
  const bytes = await blob.arrayBuffer();

  // decodeAudioData detaches its input, so pass a copy: callers still need the
  // original blob to fall back to M4A if this throws.
  const ctx = new OfflineAudioContext(2, 1, 44100);
  const decoded = await ctx.decodeAudioData(bytes.slice(0));

  return format === 'wav' ? encodeWav(decoded) : encodeAiff(decoded);
}
