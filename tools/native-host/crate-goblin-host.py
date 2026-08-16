#!/usr/bin/env python3
"""
Native host for Crate Goblin.

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

# Chrome refuses a single message over 1MB, so audio never travels this way.
# yt-dlp writes the file itself and only the path comes back.
MAX_MESSAGE = 1024 * 1024

# yt-dlp extracts to these directly. AIFF is absent from its list, so it is
# reached with one ffmpeg pass afterwards — and it matters, because WAV is the
# format that intermittently refuses to load on a CDJ.
YTDLP_FORMATS = {"mp3": "mp3", "m4a": "m4a", "flac": "flac", "wav": "wav"}


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
    for base in ("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", os.path.expanduser("~/.local/bin")):
        candidate = os.path.join(base, name)
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def safe_component(name):
    """A folder name from an untrusted string, with no way out of the tree."""
    cleaned = re.sub(r'[/\\:*?"<>|]', "-", str(name or "")).strip().strip(".")
    return cleaned[:120] or "Crate Goblin"


def probe():
    ytdlp, ffmpeg = which("yt-dlp"), which("ffmpeg")
    return {
        "type": "hello",
        "ok": bool(ytdlp),
        "ytdlp": ytdlp,
        "ffmpeg": ffmpeg,
        "version": run_version(ytdlp) if ytdlp else None,
    }


def run_version(ytdlp):
    try:
        out = subprocess.run([ytdlp, "--version"], capture_output=True, text=True, timeout=15)
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
            "--extract-audio",
            "--audio-format", target,
            "--audio-quality", "0",
            "--embed-metadata",
            "--embed-thumbnail",
            "--no-progress",
            "--newline",
            "-o", os.path.join(staging, "%(title)s.%(ext)s"),
            url,
        ]

        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        except Exception as e:
            return send({"type": "error", "reason": f"could not start yt-dlp: {e}"})

        for line in proc.stdout:
            line = line.strip()
            if line.startswith("[download]") or line.startswith("[Extract"):
                send({"type": "progress", "text": line[:180]})

        if proc.wait() != 0:
            return send({"type": "error", "reason": "yt-dlp failed, see the extension log"})

        produced = [f for f in os.listdir(staging) if not f.startswith(".")]
        if not produced:
            return send({"type": "error", "reason": "yt-dlp produced no file"})

        src = os.path.join(staging, produced[0])

        if fmt == "aiff":
            ffmpeg = which("ffmpeg")
            if not ffmpeg:
                return send({"type": "error", "reason": "ffmpeg is needed for AIFF and is not installed"})
            aiff = os.path.splitext(src)[0] + ".aiff"
            r = subprocess.run([ffmpeg, "-y", "-i", src, aiff], capture_output=True)
            if r.returncode != 0:
                return send({"type": "error", "reason": "AIFF conversion failed"})
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
            else:
                send({"type": "error", "reason": f"unknown request: {kind}"})
        except Exception as e:
            send({"type": "error", "reason": str(e)})


if __name__ == "__main__":
    main()
