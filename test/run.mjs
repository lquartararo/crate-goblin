// Test suite. Run with: node test/run.mjs
//
// These cover the parts that fail *silently* — a remuxer that drops samples, a
// tag that a parser skips, routing that loses a track on a fallback. Nothing
// here needs network or a browser; the browser APIs are mocked below.

import { strict as assert } from 'node:assert';

let passed = 0, failed = 0;
const results = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    results.push(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    results.push(`  FAIL  ${name}\n        ${e.message}`);
  }
}

// ----------------------------------------------------------- browser mocks

const saved = [];
globalThis.chrome = {
  storage: {
    local: {
      _d: {},
      async get(k) { return typeof k === 'string' ? { [k]: this._d[k] } : { ...this._d }; },
      async set(o) { Object.assign(this._d, o); },
      async remove(k) { delete this._d[k]; },
    },
  },
  cookies: { get: async () => ({ value: 'tok' }) },
  runtime: { lastError: null, sendMessage: async () => ({ ok: false, reason: 'no gate' }) },
  downloads: { download: (o, cb) => { saved.push(o.filename); cb(1); } },
};
globalThis.URL.createObjectURL = () => 'blob:mock';
globalThis.URL.revokeObjectURL = () => {};

const { buildId3 } = await import('../src/lib/id3.js');
const { pool } = await import('../src/lib/pool.js');
const { classify, isPreviewOnly, isAutomatable, BUCKET } = await import('../src/lib/triage.js');
const { rankTranscodings } = await import('../src/lib/hls.js');
const { encodeWav, encodeAiff } = await import('../src/lib/pcm.js');

// ------------------------------------------------------------------- id3

const find = (buf, str) => buf.indexOf(Buffer.from(str, 'latin1'));

await test('id3: header is ID3v2.3 with synchsafe size', () => {
  const tag = Buffer.from(buildId3({ title: 'x' }));
  assert.equal(tag.subarray(0, 3).toString(), 'ID3');
  assert.equal(tag[3], 3, 'major version 3');
  for (const b of tag.subarray(6, 10)) assert.ok(b < 0x80, 'size bytes must be synchsafe');
});

await test('id3: size field matches actual frame bytes', () => {
  const tag = Buffer.from(buildId3({ title: 'hello', artist: 'someone' }));
  const size = (tag[6] << 21) | (tag[7] << 14) | (tag[8] << 7) | tag[9];
  assert.equal(size, tag.length - 10);
});

await test('id3: COMM carries a language code, not a bare BOM', () => {
  const tag = Buffer.from(buildId3({ comment: 'hi' }));
  const at = find(tag, 'COMM');
  assert.ok(at > 0, 'COMM frame present');
  // frame header is 10 bytes, then encoding byte, then 3-char language
  assert.equal(tag.subarray(at + 11, at + 14).toString(), 'eng');
});

await test('id3: non-Latin text survives as UTF-16 with BOM', () => {
  const tag = Buffer.from(buildId3({ title: 'Nếu Em' }));
  const at = find(tag, 'TIT2');
  assert.equal(tag[at + 10], 0x01, 'UTF-16 encoding byte');
  assert.equal(tag[at + 11], 0xff, 'BOM low');
  assert.equal(tag[at + 12], 0xfe, 'BOM high');
});

await test('id3: empty fields emit no frame', () => {
  const tag = Buffer.from(buildId3({ title: 'x', artist: null, genre: undefined }));
  assert.equal(find(tag, 'TPE1'), -1);
  assert.equal(find(tag, 'TCON'), -1);
});

// ------------------------------------------------------------------ pool

await test('pool: preserves input order under concurrency', async () => {
  const out = await pool([5, 1, 4, 2, 3], 3, async (n) => {
    await new Promise((r) => setTimeout(r, n * 5));
    return n;
  });
  assert.deepEqual(out.map((r) => r.value), [5, 1, 4, 2, 3]);
});

await test('pool: one thrown worker does not abandon the queue', async () => {
  const out = await pool([1, 2, 3], 2, async (n) => {
    if (n === 2) throw new Error('boom');
    return n;
  });
  assert.equal(out.filter((r) => r.ok).length, 2);
  assert.equal(out[1].ok, false);
});

await test('pool: respects the concurrency limit', async () => {
  let live = 0, peak = 0;
  await pool([1, 2, 3, 4, 5, 6, 7, 8], 3, async () => {
    peak = Math.max(peak, ++live);
    await new Promise((r) => setTimeout(r, 10));
    live--;
  });
  assert.ok(peak <= 3, `peak concurrency ${peak} exceeded limit`);
});

// ---------------------------------------------------------------- triage

await test('triage: a free original outranks a gate', () => {
  const t = classify({ downloadable: true, has_downloads_left: true, purchase_url: 'https://hypeddit.com/x' });
  assert.equal(t.bucket, BUCKET.FREE);
});

await test('triage: hypeddit is a gate, bandcamp is a store', () => {
  assert.equal(classify({ purchase_url: 'https://hypeddit.com/a' }).kind, 'gate');
  assert.equal(classify({ purchase_url: 'https://x.bandcamp.com/track/a' }).kind, 'store');
});

await test('triage: itunes and smart-links are not unlock-able gates', () => {
  // Seen on a real label EP: every purchase_url was smarturl.it or iTunes.
  // Running the unlock automation at a checkout page can only ever waste time.
  assert.equal(classify({ purchase_url: 'https://itunes.apple.com/album/x' }).kind, 'store');
  assert.equal(classify({ purchase_url: 'https://smarturl.it/abc' }).kind, 'smartlink');
  assert.equal(isAutomatable({ bucket: BUCKET.GATED, kind: 'store' }), false);
  assert.equal(isAutomatable({ bucket: BUCKET.GATED, kind: 'smartlink' }), false);
  assert.equal(isAutomatable({ bucket: BUCKET.GATED, kind: 'gate' }), true);
});

await test('triage: SNIP policy alone must not mark preview-only', () => {
  // A Go+ session sees policy SNIP with full, unsnipped transcodings.
  assert.equal(isPreviewOnly({
    policy: 'SNIP', duration: 211905, full_duration: 211905,
    media: { transcodings: [{ snipped: false }] },
  }), false);
});

await test('triage: all-snipped transcodings do mark preview-only', () => {
  assert.equal(isPreviewOnly({
    policy: 'SNIP', duration: 30000, full_duration: 211905,
    media: { transcodings: [{ snipped: true }, { snipped: true }] },
  }), true);
});

// ------------------------------------------------------------ transcoding

const track = {
  media: { transcodings: [
    { preset: 'abr_sq', format: { protocol: 'hls', mime_type: 'audio/mpegurl' } },
    { preset: 'aac_160k', format: { protocol: 'hls', mime_type: 'audio/mp4' } },
    { preset: 'mp3_0_0', format: { protocol: 'progressive', mime_type: 'audio/mpeg' } },
  ] },
};

await test('transcoding: anonymous avoids abr_sq (it 404s without auth)', () => {
  assert.equal(rankTranscodings(track, { authenticated: false })[0].preset, 'aac_160k');
});

await test('transcoding: authenticated prefers abr_sq for Go+ 256k', () => {
  assert.equal(rankTranscodings(track, { authenticated: true })[0].preset, 'abr_sq');
});

await test('transcoding: mp3 request picks the progressive stream', () => {
  assert.equal(rankTranscodings(track, { preferAac: false })[0].format.protocol, 'progressive');
});

await test('transcoding: DRM variants are dropped, not returned', () => {
  const drm = { media: { transcodings: [{ preset: 'x', format: { protocol: 'ctr-encrypted-hls' } }] } };
  assert.equal(rankTranscodings(drm).length, 0);
});

// ------------------------------------------------------------------- pcm

const tone = (() => {
  const rate = 44100, frames = 4410;
  const ch = new Float32Array(frames);
  for (let i = 0; i < frames; i++) ch[i] = Math.sin((2 * Math.PI * 440 * i) / rate) * 0.5;
  return { numberOfChannels: 2, sampleRate: rate, length: frames, getChannelData: () => ch };
})();

await test('pcm: WAV declares format tag 1, not EXTENSIBLE', async () => {
  const b = Buffer.from(await encodeWav(tone).arrayBuffer());
  assert.equal(b.readUInt16LE(20), 1, 'WAVE_FORMAT_PCM');
  assert.equal(b.readUInt32LE(16), 16, 'canonical fmt chunk');
});

await test('pcm: WAV carries only fmt and data chunks', async () => {
  const b = Buffer.from(await encodeWav(tone).arrayBuffer());
  assert.equal(b.subarray(12, 16).toString(), 'fmt ');
  assert.equal(b.subarray(36, 40).toString(), 'data');
});

await test('pcm: AIFF encodes 44100 as an 80-bit extended float', async () => {
  const b = Buffer.from(await encodeAiff(tone).arrayBuffer());
  const at = b.indexOf(Buffer.from('COMM')) + 8;
  const exp = b.readUInt16BE(at + 8) - 16383;
  const mantissa = Number(b.readBigUInt64BE(at + 10)) / 2 ** 63;
  assert.equal(Math.round(mantissa * 2 ** exp), 44100);
});

await test('pcm: AIFF FORM size matches the real byte length', async () => {
  const b = Buffer.from(await encodeAiff(tone).arrayBuffer());
  assert.equal(b.readUInt32BE(4), b.length - 8);
});

// --------------------------------------------------------------- limiter

const { createLimiter } = await import('../src/lib/limiter.js');

await test('limiter: cap is shared across separate callers', async () => {
  // Two "batches" started independently must still total 4 in flight — the
  // rate limit is on the account, not the batch.
  const limit = createLimiter(4);
  let live = 0, peak = 0;
  const job = () => limit(async () => {
    peak = Math.max(peak, ++live);
    await new Promise((r) => setTimeout(r, 12));
    live--;
  });
  await Promise.all([
    Promise.all(Array.from({ length: 6 }, job)),
    Promise.all(Array.from({ length: 6 }, job)),
  ]);
  assert.ok(peak <= 4, `peak ${peak} exceeded the shared cap`);
});

await test('limiter: a rejected job still frees its slot', async () => {
  const limit = createLimiter(1);
  await limit(async () => { throw new Error('boom'); }).catch(() => {});
  // If the slot leaked, this never resolves.
  const after = await Promise.race([
    limit(async () => 'ran'),
    new Promise((r) => setTimeout(() => r('deadlocked'), 200)),
  ]);
  assert.equal(after, 'ran');
});

// --------------------------------------------------------------- tagread

const { readExistingTags } = await import('../src/lib/tagread.js');

await test('tagread: finds the fields an ID3 tag already carries', async () => {
  const tag = buildId3({ title: 'x', artist: 'y' });
  const present = await readExistingTags(new Blob([tag]), 'mp3');
  assert.ok(present.has('title'));
  assert.ok(present.has('artist'));
  assert.ok(!present.has('album'), 'must not claim a field that was never written');
});

await test('tagread: an untagged file reports nothing', async () => {
  const present = await readExistingTags(new Blob([new Uint8Array(2048)]), 'mp3');
  assert.equal(present.size, 0);
});

await test('tagread: unknown container reports nothing rather than guessing', async () => {
  const present = await readExistingTags(new Blob([new Uint8Array(64)]), 'wav');
  assert.equal(present.size, 0);
});

const { mergeWithExisting } = await import('../src/lib/tag.js');

await test('merge: never overwrites a tag the file already has', async () => {
  // A master from the artist is usually tagged properly, and SoundCloud's
  // title would replace it with "… (FREE DOWNLOAD)".
  const tagged = new Blob([buildId3({ title: 'Clean Title', artist: 'Real Artist' })]);
  const { meta } = await mergeWithExisting(tagged, 'mp3',
    { title: 'Messy (FREE DOWNLOAD)', artist: 'promo channel', genre: 'Techno' }, null);
  assert.equal(meta.title, undefined, 'existing title must survive');
  assert.equal(meta.artist, undefined, 'existing artist must survive');
  assert.equal(meta.genre, 'Techno', 'missing field should still be filled');
});

await test('merge: writes everything when the file has no tags', async () => {
  const { meta } = await mergeWithExisting(new Blob([new Uint8Array(1024)]), 'mp3',
    { title: 'T', artist: 'A' }, null);
  assert.equal(meta.title, 'T');
  assert.equal(meta.artist, 'A');
});

await test('merge: keeps existing artwork rather than replacing it', async () => {
  const withArt = new Blob([buildId3({ title: 'x' }, { mime: 'image/jpeg', bytes: new Uint8Array(600) })]);
  const { artwork } = await mergeWithExisting(withArt, 'mp3', { genre: 'g' }, { mime: 'image/jpeg', bytes: new Uint8Array(10) });
  assert.equal(artwork, null);
});

// ------------------------------------------------------- metadata honesty

const { summarize } = await import('../src/lib/triage.js');

await test('metadata: upload date is never used as the release year', async () => {
  // created_at is when it was posted. For a back-catalogue upload that can be
  // years out, and a confident wrong year propagates into the library.
  const row = summarize({ id: 1, created_at: '2024-01-01T00:00:00Z', title: 't' });
  assert.equal(row.year, null);
});

await test('metadata: release_date is used when stated', async () => {
  const row = summarize({ id: 1, release_date: '2017-09-26T00:00:00Z', title: 't' });
  assert.equal(row.year, '2017');
});

await test('metadata: album only comes from a real album', async () => {
  assert.equal(summarize({ id: 1, title: 't' }, {}).album, null);
  assert.equal(summarize({ id: 1, title: 't' }, { album: 'Real Album' }).album, 'Real Album');
});

await test('metadata: declared artist beats the uploading account', async () => {
  const row = summarize({
    id: 1, title: 't',
    publisher_metadata: { artist: 'Actual Artist' },
    user: { username: 'Promo Channel' },
  });
  assert.equal(row.artist, 'Actual Artist');
  assert.equal(row.artistDeclared, true);
});

await test('metadata: falls back to the account, but marks it undeclared', async () => {
  const row = summarize({ id: 1, title: 't', user: { username: 'Some Uploader' } });
  assert.equal(row.artist, 'Some Uploader');
  assert.equal(row.artistDeclared, false);
});

// ------------------------------------------------------------ url classify

// Aliased: `classify` is already taken by triage.js's bucket classifier.
const { isTrackPath, isCratePath, classify: classifyUrl } = await import('../src/lib/paths.js');

// These four were all misclassified when the logic lived inside content.js:
// /feed offered "Triage crate" on a feed of unrelated crates, and the rest were
// read as track permalinks because the first segment isn't always a username.
for (const [path, why] of [
  ['/feed', 'a feed of many crates, not one'],
  ['/discover', "SoundCloud's own route"],
  ['/you/library', "'you' is not a user"],
  ['/charts/top', "'charts' is not a user"],
]) {
  await test(`paths: ${path} is neither track nor crate — ${why}`, () => {
    assert.equal(isTrackPath(path), false);
    assert.equal(isCratePath(path), false);
  });
}

await test('paths: a real track permalink is a track', () => {
  assert.equal(isTrackPath('/sumantclub/my-track'), true);
  assert.equal(isCratePath('/sumantclub/my-track'), false);
});

await test('paths: profiles, tabs and playlists are crates', () => {
  for (const p of ['/sumantclub', '/sumantclub/tracks', '/sumantclub/albums', '/sumantclub/sets/remixes']) {
    assert.equal(isCratePath(p), true, `${p} should be a crate`);
    assert.equal(isTrackPath(p), false, `${p} should not be a track`);
  }
});

await test('paths: a user sub-listing is not a single track', () => {
  // /user/likes has two segments but is a listing, not a permalink.
  assert.equal(isTrackPath('/sumantclub/likes'), false);
});

await test('paths: classify only accepts soundcloud.com', () => {
  assert.equal(classifyUrl('https://soundcloud.com/sumantclub/sets/remixes'), 'crate');
  assert.equal(classifyUrl('https://soundcloud.com/sumantclub/my-track'), 'track');
  assert.equal(classifyUrl('https://example.com/sumantclub/my-track'), null);
  assert.equal(classifyUrl('not a url'), null);
});

await test('paths: crateKind separates a playlist from a profile', async () => {
  const { crateKind } = await import('../src/lib/paths.js');

  // Only /sets/ is a playlist. Everything else with a track list is a profile
  // or one of its tabs, and calling those "playlist" on the button read wrong.
  assert.equal(crateKind('/sumantclub/sets/summer-2026'), 'playlist');
  assert.equal(crateKind('/sumantclub'), 'profile');
  assert.equal(crateKind('/sumantclub/tracks'), 'profile');
  assert.equal(crateKind('/sumantclub/albums'), 'profile');
  assert.equal(crateKind('/sumantclub/sets'), 'profile');   // the tab, not a set

  // Not crates at all — the button doesn't mount, so there is no kind.
  assert.equal(crateKind('/sumantclub/my-track'), null);
  assert.equal(crateKind('/discover'), null);
  assert.equal(crateKind('/you/library'), null);
});

// ------------------------------------------------------------- host seam

const { setHost, host } = await import('../src/lib/host.js');

await test('host: pipeline works with no chrome.* at all', async () => {
  // Exactly the offscreen document's situation: chrome.runtime only. Before the
  // seam existed the first storage read threw "Cannot read properties of
  // undefined (reading 'local')" and the download died there.
  const store = new Map();
  const saves = [];
  setHost({
    getStored: async (k) => store.get(k),
    setStored: async (k, v) => void store.set(k, v),
    oauthToken: async () => 'token-from-worker',
    save: async (_blob, name) => void saves.push(name),
  });

  await host.setStored('clientId', 'abc123');
  assert.equal(await host.getStored('clientId'), 'abc123', 'storage went through the injected host');
  assert.ok(store.has('clientId'), 'and never touched chrome.storage');

  await host.save(null, 'x.aiff');
  assert.deepEqual(saves, ['x.aiff']);
  assert.equal(await host.oauthToken(), 'token-from-worker');
});

await test('host: overrides are partial, not wholesale replacement', async () => {
  const store = new Map();
  setHost({ getStored: async (k) => store.get(k), setStored: async (k, v) => void store.set(k, v) });
  // `oauthToken` was not overridden, so it falls back to the direct
  // implementation — which reaches chrome.cookies, mocked at the top of this file.
  assert.equal(await host.oauthToken(), 'tok');
});

// ------------------------------------------------- filename reaches the disk

// Every one-click download was landing as a bare uuid — `adac74d0-….mp3` —
// which is the shape URL.createObjectURL produces, so the name was being lost
// somewhere between the pipeline and chrome.downloads rather than computed
// wrong. This runs the real routing with the host seam standing in for the
// browser, and asserts on what `save` is actually handed.

const TRACK = {
  id: 1604612526,
  title: 'Skrillex & Damian Marley - Make It Bun Dem (Pablito Mix, City Lights & HSTN Cumbiaton Remix)',
  user: { username: 'PABLITO MIX' },
  publisher_metadata: { artist: 'Pablito Mix' },
  artwork_url: 'https://i1.sndcdn.com/artworks-x-large.jpg',
  duration: 210_000,
  full_duration: 210_000,
  genre: 'Electronic',
  downloadable: false,
  has_downloads_left: false,
  purchase_url: null,
  purchase_title: null,
  license: 'all-rights-reserved',
  permalink_url: 'https://soundcloud.com/pablitomix/make-it-bun-dem-cumbiaton-remix',
  display_date: '2024-01-01T00:00:00Z',
  release_date: null,
  download_count: 0,
  media: {
    transcodings: [{
      url: 'https://api-v2.soundcloud.com/media/soundcloud:tracks:1/x/stream/progressive',
      preset: 'mp3_1_0',
      snipped: false,
      format: { protocol: 'progressive', mime_type: 'audio/mpeg' },
    }],
  },
};

await test('download: the computed filename is what reaches save()', async () => {
  const { triage } = await import('../src/lib/triage.js');
  const { downloadRow } = await import('../src/lib/download.js');

  const row = triage([TRACK], { album: null }).rows[0];

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    // Artwork: refuse it, so the assertion is about naming, not tagging.
    if (u.includes('sndcdn.com/artworks')) return { ok: false, status: 404 };
    // Resolving the transcoding hands back the signed media URL.
    if (u.includes('/stream/progressive')) {
      return { ok: true, status: 200, json: async () => ({ url: 'https://cf-media.sndcdn.com/abc.128.mp3' }) };
    }
    // The audio itself — a valid-enough MP3 frame header for the tagger.
    const bytes = new Uint8Array(4096);
    bytes[0] = 0xff; bytes[1] = 0xfb;
    return { ok: true, status: 200, url: u, headers: new Map(), blob: async () => new Blob([bytes], { type: 'audio/mpeg' }) };
  };

  const saves = [];
  setHost({
    getStored: async () => 'client-id',
    setStored: async () => {},
    oauthToken: async () => null,
    save: async (_blob, name) => void saves.push(name),
  });

  try {
    await downloadRow(row, TRACK, { mode: 'stream', container: 'mp3' }, () => {});
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(saves.length, 1, 'exactly one file was saved');
  assert.ok(saves[0], 'save() was given a name at all, not undefined');
  assert.ok(
    !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(saves[0]),
    `save() got a uuid instead of a title: ${saves[0]}`,
  );
  assert.equal(
    saves[0],
    // The remix rule in naming.js moved the credit: Pablito Mix is named inside
    // the version parenthetical, so they are the remixer and the act is the one
    // before the dash. Previously this filed under "Pablito Mix - Skrillex &
    // Damian Marley - …", which buried the record under its remixer.
    'Skrillex & Damian Marley - Make It Bun Dem (Pablito Mix, City Lights & HSTN Cumbiaton Remix).mp3',
  );
});

// --------------------------------------------------------------- m4a mux

// A container that lies about its contents fails at the CDJ, not here — so the
// box tree gets walked rather than trusted. Asking for m4a from a lossless
// source used to write AIFF audio into a .m4a file; this is the replacement.

function walkBoxes(bytes, start = 0, end = bytes.length) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    const size = dv.getUint32(p);
    const type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
    if (size < 8 || p + size > end) break;
    out.push({ type, start: p, size, body: p + 8 });
    p += size;
  }
  return out;
}

function findBox(bytes, path) {
  let list = walkBoxes(bytes);
  let hit = null;
  for (const want of path) {
    hit = list.find((b) => b.type === want);
    if (!hit) return null;
    // Containers whose payload begins with a fixed header need it skipped.
    const skip = hit.type === 'stsd' ? 8 : hit.type === 'mp4a' ? 28 : 0;
    list = walkBoxes(bytes, hit.body + skip, hit.start + hit.size);
  }
  return hit;
}

await test('m4a: encodes AAC into a well-formed MP4', async () => {
  const RATE = 44100, FRAMES = 7, ASC = new Uint8Array([0x12, 0x10]);

  // Stub the browser codec surface. The muxing is ours and is what's under
  // test; the encoder is Chrome's and can't run here.
  globalThis.OfflineAudioContext = class {
    async decodeAudioData() {
      return {
        sampleRate: RATE,
        numberOfChannels: 2,
        length: FRAMES * 1024,
        getChannelData: () => new Float32Array(FRAMES * 1024),
      };
    }
  };
  globalThis.AudioData = class { constructor(init) { Object.assign(this, init); } };
  globalThis.AudioEncoder = class {
    static async isConfigSupported() { return { supported: true }; }
    constructor({ output }) { this.output = output; }
    configure() {}
    encode() {
      for (let i = 0; i < FRAMES; i++) {
        this.output(
          { byteLength: 100, copyTo: (b) => b.fill(i + 1) },
          i === 0 ? { decoderConfig: { description: ASC } } : {},
        );
      }
    }
    async flush() {}
    close() {}
  };

  const { toM4a } = await import('../src/lib/aac.js');
  const blob = await toM4a(new Blob([new Uint8Array(64)]), null, null);
  const bytes = new Uint8Array(await blob.arrayBuffer());

  assert.equal(blob.type, 'audio/mp4');

  const top = walkBoxes(bytes).map((b) => b.type);
  assert.deepEqual(top, ['ftyp', 'moov', 'mdat'], `top-level boxes: ${top}`);

  for (const path of [
    ['moov', 'mvhd'], ['moov', 'trak', 'tkhd'], ['moov', 'trak', 'mdia', 'mdhd'],
    ['moov', 'trak', 'mdia', 'hdlr'], ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'],
  ]) {
    assert.ok(findBox(bytes, path), `missing ${path.join('/')}`);
  }

  // esds carries the AudioSpecificConfig; without it a player has no idea what
  // rate or channel count the AAC is, which is the silent-output failure.
  const stsd = findBox(bytes, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd']);
  const inStsd = walkBoxes(bytes, stsd.body + 8, stsd.start + stsd.size);
  assert.equal(inStsd[0]?.type, 'mp4a', 'stsd holds an mp4a entry');
  const esds = walkBoxes(bytes, inStsd[0].body + 28, inStsd[0].start + inStsd[0].size)
    .find((b) => b.type === 'esds');
  assert.ok(esds, 'mp4a holds an esds');
  assert.ok(
    bytes.subarray(esds.body, esds.start + esds.size).join(',').includes(ASC.join(',')),
    'esds embeds the encoder-supplied AudioSpecificConfig',
  );

  // The chunk offset is written before the moov's final size is known, so it is
  // built twice. If those two passes ever differ in length this points at the
  // wrong byte and every player reads garbage.
  const stco = findBox(bytes, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stco']);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = dv.getUint32(stco.body + 8);
  const mdat = walkBoxes(bytes).find((b) => b.type === 'mdat');
  assert.equal(offset, mdat.body, 'stco points at the first byte of mdat audio');

  // Sample sizes must add up to what is actually in mdat.
  const stsz = findBox(bytes, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsz']);
  assert.equal(dv.getUint32(stsz.body + 8), FRAMES, 'stsz counts every frame');
  assert.equal(mdat.size - 8, FRAMES * 100, 'mdat holds exactly the encoded frames');
});

// ------------------------------------------------------------ self-update

await test('update: version comparison decides correctly', async () => {
  const { compareVersions } = await import('../src/lib/update.js');

  assert.equal(compareVersions('0.3.0', '0.2.0'), 1, 'newer minor');
  assert.equal(compareVersions('0.2.0', '0.3.0'), -1);
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0, 'equal must not reload');

  // Ragged lengths: 0.3 and 0.3.0 are the same version, and treating the
  // missing field as anything but zero would reload forever.
  assert.equal(compareVersions('0.3', '0.3.0'), 0);
  assert.equal(compareVersions('0.3.1', '0.3'), 1);

  // Numeric, not lexicographic — "10" sorts before "9" as a string.
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1, 'double digits');

  // Garbage must be inert rather than triggering an update.
  assert.equal(compareVersions('nonsense', '0.2.0'), 0);
  assert.equal(compareVersions(undefined, '0.2.0'), 0);
});

await test('update: refuses to reload into a half-built manifest', async () => {
  const { looksLoadable } = await import('../src/lib/update.js');

  const good = {
    manifest_version: 3,
    version: '0.3.0',
    background: { service_worker: 'src/background.js' },
    side_panel: { default_path: 'src/panel/panel.html' },
  };
  assert.equal(looksLoadable(good), true);

  // Each of these is a build that pushed but wouldn't load — the failure lands
  // on someone else's machine with no obvious cause, so a version bump alone
  // must not be enough to act on.
  assert.equal(looksLoadable({ ...good, background: undefined }), false, 'no worker');
  assert.equal(looksLoadable({ ...good, side_panel: undefined }), false, 'no panel');
  assert.equal(looksLoadable({ ...good, version: undefined }), false, 'no version');
  assert.equal(looksLoadable({ ...good, manifest_version: 2 }), false, 'wrong mv');
  assert.equal(looksLoadable(null), false);
});

// --------------------------------------------------------------- naming

await test('naming: strips promo brackets, keeps everything else', async () => {
  const { cleanTitle } = await import('../src/lib/naming.js');

  assert.equal(cleanTitle('Libak Budots (FREE DOWNLOAD)'), 'Libak Budots');
  assert.equal(cleanTitle('Libak Budots [Free DL]'), 'Libak Budots');
  assert.equal(cleanTitle('Vidrado **FREE DOWNLOAD**'), 'Vidrado **FREE DOWNLOAD**',
    'no brackets, no pipe: left alone rather than guessed at');
  assert.equal(cleanTitle('Papap Dol (buy = free download)'), 'Papap Dol');
  assert.equal(cleanTitle('Papap Dol | free download'), 'Papap Dol');

  // Load-bearing parentheses. Every one of these changes which record it is.
  const keep = [
    'Make It Bun Dem (Pablito Mix, City Lights & HSTN Cumbiaton Remix)',
    'Arizona B (Radio Edit)',
    'Vidrado (Extended Mix)',
    'Libak (VIP)',
    'Isaw (feat. DJ Love (Sherwin Tuna))',
    'Ice Cream Yummy (Original Mix)',
    'Papap Dol (Premiere)',
  ];
  for (const t of keep) assert.equal(cleanTitle(t), t, `must keep: ${t}`);

  // Words that merely contain the promo words.
  assert.equal(cleanTitle('Free'), 'Free');
  assert.equal(cleanTitle('Freefall (Original Mix)'), 'Freefall (Original Mix)');
  assert.equal(cleanTitle('Download (Club Edit)'), 'Download (Club Edit)');

  // A title that is nothing but promo keeps it: empty is worse than silly.
  assert.equal(cleanTitle('(FREE DOWNLOAD)'), '(FREE DOWNLOAD)');
  assert.equal(cleanTitle(''), '');
  assert.equal(cleanTitle(null), '');
});

await test('naming: splits artist from title only when corroborated', async () => {
  const { splitArtistTitle } = await import('../src/lib/naming.js');

  // Duplicated prefix: unambiguous, so it goes.
  assert.deepEqual(
    splitArtistTitle({ title: 'Pablito Mix - Vidrado', artist: 'Pablito Mix', artistDeclared: true }),
    { artist: 'Pablito Mix', title: 'Vidrado', split: 'prefix' });

  // Declared artist named inside a version parenthetical is the REMIXER, so the
  // act is whoever sits before the dash. This is the Beatport/Rekordbox
  // convention and it's what you'd actually search the library for.
  assert.deepEqual(
    splitArtistTitle({
      title: 'Skrillex & Damian Marley - Make It Bun Dem (Pablito Mix Remix)',
      artist: 'Pablito Mix', artistDeclared: true }),
    { artist: 'Skrillex & Damian Marley',
      title: 'Make It Bun Dem (Pablito Mix Remix)', split: 'remix' });

  // But only when it's the *declared* artist in there. Someone else's name in
  // the remix bracket means the declared artist really is the act.
  assert.deepEqual(
    splitArtistTitle({ title: 'Artist X - Track (Other Guy Remix)',
                       artist: 'Artist X', artistDeclared: true }),
    { artist: 'Artist X', title: 'Track (Other Guy Remix)', split: 'prefix' });

  // "feat." is not a version marker, so it must not trigger the remix path.
  const feat = splitArtistTitle({
    title: 'Real Act - Song (feat. Guest Name)', artist: 'Guest Name', artistDeclared: true });
  assert.notEqual(feat.split, 'remix', 'a feature credit is not a remix credit');

  // Nothing declared: read the credit out of the title.
  assert.deepEqual(
    splitArtistTitle({ title: 'DJ KRZ - Libak Budots', artist: 'Some Promo Channel', artistDeclared: false }),
    { artist: 'DJ KRZ', title: 'Libak Budots', split: 'title' });

  // Refusals. Each of these would lose or scramble something.
  const refuse = [
    ['Foo (Live - 2019) - Bar', 'bracket left of the dash'],
    ['A Very Long Sequence Of Words That Is Clearly Not An Artist Name - X', 'too many words'],
    ['01 - Some Track', 'tracklist number'],
    ['NoDashHereAtAll', 'nothing to split'],
  ];
  for (const [title, why] of refuse) {
    const r = splitArtistTitle({ title, artist: 'Channel', artistDeclared: false });
    assert.equal(r.split, null, `must refuse (${why}): ${title}`);
    assert.equal(r.title, title, `and must keep the title intact: ${title}`);
  }

  // Hyphenated names must not be mistaken for a separator: the split needs
  // spaces around the dash.
  const h = splitArtistTitle({ title: 'Jean-Michel Jarre', artist: '', artistDeclared: false });
  assert.equal(h.split, null);
  assert.equal(h.title, 'Jean-Michel Jarre');
});

// ---------------------------------------------------------------- report

console.log(results.join('\n'));
console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
