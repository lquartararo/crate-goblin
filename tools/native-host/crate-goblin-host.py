#!/usr/bin/env python3
"""
Native host for crate goblin.

The extension cannot download from YouTube. Not because of a bug: YouTube stopped
putting media URLs in the player response at all, and the token that unlocks them
comes from a VM that has to be eval'd, which Manifest V3 forbids outright in an
extension page. Every working tool solves this by running a real process — yt-dlp
spawning a binary, or a headless browser minting tokens. None of that is
available inside a page.

So the work happens out here instead, and Chrome talks to it over native
messaging. yt-dlp handles the extraction, the conversion and the tags, and
`yt-dlp -U` keeps itself current, which means the part that breaks most often is
maintained by people who do nothing else.

Protocol, as Chrome defines it: a 4-byte little-endian length, then that many
bytes of UTF-8 JSON. Both directions. stdout is the channel, so nothing else may
ever be printed to it.
"""

import glob
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time

# Chrome refuses a single message over 1MB, so audio never travels this way.
# yt-dlp writes the file itself and only the path comes back.
MAX_MESSAGE = 1024 * 1024

# Where the tools actually live. Chrome starts this process with a nearly empty
# PATH, and yt-dlp spawns ffmpeg and deno by name off that PATH — so finding
# them here is not enough, they have to be findable by the child too.
def _bin_dirs():
    """Everywhere these tools plausibly are, because Chrome tells us nothing.

    A native host starts with almost no PATH, so every location has to be named.
    The list grew one bug at a time and the expensive omission was pip's: the
    installer falls back to `pip3 install --user yt-dlp` when there is no
    Homebrew, that lands in ~/Library/Python/<version>/bin, and nothing looked
    there. The install succeeded, said so, and the downloader was invisible —
    which reads as "I ran the script and it still says not installed".
    """
    dirs = [
        "/opt/homebrew/bin",                        # Homebrew, Apple silicon
        "/usr/local/bin",                           # Homebrew, Intel
        "/opt/local/bin",                           # MacPorts
        "/usr/bin", "/bin",
        os.path.expanduser("~/.local/bin"),         # our own fallback, and deno
        os.path.expanduser("~/bin"),
        os.path.expanduser("~/.bun/bin"),
    ]
    # pip --user, whichever Python wrote it. Sorted so a newer one wins.
    dirs += sorted(glob.glob(os.path.expanduser("~/Library/Python/*/bin")), reverse=True)
    return dirs


BIN_DIRS = _bin_dirs()

# A real file, because stdout is the protocol channel and cannot carry a word of
# this. The extension reports the failing line itself; this is for the rest.
LOG = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", ".updater", "host.log"))


def log(line):
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        with open(LOG, "a") as fh:
            fh.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')}  {line}\n")
    except Exception:
        pass  # logging must never be the reason a download fails


def js_runtime_args():
    """Tell yt-dlp about a JS runtime it would not find on Chrome's PATH.

    YouTube serves a challenge script that has to be executed to get the good
    formats, and deno is the default because it is the one runtime that denies
    that script the filesystem and network unless told otherwise — it is
    adversarial code by design. node and bun are accepted as fallbacks so a
    machine without deno degrades in quality rather than in security silently,
    but deno is what install-updater.sh puts there. yt-dlp's own priority order
    is deno, node, quickjs, bun.
    """
    args = []
    for name in ("deno", "node", "quickjs", "bun"):
        path = which(name)
        if path:
            args += ["--js-runtimes", f"{name}:{path}"]
    return args


def child_env():
    """yt-dlp's environment, with a PATH it can actually find ffmpeg on."""
    env = dict(os.environ)
    env["PATH"] = os.pathsep.join(BIN_DIRS + [env.get("PATH", "")])
    return env

# yt-dlp extracts to these directly. AIFF is absent from its list, so it is
# reached with one ffmpeg pass afterwards — and it matters, because WAV is the
# format that intermittently refuses to load on a CDJ.
YTDLP_FORMATS = {"mp3": "mp3", "m4a": "m4a", "flac": "flac", "wav": "wav"}


# Where the browser drops a gate or lucida file on its way to ffmpeg. The
# extension picks this name; the two have to agree, so it is written down in
# both places rather than derived.
STAGING = os.path.join(os.path.expanduser("~/Downloads"), "crate-goblin-staging")

# Long enough that nothing in flight is ever in scope — a conversion takes
# seconds — and short enough that a stray file does not sit there for a week.
STALE_AFTER = 60 * 60


def sweep_staging(force=False):
    """Clear staging, and take the folder with it.

    Two modes. Normally only files older than an hour go, because a conversion
    could be running. `force` is for the moments when nothing can be in flight —
    the queue has drained, the panel opened, the browser started — and then the
    whole directory goes.

    Forced removal is rmtree rather than unlink-then-rmdir. That sequence kept
    clearing the contents and leaving the folder, because macOS writes a
    .DS_Store into any directory Finder has displayed and will write it again
    between the listing and the rmdir. There is no ordering that wins that race;
    removing the tree in one call sidesteps it. Nothing in here is anyone's data
    — it is a staging area this program owns.
    """
    if not os.path.isdir(STAGING):
        return

    if force:
        try:
            shutil.rmtree(STAGING)
            log("swept staging and removed the folder")
        except OSError as e:
            # Named precisely, because "it is still there" has several causes
            # and they need different answers: EACCES/EPERM is macOS refusing
            # this process the folder, ENOTEMPTY means something appeared while
            # we were working.
            log(f"could not remove staging: errno {e.errno} — {e}")
        return

    try:
        now = time.time()
        for name in os.listdir(STAGING):
            path = os.path.join(STAGING, name)
            if not os.path.isfile(path):
                continue
            if now - os.path.getmtime(path) > STALE_AFTER:
                try:
                    os.unlink(path)
                    log(f"swept stale staging file: {name}")
                except OSError as e:
                    log(f"could not remove {name}: {e}")

        # Nothing real left: the rest is whatever the operating system put here.
        if not [n for n in os.listdir(STAGING) if not n.startswith(".")]:
            try:
                shutil.rmtree(STAGING)
            except OSError as e:
                log(f"could not remove empty staging: errno {e.errno} — {e}")
    except FileNotFoundError:
        pass
    except OSError as e:
        log(f"staging sweep failed: errno {e.errno} — {e}")


def discard(msg):
    """Remove what a cancelled track left in staging.

    Staging names are prefixed with the row id precisely so this can find them
    without touching anything else in flight. Cancelling used to leave the file
    for the hourly sweep, which meant taking a track back still cost you a file
    you never asked for, sitting somewhere you would not look.
    """
    prefix = str(msg.get("id") or "")
    if not prefix:
        return send({"type": "done", "removed": 0})

    removed = 0
    try:
        for name in os.listdir(STAGING):
            if not name.startswith(prefix + "-"):
                continue
            try:
                os.unlink(os.path.join(STAGING, name))
                removed += 1
            except OSError:
                pass
    except FileNotFoundError:
        pass
    if removed:
        log(f"discarded {removed} staging file(s) for cancelled {prefix}")
    send({"type": "done", "removed": removed})


def unique(path):
    """A path that does not exist yet. Re-downloading a track for a different
    set is normal, and the older file may already be in a playlist."""
    stem, ext = os.path.splitext(path)
    n = 1
    while os.path.exists(path):
        path = f"{stem} ({n}){ext}"
        n += 1
    return path


def out_dir_for(folder):
    d = os.path.join(os.path.expanduser("~/Downloads"),
                     *((safe_component(folder),) if folder else ()))
    os.makedirs(d, exist_ok=True)
    return d


def convert(msg):
    """Re-container a file the browser already fetched, and tag it.

    Gates hand back whatever the artist uploaded and lucida hands back whatever
    the service had, so both arrive as a real file in a format nobody chose. The
    extension used to convert these itself, which meant a second conversion
    implementation living beside ffmpeg and losing to it — lamejs for mp3, a
    hand-rolled WAV writer for aiff.
    """
    sweep_staging()

    ffmpeg = which("ffmpeg")
    if not ffmpeg:
        return send({"type": "error", "reason": "ffmpeg is not installed. Re-run install-updater.sh"})

    src = msg.get("path")
    if not isinstance(src, str):
        return send({"type": "error", "reason": "no file to convert"})

    # Told apart deliberately. A missing file means the browser and this process
    # disagree about where it went; an unreadable one means macOS is refusing
    # this process access to the folder, which is a different problem with a
    # different fix and would otherwise read as the same failure.
    if not os.path.exists(src):
        log(f"convert: no such file {src}")
        return send({"type": "error", "reason": f"the browser's file was not at {src}", "log": LOG})
    if not os.access(src, os.R_OK):
        log(f"convert: cannot read {src} — permission denied")
        return send({
            "type": "error",
            "reason": "macOS is blocking the downloader from reading your Downloads folder",
            "log": LOG,
        })

    # What the extension used to check before it stopped holding the bytes: a
    # gate that answers with an error page, or a truncated file, is not a track.
    size = os.path.getsize(src)
    if size < 128 * 1024:
        log(f"convert: {os.path.basename(src)} is only {size} B — not a track")
        try: os.unlink(src)
        except OSError: pass
        return send({"type": "error", "reason": f"the gate returned {size} bytes, not a track"})

    log(f"convert: {os.path.basename(src)} ({size // 1024} KB) -> {msg.get('format')}")

    # Is what the gate gave us actually better than the stream we could have had?
    #
    # A "free download" is usually the artist's master and worth taking over any
    # transcode. Sometimes it is a 128k mp3 someone exported once, and taking it
    # over a 256k Go+ stream means the gate cost you quality rather than earning
    # it. Measured rather than assumed, because nothing about the URL says which
    # kind it is.
    floor = msg.get("atLeast")
    if floor:
        probed = probe_audio(src)
        # Lossless always wins; there is no lossy stream that beats it.
        if probed and not probed["lossless"] and probed["kbps"] and probed["kbps"] + 16 < floor:
            log(f"convert: source is {probed['kbps']}k, stream offers {floor}k — declining")
            try: os.unlink(src)
            except OSError: pass
            return send({"type": "worse", "kbps": probed["kbps"], "floor": floor})

    fmt = str(msg.get("format") or "mp3").lower()
    dest = os.path.join(out_dir_for(msg.get("folder")),
                        safe_component(msg.get("name") or os.path.basename(src)))
    dest = unique(os.path.splitext(dest)[0] + "." + fmt)

    cmd = [ffmpeg, "-y", "-i", src]

    # Artwork travels as a url because the browser has one and the file may not.
    art = None
    tags = msg.get("tags") or {}
    if msg.get("artwork"):
        art = fetch_artwork(msg["artwork"])
        if art:
            cmd += ["-i", art, "-map", "0:a", "-map", "1:v", "-disposition:v", "attached_pic"]

    if fmt == "mp3":
        cmd += ["-codec:a", "libmp3lame", "-q:a", "0"]
    elif fmt == "m4a":
        cmd += ["-codec:a", "aac", "-b:a", "256k"]
    elif fmt == "aiff":
        # AIFF's own text chunks carry a name and little else, so ffmpeg's
        # default drops the artist, the album and the year — measured, not
        # assumed. ID3v2 in the container keeps them, which is the whole reason
        # this project had a hand-written ID3 writer before ffmpeg was reachable.
        # Rekordbox reads these; a library of correctly-named files with no
        # artist tag is a library you cannot sort.
        cmd += ["-write_id3v2", "1"]
    # wav and flac take ffmpeg's default for the container.

    for k, v in tags.items():
        if v:
            cmd += ["-metadata", f"{k}={v}"]

    cmd.append(dest)
    r = subprocess.run(cmd, capture_output=True, env=child_env())
    if art:
        try: os.unlink(art)
        except OSError: pass

    if r.returncode != 0:
        log(r.stderr.decode("utf-8", "replace")[-2000:])
        return send({"type": "error", "reason": "conversion failed", "log": LOG})

    # The browser's copy has been replaced by the converted one.
    try: os.unlink(src)
    except OSError: pass

    send({"type": "done", "path": dest, "name": os.path.basename(dest),
          "bytes": os.path.getsize(dest),
          "seconds": (probe_audio(dest) or {}).get("seconds")})


def probe_audio(path):
    """Codec and bitrate of a file, or None if ffprobe cannot say.

    Bitrate comes from the stream where it is stated and from the container
    otherwise — a VBR mp3 often reports only the latter, and for this decision
    an approximate answer is enough.
    """
    ffprobe = which("ffprobe")
    if not ffprobe:
        return None
    try:
        out = subprocess.run(
            [ffprobe, "-v", "error", "-select_streams", "a:0",
             "-show_entries", "stream=codec_name,bit_rate:format=bit_rate,duration",
             "-of", "json", path],
            capture_output=True, text=True, timeout=30, env=child_env())
        d = json.loads(out.stdout or "{}")
        stream = (d.get("streams") or [{}])[0]
        codec = (stream.get("codec_name") or "").lower()
        rate = stream.get("bit_rate") or (d.get("format") or {}).get("bit_rate")
        secs = (d.get("format") or {}).get("duration")
        return {
            "codec": codec,
            "kbps": round(int(rate) / 1000) if rate and str(rate).isdigit() else None,
            "lossless": codec in ("flac", "alac", "pcm_s16le", "pcm_s24le", "pcm_f32le"),
            "seconds": round(float(secs)) if secs else None,
        }
    except Exception as e:
        log(f"probe failed: {e}")
        return None


def fetch_artwork(url):
    """Artwork to a temp file, or None. Never fatal — a tagged file with no
    cover beats no file."""
    if not str(url).startswith("https://"):
        return None
    try:
        import urllib.request
        fd, path = tempfile.mkstemp(suffix=".jpg")
        with urllib.request.urlopen(url, timeout=20) as r, os.fdopen(fd, "wb") as f:
            shutil.copyfileobj(r, f)
        return path
    except Exception as e:
        log(f"artwork fetch failed: {e}")
        return None


def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) < 4:
        return None
    length = struct.unpack("<I", raw_length)[0]
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


def send(obj):
    data = json.dumps(obj).encode("utf-8")
    if len(data) > MAX_MESSAGE:
        data = json.dumps({"type": "error", "reason": "message too large"}).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def which(name):
    """Look past the PATH Chrome hands us, which is close to empty."""
    found = shutil.which(name)
    if found:
        return found
    for base in BIN_DIRS:
        candidate = os.path.join(base, name)
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def safe_component(name):
    """A folder name from an untrusted string, with no way out of the tree."""
    cleaned = re.sub(r'[/\\:*?"<>|]', "-", str(name or "")).strip().strip(".")
    return cleaned[:120] or "crate goblin"


def probe():
    sweep_staging()
    ytdlp, ffmpeg = which("yt-dlp"), which("ffmpeg")
    # YouTube hands out a JS challenge that has to be run to get the good
    # formats. Without a runtime nothing errors — the audio just quietly gets
    # worse, so it is worth reporting which one, if any, was found.
    return {
        "type": "hello",
        "ok": bool(ytdlp),
        "ytdlp": ytdlp,
        "ffmpeg": ffmpeg,
        "js": next((n for n in ("deno", "node", "quickjs", "bun") if which(n)), None),
        "searched": BIN_DIRS,
        "log": LOG,
        "version": run_version(ytdlp) if ytdlp else None,
    }


def run_version(ytdlp):
    try:
        out = subprocess.run([ytdlp, "--version"], capture_output=True, text=True,
                             timeout=15, env=child_env())
        return out.stdout.strip() or None
    except Exception:
        return None


def download(msg):
    ytdlp = which("yt-dlp")
    if not ytdlp:
        # Name the search, because "not installed" is usually wrong — it is
        # installed somewhere nobody looked, and without this there is no way
        # to tell those two apart from the outside.
        log("yt-dlp not found. Searched: " + os.pathsep.join(BIN_DIRS))
        return send({
            "type": "error",
            "reason": "yt-dlp is installed somewhere this cannot see it — see the log for where it looked",
            "log": LOG,
        })

    url = msg.get("url")
    if not isinstance(url, str) or not url.startswith(("http://", "https://")):
        return send({"type": "error", "reason": "no usable URL"})

    fmt = str(msg.get("format") or "mp3").lower()
    want_video = str(msg.get("media") or "audio").lower() == "video"
    # AIFF has no yt-dlp extractor, so it is produced from WAV afterwards.
    target = "wav" if fmt == "aiff" else YTDLP_FORMATS.get(fmt, "mp3")

    out_dir = os.path.join(
        os.path.expanduser("~/Downloads"),
        *(safe_component(msg["folder"]),) if msg.get("folder") else (),
    )
    os.makedirs(out_dir, exist_ok=True)

    # A private staging directory, so a half-finished file never appears in the
    # crate and a failure leaves nothing behind.
    with tempfile.TemporaryDirectory() as staging:
        cmd = [
            ytdlp,
            "--no-playlist",
            "--embed-metadata",
            "--no-progress",
            "--newline",
            # Fragmented audio arrives one piece at a time otherwise, which is
            # what made the in-browser version slow: it fetched 40 segments in
            # sequence because that is all a page can reasonably do. Out here
            # they come in parallel.
            "--concurrent-fragments", "4",
            "-o", os.path.join(staging, "%(title)s.%(ext)s"),
        ]

        if want_video:
            # Best video with the best audio alongside it, muxed to mp4 — the
            # one container that plays everywhere without asking questions.
            # No thumbnail embed: for video that is a cover-art track some
            # players show instead of the first frame.
            cmd += [
                "-f", "bestvideo*+bestaudio/best",
                "--merge-output-format", "mp4",
            ]
        else:
            cmd += [
                "--extract-audio",
                "--audio-format", target,
                "--audio-quality", "0",
            ]
            # yt-dlp can only embed cover art into mp3, m4a, flac and the ogg
            # family. Asking for it on wav or aiff is not a warning, it fails
            # the whole postprocess after the audio has already downloaded —
            # and aiff is this tool's default, so every SoundCloud track would
            # have died at the last step.
            if target not in ("wav",):
                cmd += ["--embed-thumbnail"]

        # yt-dlp runs ffmpeg as a child and looks it up by name, so knowing the
        # path here does nothing unless it is handed over. Without this the
        # audio downloads and then the conversion dies, which is exactly the
        # failure that looks like nothing happened.
        ffmpeg = which("ffmpeg")
        if ffmpeg:
            cmd += ["--ffmpeg-location", os.path.dirname(ffmpeg)]

        cmd += js_runtime_args()

        # SoundCloud hands a Go+ session better transcodings than an anonymous
        # one, and yt-dlp has no session of its own. The extension is already
        # inside that session, so it lends its header rather than yt-dlp being
        # asked to read Chrome's cookie jar — which on macOS means a keychain
        # prompt, which is not something to put in front of these users.
        for k, v in (msg.get("headers") or {}).items():
            cmd += ["--add-header", f"{k}:{v}"]

        cmd.append(url)

        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, env=child_env())
        except Exception as e:
            log(f"could not start yt-dlp: {e}")
            return send({"type": "error", "reason": f"could not start yt-dlp: {e}"})

        # Errors arrive on this same stream, so they are kept rather than
        # filtered away. Previously only progress lines were forwarded and the
        # reason for a failure was read and discarded.
        tail = []
        chosen = None
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            tail.append(line)
            del tail[:-40]
            # Which transcoding it settled on. This is the only honest answer to
            # "am I getting the good files": the output format cannot tell you,
            # because a 128k source converted to AIFF is a large lossless file
            # that came from a small lossy one.
            m = re.search(r"Downloading 1 format\(s\): (\S+)", line)
            if m:
                chosen = m.group(1)
            if line.startswith("[download]") or line.startswith("[Extract"):
                send({"type": "progress", "text": line[:180]})

        if proc.wait() != 0:
            for line in tail:
                log(line)
            # The last ERROR line is the one worth showing; the rest is noise.
            errors = [l for l in tail if l.startswith("ERROR:")]
            reason = errors[-1][len("ERROR:"):].strip() if errors else (tail[-1] if tail else "yt-dlp failed")
            return send({"type": "error", "reason": reason[:300], "log": LOG})

        produced = [f for f in os.listdir(staging) if not f.startswith(".")]
        if not produced:
            for line in tail:
                log(line)
            return send({"type": "error", "reason": "yt-dlp produced no file", "log": LOG})

        src = os.path.join(staging, produced[0])

        if fmt == "aiff" and not want_video:
            ffmpeg = which("ffmpeg")
            if not ffmpeg:
                return send({"type": "error", "reason": "ffmpeg is needed for AIFF and is not installed"})
            aiff = os.path.splitext(src)[0] + ".aiff"
            # -map_metadata keeps what yt-dlp wrote, and -write_id3v2 is what
            # makes aiff able to hold it: the container's own text chunks carry
            # a name and drop the artist, album and year.
            r = subprocess.run(
                [ffmpeg, "-y", "-i", src, "-map_metadata", "0", "-write_id3v2", "1", aiff],
                capture_output=True, env=child_env())
            if r.returncode != 0:
                log(r.stderr.decode("utf-8", "replace")[-2000:])
                return send({"type": "error", "reason": "AIFF conversion failed", "log": LOG})
            src = aiff

        final = os.path.join(out_dir, os.path.basename(src))
        # Never overwrite: a DJ re-downloading a track for a different set is
        # normal, and the older file may already be in a playlist.
        stem, ext = os.path.splitext(final)
        n = 1
        while os.path.exists(final):
            final = f"{stem} ({n}){ext}"
            n += 1

        shutil.move(src, final)
        # How long the music is, measured off the file rather than trusted from
        # a page. YouTube rows carry no duration at all — the panel builds them
        # from the tab title and nothing else — so this is the only number that
        # works for every route.
        send({"type": "done", "path": final, "name": os.path.basename(final),
              "source": chosen, "bytes": os.path.getsize(final),
              "seconds": (probe_audio(final) or {}).get("seconds")})


def main():
    while True:
        msg = read_message()
        if msg is None:
            return
        try:
            kind = msg.get("type")
            if kind == "probe":
                send(probe())
            elif kind == "download":
                download(msg)
            elif kind == "convert":
                convert(msg)
            elif kind == "discard":
                discard(msg)
            elif kind == "sweep":
                # Nothing can be running: the queue drained or the browser just
                # started. Take everything.
                sweep_staging(force=True)
                send({"type": "done"})
            else:
                send({"type": "error", "reason": f"unknown request: {kind}"})
        except Exception as e:
            send({"type": "error", "reason": str(e)})


if __name__ == "__main__":
    main()
