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

const { pool } = await import('../src/lib/pool.js');
const { classify, isPreviewOnly, BUCKET } = await import('../src/lib/triage.js');

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

await test('triage: shorteners are gates, ad-walls and stores are named', async () => {
  const { classify, BUCKET } = await import('../src/lib/triage.js');

  const kindOf = (url) => classify({ purchase_url: url }).kind;

  // A shortener is a hop, not a destination — the tab follows it and whatever
  // it lands on is the real gate, so it is worth attempting.
  assert.equal(kindOf('https://bit.ly/abc123'), 'gate');
  assert.equal(kindOf('https://hypeddit.com/track/abc'), 'gate');

  // An ad-wall is a hop that exists to be sat through. Named so the row can say
  // so rather than reporting a generic failure.
  assert.equal(kindOf('https://linkvertise.com/12345/track'), 'adwall');

  // Stores keep their own name. They are attempted now, but the badge should
  // still say where the link goes.
  assert.equal(kindOf('https://artist.bandcamp.com/track/x'), 'store');
  assert.equal(kindOf('https://smarturl.it/xyz'), 'smartlink');

  // Every one of them is still a gated row — the kind decides the label and the
  // message, never whether the track gets queued.
  assert.equal(classify({ purchase_url: 'https://linkvertise.com/1/x' }).bucket, BUCKET.GATED);
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

await test('download: the filename rule is unchanged by the move to yt-dlp', async () => {
  const { filename } = await import('../src/lib/download.js');

  // This rule broke four separate times before it was pinned down, always the
  // same way: something downstream decided it knew better and the file landed
  // as a bare CDN uuid. It now travels to the converter as `name` instead of to
  // chrome.downloads, so it is worth asserting on its own rather than through
  // whichever component happens to consume it this month.
  const row = { id: 42, artist: 'Sumant', title: 'Arizona B' };
  assert.equal(filename(row, 'aiff'), 'Sumant - Arizona B.aiff');
  assert.equal(filename(row, 'aiff', 'remixes !!'), 'remixes !!/Sumant - Arizona B.aiff');

  // Artists routinely bake the artist into the title; don't double it.
  assert.equal(
    filename({ id: 1, artist: 'Sumant', title: 'Sumant - Arizona B' }, 'mp3'),
    'Sumant - Arizona B.mp3',
  );

  // A slash would silently nest the file into a directory nobody asked for.
  assert.equal(
    filename({ id: 2, artist: 'AC/DC', title: 'Back/Black' }, 'mp3'),
    'AC-DC - Back-Black.mp3',
  );

  // Slashes become dashes rather than vanishing, so '///' is still a name.
  assert.equal(filename({ id: 6, artist: '', title: '///' }, 'mp3'), '---.mp3');

  // Genuinely nothing left -> the id, never an empty name. An empty one makes
  // chrome.downloads fall back to the URL's own basename, which is the uuid.
  assert.equal(filename({ id: 7, artist: '', title: '   ' }, 'mp3'), 'soundcloud-7.mp3');
});

// --------------------------------------------------------------- m4a mux


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

await test('paths: soundcloud generated sets are crates too', async () => {
  const { isCratePath, crateKind } = await import('../src/lib/paths.js');
  const { systemPlaylistUrn } = await import('../src/lib/api.js');

  // /discover was rejected wholesale, which took these with it. They are one
  // playlist with a track list, not a feed of many.
  const p = '/discover/sets/personalized-tracks::pflo550:2205855319';
  assert.equal(isCratePath(p), true);
  assert.equal(crateKind(p), 'playlist');
  assert.equal(
    systemPlaylistUrn(`https://soundcloud.com${p}`),
    'soundcloud:system-playlists:personalized-tracks::pflo550:2205855319',
  );

  // A bare feed still is one.
  assert.equal(isCratePath('/discover'), false);
  assert.equal(isCratePath('/feed'), false);
  assert.equal(systemPlaylistUrn('https://soundcloud.com/discover'), null);

  // An ordinary playlist keeps going through /resolve, not the urn endpoint.
  assert.equal(isCratePath('/sumantclub/sets/remixes'), true);
  assert.equal(systemPlaylistUrn('https://soundcloud.com/sumantclub/sets/remixes'), null);
});

await test('paths: serviceOf names the site even where there is nothing to take', async () => {
  const { serviceOf, classifyYouTube, classify } = await import('../src/lib/paths.js');

  // The whole point: pages both classifiers reject, on sites we support. This
  // is what tells the empty state to explain the site rather than offer to
  // send you to one you are already looking at.
  for (const url of [
    'https://www.youtube.com/',
    'https://www.youtube.com/feed/subscriptions',
    'https://www.youtube.com/@someartist',
    'https://m.youtube.com/',
  ]) {
    assert.equal(classifyYouTube(url), null, `${url} is not downloadable`);
    assert.equal(serviceOf(url), 'youtube', `${url} is still youtube`);
  }

  for (const url of ['https://soundcloud.com/feed', 'https://soundcloud.com/discover']) {
    assert.equal(classify(url), null, `${url} is not downloadable`);
    assert.equal(serviceOf(url), 'soundcloud', `${url} is still soundcloud`);
  }

  assert.equal(serviceOf('https://youtu.be/abc123'), 'youtube');
  assert.equal(serviceOf('https://www.soundcloud.com/user'), 'soundcloud');

  // Neither, and in particular not a lookalike host that merely ends with one.
  assert.equal(serviceOf('https://example.com/'), null);
  assert.equal(serviceOf('https://notyoutube.com/watch?v=abc'), null);
  assert.equal(serviceOf('https://soundcloud.com.evil.test/user'), null);
  assert.equal(serviceOf('nonsense'), null);
  assert.equal(serviceOf(null), null);
});

await test('paths: youtube urls classify separately from soundcloud', async () => {
  const { classifyYouTube, classify } = await import('../src/lib/paths.js');

  assert.equal(classifyYouTube('https://www.youtube.com/watch?v=abc123'), 'track');
  assert.equal(classifyYouTube('https://youtu.be/abc123'), 'track');
  assert.equal(classifyYouTube('https://www.youtube.com/playlist?list=PL123'), 'crate');
  assert.equal(classifyYouTube('https://music.youtube.com/watch?v=abc123'), 'track');

  // A video *inside* a playlist is still one video. Treating it as the playlist
  // would queue everything because someone clicked a track from a mix.
  assert.equal(classifyYouTube('https://www.youtube.com/watch?v=abc&list=PL123'), 'track');

  // Not things to download.
  assert.equal(classifyYouTube('https://www.youtube.com/'), null);
  assert.equal(classifyYouTube('https://www.youtube.com/feed/subscriptions'), null);
  assert.equal(classifyYouTube('https://notyoutube.com/watch?v=abc'), null);
  assert.equal(classifyYouTube('nonsense'), null);

  // The two classifiers must not answer for each other's sites.
  assert.equal(classifyYouTube('https://soundcloud.com/user/track'), null);
  assert.equal(classify('https://www.youtube.com/watch?v=abc'), null);
});

// ---------------------------------------------------------------- report

await test('limiter: adaptive one backs off on refusal and recovers', async () => {
  const { createAdaptiveLimiter } = await import('../src/lib/limiter.js');
  const lim = createAdaptiveLimiter({ start: 4, min: 1, max: 4 });

  assert.equal(lim.limit(), 4);

  // Told to slow down: halve, and again.
  lim.penalise(0);
  assert.equal(lim.limit(), 2);
  lim.penalise(0);
  assert.equal(lim.limit(), 1);
  lim.penalise(0);
  assert.equal(lim.limit(), 1, 'never below the floor');

  // Recovery is deliberate: one clean pass is not evidence.
  lim.reward();
  lim.reward();
  assert.equal(lim.limit(), 1, 'two successes are not enough');
  lim.reward();
  assert.equal(lim.limit(), 2, 'three in a row widens it');

  // And it stops at the ceiling.
  for (let i = 0; i < 30; i++) lim.reward();
  assert.equal(lim.limit(), 4);
});

await test('limiter: the penalty gate holds every worker, not just the one told', async () => {
  const { createAdaptiveLimiter } = await import('../src/lib/limiter.js');
  const lim = createAdaptiveLimiter({ start: 3, min: 1, max: 3 });

  const started = [];
  lim.penalise(60);   // everyone waits, however they got here

  const t0 = Date.now();
  await Promise.all([1, 2, 3].map((n) => lim(async () => { started.push([n, Date.now() - t0]); })));

  // Whichever order they ran in, none of them started during the cooldown.
  for (const [, at] of started) {
    assert.ok(at >= 55, `a worker started ${at}ms in, inside the gate`);
  }
});

await test('stats: records and reads back through the host seam', async () => {
  const { setHost } = await import('../src/lib/host.js');
  const { record, readLog, summarize } = await import('../src/lib/stats.js');

  // The offscreen document has no chrome.storage — this is the seam it uses
  // instead, and going around it is what made every write vanish silently.
  const store = new Map();
  setHost({
    getStored: async (k) => store.get(k),
    setStored: async (k, v) => void store.set(k, v),
  });

  await record({ via: 'gate → aiff', source: 'gate', ok: true, bytes: 42e6 });
  await record({ via: 'amazon → mp3', source: 'lucida', ok: true, bytes: 8e6 });
  await record({ via: '', ok: false });

  const log = await readLog();
  assert.equal(log.length, 3, 'every finished track is written');

  const s = summarize(log);
  assert.equal(s.total, 2, 'only the ones that produced a file count as kept');
  assert.equal(s.failed, 1);
  assert.equal(s.bySource.gate, 1);
  // Stated by the download, not read back out of the label — which is what
  // broke when the label was reworded for the row.
  assert.equal(s.bySource.lucida, 1);
  assert.equal(s.mb, 50);
  assert.equal(s.weeks.length, 12);
  assert.equal(s.weeks.at(-1), 2, 'this week holds the two that worked');
});

await test('stats: this week lands in this week, not last', async () => {
  const { summarize } = await import('../src/lib/stats.js');
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  const now = 1_700_000_000_000;

  const log = [
    { t: now - 1, s: 'gate', ok: 1, b: 1 },              // a moment ago
    { t: now - WEEK - 1, s: 'gate', ok: 1, b: 1 },       // last week
    { t: now - 11 * WEEK - 1, s: 'gate', ok: 1, b: 1 },  // the far edge
    { t: now - 40 * WEEK, s: 'gate', ok: 1, b: 1 },      // off the chart
  ];
  const s2 = summarize(log, 12, now);

  // The bug this pins: dividing forward from a start point floored a track
  // recorded a millisecond ago into the previous column, so the newest week was
  // empty except in the instant a download landed.
  assert.equal(s2.weeks.at(-1), 1, 'a track from moments ago is in this week');
  assert.equal(s2.weeks.at(-2), 1, 'last week is last week');
  assert.equal(s2.weeks.length, 12);
  assert.equal(s2.weeks.reduce((a, b) => a + b, 0), 3, 'anything older is off the chart');

  // Totals count everything kept, chart window or not.
  assert.equal(s2.total, 4);
});

// Reporting lives at the very bottom, and has to stay there.
//
// It used to sit above the last few tests, which pushed their results into an
// array that had already been printed: they ran, they counted, and their lines
// went nowhere. The totals said 37 while 34 appeared, and the one that was
// failing was among the invisible ones. Anything added below this line is
// silent, so nothing goes below it.
console.log(results.join('\n'));
console.log(`\n  ${passed} passed, ${failed} failed`);

// exitCode rather than exit(), so queued writes still flush.
process.exitCode = failed ? 1 : 0;
