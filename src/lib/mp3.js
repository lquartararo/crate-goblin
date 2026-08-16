// MP3 encoding.
//
// The one format the browser can't produce on its own. WebCodecs decodes MP3
// but won't encode it, and WebAudio has no encoder at all, so a lossless source
// bound for an MP3 target has to go through a real encoder — this is the only
// third-party audio code in the project.
//
// The alternatives, and why not:
//
//   ffmpeg.wasm  ~30 MB of binary plus a 'wasm-unsafe-eval' relaxation of the
//                extension CSP, to do one job this does in 460 KB.
//   vmsg         the same LAME encoder, compiled to WASM instead of transpiled
//                — so identical output — but unmaintained, needing that same
//                CSP change, behind an API built for recording a microphone
//                rather than encoding a buffer we already hold. Measured at
//                ~49x realtime here, the speed it would buy back is dwarfed by
//                the time spent downloading the file in the first place.
//   an upload    posting the tracks to a conversion site means handing someone
//                else the music, on a 60 MB round trip per track, in a tool
//                whose whole point is that it runs locally.
//
// LAME is LGPL, which is worth knowing if this ever leaves personal use: it's
// linked, unmodified, and swappable, which is what the licence asks for.

import { Mp3Encoder } from '@breezystack/lamejs';

// LAME's native frame size. Feeding it exactly this keeps it from doing its own
// buffering on top of ours.
const FRAME = 1152;

/** Float -1..1 → signed 16-bit, clipped rather than wrapped. */
function toInt16(src, out) {
  for (let i = 0; i < src.length; i++) {
    const s = src[i] < -1 ? -1 : src[i] > 1 ? 1 : src[i];
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/**
 * Encode raw channel data to MP3 bytes.
 *
 * Takes plain Float32Arrays rather than an AudioBuffer so the same code runs
 * on the main thread and inside the worker — AudioBuffer isn't transferable
 * and doesn't exist in a worker, but its channel arrays are and do.
 *
 * @param {Float32Array[]} channels  mono or stereo; extra channels are dropped
 * @param {number} kbps  320 by default — this is the archival copy of a track
 *   we may not be able to re-acquire, and the size difference against 256 is
 *   irrelevant next to a 60 MB WAV.
 * @returns {Uint8Array}
 */
export function encodeFrames(channels, sampleRate, kbps = 320) {
  // LAME takes mono or stereo only. Anything wider keeps its first two channels
  // rather than being downmixed: club material is effectively never >2ch, and a
  // real downmix needs level compensation we can't verify by ear here.
  const count = Math.min(channels.length, 2);
  const encoder = new Mp3Encoder(count, sampleRate, kbps);

  const left = channels[0];
  const right = count > 1 ? channels[1] : null;

  const l16 = new Int16Array(FRAME);
  const r16 = right ? new Int16Array(FRAME) : null;

  const parts = [];
  let bytes = 0;

  for (let off = 0; off < left.length; off += FRAME) {
    const len = Math.min(FRAME, left.length - off);
    // The final block is short; hand LAME a correctly-sized view rather than a
    // full frame padded with whatever the previous iteration left behind, which
    // would append a burst of stale audio to the end of every track.
    const lc = toInt16(left.subarray(off, off + len), len === FRAME ? l16 : new Int16Array(len));
    const rc = right
      ? toInt16(right.subarray(off, off + len), len === FRAME ? r16 : new Int16Array(len))
      : undefined;

    const chunk = right ? encoder.encodeBuffer(lc, rc) : encoder.encodeBuffer(lc);
    if (chunk.length) { parts.push(chunk); bytes += chunk.length; }
  }

  const tail = encoder.flush();
  if (tail.length) { parts.push(tail); bytes += tail.length; }

  // Copied into one buffer because the chunks LAME returns are views onto a
  // buffer it reuses; holding them past the next call would alias.
  const out = new Uint8Array(bytes);
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}

/** Pull the channel arrays out of a decoded buffer, ready to transfer. */
function channelsOf(buffer) {
  const count = Math.min(buffer.numberOfChannels, 2);
  const out = [];
  for (let i = 0; i < count; i++) {
    // Copied, because getChannelData hands back a live view into the
    // AudioBuffer — transferring that would detach the caller's own audio.
    out.push(new Float32Array(buffer.getChannelData(i)));
  }
  return out;
}

/**
 * Run one encode in a worker, so a multi-minute track doesn't stall the thread
 * the interface is drawing on. Concurrent downloads each get their own worker
 * and land on different cores instead of queueing.
 *
 * Falls back to encoding inline if the worker can't start at all: a frozen
 * interface for a few seconds is a far better outcome than a failed download.
 */
function encodeInWorker(channels, sampleRate, kbps) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('./mp3.worker.js', import.meta.url), { type: 'module' });
    } catch (e) {
      return reject(e);
    }

    worker.onmessage = ({ data }) => {
      worker.terminate();
      data.ok ? resolve(data.bytes) : reject(new Error(data.reason));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'mp3 worker failed'));
    };

    worker.postMessage(
      { channels, sampleRate, kbps },
      channels.map((c) => c.buffer),
    );
  });
}

/** Decode anything the browser can read, then re-encode as MP3. */
export async function toMp3(blob, kbps = 320) {
  const bytes = await blob.arrayBuffer();
  // decodeAudioData detaches its input, so pass a copy — the caller still needs
  // the original to fall back to if this throws.
  const ctx = new OfflineAudioContext(2, 1, 44100);
  const decoded = await ctx.decodeAudioData(bytes.slice(0));

  const channels = channelsOf(decoded);
  const { sampleRate } = decoded;

  let encoded;
  try {
    encoded = await encodeInWorker(channels, sampleRate, kbps);
  } catch {
    // postMessage detaches the channel buffers on the way out, so a worker that
    // died mid-transfer leaves them unusable — re-read from the decoded buffer
    // rather than encoding silence.
    encoded = encodeFrames(channelsOf(decoded), sampleRate, kbps);
  }

  return new Blob([encoded], { type: 'audio/mpeg' });
}
