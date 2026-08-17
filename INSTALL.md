# Setting up

Two steps, about five minutes, once. After that it keeps itself up to date and
you never open a terminal again.

Deliberately not `README.md` — GitHub renders that on the repo's front page and
this one only shows up if you're sent the link.

---

## 1. Get the files and run the setup

Open **Terminal** (⌘-Space, type "terminal", Enter) and paste this in one go:

```bash
git clone https://github.com/lquartararo/crate-goblin.git ~/crate-goblin && cd ~/crate-goblin && ./tools/install-updater.sh
```

It will ask for your password at some point — that's Homebrew installing things,
not the script. Say yes to what it asks.

**What it's doing**, so nothing is a surprise:

| | |
|---|---|
| `yt-dlp` | does the actual downloading. Updates itself monthly, which it needs to. |
| `ffmpeg` | converts and tags. AIFF specifically doesn't work without it. |
| `deno` | YouTube makes the browser solve a puzzle before handing over the good audio. This solves it in a sandbox. |
| a background job | every 30 minutes: pulls this repo, updates yt-dlp. That's the whole reason you don't have to do this again. |

If you don't have Homebrew it'll fetch what it can directly. If something can't
be installed it says so and carries on — you'll still be able to download, just
not everything.

---

## 2. Add it to Chrome

1. Open **`chrome://extensions`**
2. Turn on **Developer mode** — top right
3. Click **Load unpacked**
4. Choose the **`dist`** folder inside `crate-goblin` (your home folder → `crate-goblin` → `dist`)

Pin it to the toolbar so it's one click: puzzle-piece icon → pin.

---

## Using it

Open a SoundCloud playlist, album, artist page or track, or a YouTube video, and
click the goblin. There's a **Get** button on the page itself too, for one track
at a time.

Files land in your **Downloads** folder. A playlist gets its own folder inside
it; a single track just goes in.

---

## When something looks wrong

Click the goblin in the panel, press **Copy diagnostics**, send it to Louis.
That's everything needed to work out what happened, and it's on the clipboard in
two clicks.

A few things that aren't broken:

- **A track says it took another route.** Normal. It tries the best source
  first and falls back; you still get the track.
- **`downloader not installed`.** Step 1 didn't finish. Re-run it:
  ```bash
  cd ~/crate-goblin && ./tools/install-updater.sh
  ```
- **Nothing happens on a page.** It only works on SoundCloud and YouTube, and
  the panel tells you which pages count.

---

## Removing it

```bash
cd ~/crate-goblin && ./tools/install-updater.sh --uninstall
```

Then remove it from `chrome://extensions`. That takes out the background job and
the browser connection; `yt-dlp` and `ffmpeg` stay, since you may want them.
