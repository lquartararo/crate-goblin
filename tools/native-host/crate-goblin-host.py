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
BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
            os.path.expanduser("~/.local/bin"), os.path.expanduser("~/.bun/bin")]

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
    ffmpeg = which("ffmpeg")
    if not ffmpeg:
        return send({"type": "error", "reason": "ffmpeg is not installed. Re-run install-updater.sh"})

    src = msg.get("path")
    if not isinstance(src, str) or not os.path.isfile(src):
        return send({"type": "error", "reason": "that file is not where the browser said it was"})

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

    send({"type": "done", "path": dest, "name": os.path.basename(dest)})


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
        return send({"type": "error", "reason": "yt-dlp is not installed. Re-run install-updater.sh"})

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
                "--embed-thumbnail",
            ]

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
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            tail.append(line)
            del tail[:-40]
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
            r = subprocess.run([ffmpeg, "-y", "-i", src, aiff], capture_output=True, env=child_env())
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
        send({"type": "done", "path": final, "name": os.path.basename(final)})


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
            else:
                send({"type": "error", "reason": f"unknown request: {kind}"})
        except Exception as e:
            send({"type": "error", "reason": str(e)})


if __name__ == "__main__":
    main()
