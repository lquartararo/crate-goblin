// MP3 encoding, off the main thread.
//
// The encode is a tight synchronous loop over every sample in the track — for a
// 6-minute WAV that's ~8 seconds during which nothing else on the thread runs.
// In the panel that freezes the interface mid-crate; worse, the pool downloads
// several tracks at once, so the blocks queue up behind each other on the one
// thread instead of overlapping.
//
// Only the encode moves. Decoding needs an OfflineAudioContext, which workers
// don't have — and it's already asynchronous and off-thread internally, so it
// was never what stalled things.

import { encodeFrames } from './mp3.js';

self.onmessage = ({ data }) => {
  const { channels, sampleRate, kbps } = data;
  try {
    const bytes = encodeFrames(channels, sampleRate, kbps);
    // Transferred, not copied — the encoded track is megabytes and this is the
    // last thing either side does with the buffer.
    self.postMessage({ ok: true, bytes }, [bytes.buffer]);
  } catch (e) {
    self.postMessage({ ok: false, reason: e.message });
  }
};
