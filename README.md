# SoundCloud Crate

A browser extension that triages a SoundCloud playlist in one pass instead of
making you open sixty tracks one at a time.

The clicking was never the slow part. The slow part is *discovering* which
tracks even need clicking. This does that in one shot.

## What it does

Point it at a playlist, album or user page and it sorts every track into three
buckets:

| Bucket | Meaning | What happens |
|---|---|---|
| **Free** | Artist enabled downloads | Grabs the original master (WAV/AIFF/FLAC) |
| **Gated** | Has a `purchase_url` | Grabs a stream now, queues the gate for batch-opening |
| **Stream only** | Nothing offered | Grabs the best transcode |

### Gate handling

Three settings, under **Gated tracks**:

- **Try to unlock, fall back to stream** — works the gate's own controls in a
  background tab, suppressing the popups. If it can't surface a file, you get
  the stream instead and the gate stays queued.
- **Grab stream now + queue the gate** — no automation; take a playable file
  immediately and clear the gate by hand later.
- **Queue the gate only** — download nothing.

### What the gates actually look like

Selectors are tuned against live pages, not guesswork. Ten hosts inspected,
weighted by how often they appeared across 67 real gates:

| Shape | Share | Hosts |
|---|---|---|
| Button — full auto | 78% | Hypeddit (`#downloadProcess`), PumpYourSound, Droploud |
| Email capture | 4% | ToneDen, fanlink.tv |
| Dead link | 4% | TheArtistUnion, songrocket |
| Unsurveyed | 13% | assorted one-offs |

**None gated behind clickable follow/like/repost controls.** Every button-type
gate had its download control live and enabled from page load, which is why the
generic step-walking was removed rather than maintained.

Two things the survey caught that guesswork would not have:

- **White-label domains.** `music.boostdj.co` serves byte-identical Hypeddit
  pages; `fanlink.tv` serves ToneDen. A fixed match list skips them entirely, so
  the automation never runs and the gate looks broken. Scripts are now injected
  on demand into gate tabs, with origins requested at batch time.
- **Consent overlays intercept clicks.** PumpYourSound and Droploud both render
  a banner above the download button. These are dismissed by *declining* —
  never accepting — and Droploud's decline control carries the wording only in
  its text, so selector matching alone walks straight past it.

Gate markup still changes without notice. Treat a run of failures as "the
selectors moved", not "the tracks are gone" — which is why the fallback exists,
and why anything the automation misses is pushed to the front of the manual
queue rather than quietly dropped.

Manual gates open 10 tabs at a time and are remembered across runs, so
re-running a crate won't reopen what you already cleared.

## Install

Chrome / Brave / Edge:

```bash
open -a "Google Chrome" chrome://extensions
```

Enable **Developer mode**, click **Load unpacked**, select this folder. Then open
any SoundCloud playlist and hit **Triage crate**.

Because the extension runs inside your logged-in session, original-file
downloads and Go+ 256k work with no cookie export and no password handling.

## Audio quality

Measured on a real track rather than assumed:

| Auth state | Best available |
|---|---|
| Anonymous | 160 kbps AAC (`aac_160k`) |
| Logged in / Go+ | 256 kbps AAC (`abr_sq` adaptive tier) |
| Artist enabled download | Original uploaded master |

AAC comes as HLS only — there is no progressive URL for it. Segments are
fragmented MP4 (`#EXT-X-MAP` init + `.m4s` fragments), so
`init.mp4 + data000.m4s + …` concatenated is already valid audio.

## Format

AAC is the **codec**; MP4 is the **container**; `.m4a` is just MP4-with-audio.
They aren't alternatives — the AAC sits inside an MP4 either way.

| Option | What it does | Size | When |
|---|---|---|---|
| **AIFF** | Decodes AAC to PCM | ~70 MB | Default. Safest on club gear. |
| **M4A** | Lossless container rewrite | ~8 MB | Same audio, a tenth the size |
| **MP3** | SoundCloud's own 128k encode | ~6 MB | Maximum reach; lowest quality |

AIFF and M4A hold **identical audio** — AIFF is just that audio already decoded.
Neither can sound better than the other; you're choosing size against how much
you trust the deck to handle VBR AAC.

MP3 is the one real quality step down, and it's deliberately SoundCloud's own
encode rather than a transcode of the AAC. Transcoding would stack a second
lossy generation on top of the first; fetching their MP3 keeps it to one. The
cost is that their encode is 128k. (A 320k transcode would land closer to the
AAC, but needs a bundled LAME encoder — not currently included.)

`wav` and `fragmented` remain valid values and still work; they're kept as
internal fallbacks for when a decode or remux fails, just not offered in the UI.

**Why PCM is the default, despite being bigger and sounding identical.**
Pioneer lists M4A as supported, but "supported" isn't "reliable on a 2011
CDJ-900". The known trigger for stutter and read errors on older decks is
variable-bitrate AAC — and SoundCloud's streams are measurably VBR: on a real
track, 438 distinct packet sizes spanning 134–722 bytes, ~10% standard
deviation. AAC is variable by design, so no stream choice avoids this.

Decoding to PCM does avoid it, and the risk is asymmetric: the cost of AIFF is
disk space, the cost of an M4A a deck won't read is a track that dies mid-set.

Decoding does **not** improve quality — it can't recover what AAC discarded. You
get a bigger file containing exactly the audio the M4A would have decoded to.

AIFF over WAV because WAV's tagging is a non-standard bolt-on that Rekordbox and
Serato handle inconsistently; AIFF carries ID3 properly.

MP3 and FLAC are deliberately absent: MP3 would be a lossy-to-lossy transcode
that genuinely loses quality, and FLAC would losslessly compress an already-lossy
source for no gain.

## The remux, and why it matters for CDJs

Concatenated HLS gives you a **fragmented** MP4 (`File type ID: mp4f`). CoreAudio,
VLC and ffmpeg all read it, so it plays fine on a laptop. Hardware players
reading a USB stick are less forgiving, and Rekordbox copies the original file to
the stick rather than normalising it.

`src/lib/remux.js` rebuilds it as a standard MP4 (`m4af`) in pure JS — no
ffmpeg.wasm, no transcode. It flattens the per-fragment `trun` timing into flat
`stts`/`stsz`/`stsc`/`stco` sample tables.

Verified against ffmpeg's `-c copy` on a 6:37 track:

```
decoded audio SHA1   6e073ac9cce2df4ddc652128855428f0fc38ccb4  (identical)
frames               17105  (identical)
duration             397.175896s  (identical)
output size          8012595 bytes vs ffmpeg's 8013064
```

Turn it off in the panel if you only ever play off a laptop.

## Layout

```
src/lib/api.js       api-v2 client, client_id scraping, hydration, retry
src/lib/triage.js    bucket classification
src/lib/hls.js       m3u8 parsing, segment fetch, transcoding ranking
src/lib/remux.js     fragmented MP4 -> standard MP4, + iTunes atoms
src/lib/pcm.js       AAC -> AIFF/WAV decode
src/lib/id3.js       ID3v2.3 tag builder
src/lib/tag.js       applies tags per format, fetches artwork
src/lib/archive.js   what you've already pulled (ISRC / id / fuzzy name)
src/lib/pool.js      bounded-concurrency runner
src/lib/download.js  per-bucket routing and fallbacks
src/gate/suppress.js popup suppression on gate pages (MAIN world)
src/gate/unlock.js   gate automation (isolated world)
src/panel/           the triage UI
test/run.mjs         23 tests, no network or browser required
```

Run them with:

```bash
node test/run.mjs
```

## Tagging

Every downloaded file gets title, artist, genre, ISRC, year, permalink and
embedded artwork — all of it already fetched during triage, and previously
thrown away. Rekordbox and Serato fall back to the filename when tags are
empty, which imports as a wall of unsortable strings.

Mechanics differ per format: ID3v2.3 at the head of an MP3, an `ID3 ` chunk
inside an AIFF, and iTunes atoms in `moov/udta` for M4A — written during the
remux, since that pass is already rebuilding `moov` and can size it correctly
in one go.

## Syncing a crate

The archive records every track under three keys: ISRC where present, the
SoundCloud track id, and a normalised artist+title with promo noise
(`(FREE DOWNLOAD)`, `[Out Now]`) stripped. That last one catches reuploads that
carry a new id.

With **Skip already downloaded** on, pointing the tool at the same playlist next
week pulls only what's new. Tracks where the gate failed are deliberately *not*
archived — you're holding a placeholder stream, and the next sync should give
you another shot at the real file.

Every path degrades rather than failing: a revoked original falls back to a
stream, a failed gate falls back to a stream, a failed remux keeps the
fragmented file, a failed WAV decode keeps the M4A. A track that downloaded
should never vanish because a later step broke.

## Notes from building this

Things that will bite you if you fork this:

- **`purchase_url` is why this exists.** yt-dlp's extractor discards it, along
  with `purchase_title` and `publisher_metadata.isrc`. The raw track object has
  47 fields; yt-dlp surfaces about 20.
- **Playlists return id-only stubs** mixed in with full track objects. Miss the
  hydration step and tracks silently vanish from the triage.
- **`abr_sq` advertises itself on every track but 404s anonymously.** Rank it
  first without a fallback and every download fails for logged-out users.
- **Don't gate on `policy: 'SNIP'`.** It's a catalog property that stays `SNIP`
  even for a Go+ subscriber who can play the track in full, so refusing on it
  blocks downloads that would have worked. The api-v2 response is
  session-relative — read `transcodings[].snipped` and `duration` vs
  `full_duration` instead. Anonymous on a SNIP track: two `mp3_0_1`
  transcodings, `snipped: true`, `duration: 30000` against
  `full_duration: 211905`.
- **ISRC is the good dedupe key** against an existing library, but only ~14% of
  user-uploaded promo tracks carry one. Fall back to fuzzy title matching.

## Sharing it with someone

Chrome only installs extensions from the Web Store on Windows and macOS. A
self-hosted `.crx` with an `update_url` auto-updates on Linux and under
enterprise policy and nowhere else, so the usual answer for handing a tool to a
couple of people doesn't exist. The Web Store would work, but it means review —
and review is not friendly to SoundCloud downloaders.

So it updates itself out of a git checkout instead:

- `tools/install-updater.sh` installs a launchd agent that runs
  `git pull --ff-only` every 30 minutes.
- `src/lib/update.js` polls the repo's `dist/manifest.json` every 3 hours and
  calls `chrome.runtime.reload()` when the version there is newer than the one
  running. Reloading an unpacked extension re-reads from disk, so the pull is
  what delivers the update and the reload is only what makes it take effect.

The two schedules don't need to agree. If the pull hasn't landed, the versions
still match and nothing happens; the next check picks it up.

### On their machine, once

```
git clone https://github.com/lquartararo/soundcloud-crate.git
cd soundcloud-crate
./tools/install-updater.sh
```

Then `chrome://extensions` → Developer mode → **Load unpacked** → pick the
`dist/` folder. That's the last time anyone opens that page.

### Shipping an update

Bump `version` in `manifest.json`, `bun run build`, commit **including
`dist/`**, push. `dist/` is deliberately not gitignored — it's what gets loaded,
and requiring a build step on their side would mean requiring bun on their side.

Two things that follow from this design:

- **A broken push propagates on its own.** `looksLoadable()` refuses to reload
  into a manifest that isn't a loadable MV3 extension, which catches a
  half-committed build but not a working extension with a real bug in it.
- **A local edit stops updates for that checkout.** `--ff-only` fails rather
  than merging, which is the right outcome on a machine nobody is watching. The
  reason lands in `.updater/pull.log`.
