#!/bin/bash
#
# Sets up Crate Goblin on a Mac, and keeps it that way.
#
# Three things need to stay current and only one of them is the extension:
#
#   the checkout   pulled on a timer; the extension notices and reloads itself
#   yt-dlp         `yt-dlp -U`, because YouTube breaks it roughly monthly
#   the bridge     registered once so Chrome will talk to the downloader
#
# All three ride the same launchd agent, so a friend runs this once and never
# opens a terminal again.
#
#   ./tools/install-updater.sh              install or refresh
#   ./tools/install-updater.sh --uninstall  remove
#
set -euo pipefail

LABEL="sh.crate.soundcloud-updater"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
HOST_NAME="sh.crate.goblin"
# The extension id is pinned by the `key` field in manifest.json, so it is the
# same on every machine and this file needs no per-laptop editing.
EXTENSION_ID="ikncfcbemmobanjmceibcmnmnfcglicm"
INTERVAL=1800

# Chrome, Chrome Canary and Chromium each read their own directory.
HOST_DIRS=(
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  "$HOME/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts"
  "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
)

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  for d in "${HOST_DIRS[@]}"; do rm -f "$d/$HOST_NAME.json"; done
  echo "removed the updater and the native bridge (yt-dlp itself is left alone)"
  exit 0
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -d "$REPO/.git" ]] || { echo "error: $REPO is not a git checkout" >&2; exit 1; }

GIT="$(command -v git)" || { echo "error: git not found" >&2; exit 1; }

# ---------------------------------------------------------------- yt-dlp
#
# Homebrew when it's there, pip otherwise. Either is fine; what matters is that
# `yt-dlp -U` can update it in place afterwards.
echo "==> yt-dlp"
if command -v yt-dlp >/dev/null; then
  echo "    already installed ($(yt-dlp --version 2>/dev/null || echo unknown))"
elif command -v brew >/dev/null; then
  brew install yt-dlp
elif command -v pip3 >/dev/null; then
  pip3 install --user --upgrade yt-dlp
else
  # Neither package manager. Fetch the release binary directly, which is what
  # youtube-dl-exec does on install and removes the last dependency: yt-dlp
  # ships as a single self-contained executable.
  echo "    no brew or pip3; fetching the release binary"
  mkdir -p "$HOME/.local/bin"
  if curl -fsSL -o "$HOME/.local/bin/yt-dlp" \
      "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos"; then
    chmod +x "$HOME/.local/bin/yt-dlp"
    echo "    installed to ~/.local/bin/yt-dlp"
    # The host looks here explicitly, so PATH does not have to be involved —
    # launchd and Chrome both hand out a nearly empty one.
  else
    echo "    download failed. YouTube will not work until yt-dlp is installed." >&2
  fi
fi

# ffmpeg does the conversion, and AIFF specifically depends on it.
if ! command -v ffmpeg >/dev/null; then
  echo "==> ffmpeg"
  if command -v brew >/dev/null; then brew install ffmpeg
  else echo "    not installed and no brew; AIFF from YouTube will be unavailable." >&2; fi
fi

# YouTube now serves a JS challenge that yt-dlp solves by running it in deno.
# Skipping this does not produce an error, it just quietly costs you the good
# formats, which is the worst way for a dependency to be missing.
if ! command -v deno >/dev/null; then
  echo "==> deno (yt-dlp needs it to solve YouTube's JS challenge)"
  if command -v brew >/dev/null; then brew install deno
  else curl -fsSL https://deno.land/install.sh | DENO_INSTALL="$HOME/.local" sh -s -- -y >/dev/null 2>&1 \
       && echo "    installed to ~/.local/bin/deno" \
       || echo "    could not install deno; YouTube audio will be lower quality." >&2; fi
fi

# ------------------------------------------------------------ native bridge
echo "==> native bridge"
HOST_PATH="$REPO/tools/native-host/crate-goblin-host.py"
chmod +x "$HOST_PATH"

for d in "${HOST_DIRS[@]}"; do
  # Only for browsers that are actually installed.
  parent="$(dirname "$d")"
  [[ -d "$parent" ]] || continue
  mkdir -p "$d"
  sed -e "s|__HOST_PATH__|$HOST_PATH|" \
      -e "s|__EXTENSION_ID__|$EXTENSION_ID|" \
      "$REPO/tools/native-host/manifest.template.json" > "$d/$HOST_NAME.json"
  echo "    registered in $(basename "$parent")"
done

# ------------------------------------------------------------------ updater
mkdir -p "$HOME/Library/LaunchAgents" "$REPO/.updater"

# One script for the agent to run, so both updates share a schedule and a log.
TICK="$REPO/.updater/tick.sh"
cat > "$TICK" <<TICK_EOF
#!/bin/bash
# Written by install-updater.sh. Edits here are overwritten.
echo "--- \$(date '+%Y-%m-%d %H:%M:%S') ---"
# --ff-only so a local edit fails loudly instead of being merged on a machine
# nobody is sitting at. The extension keeps running the version it has.
"$GIT" -C "$REPO" pull --ff-only --quiet || echo "git pull failed"
YTDLP="\$(command -v yt-dlp || echo "\$HOME/.local/bin/yt-dlp")"
[ -x "\$YTDLP" ] && "\$YTDLP" -U 2>&1 | tail -1
TICK_EOF
chmod +x "$TICK"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$TICK</string></array>
  <key>StartInterval</key><integer>$INTERVAL</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$REPO/.updater/tick.log</string>
  <key>StandardErrorPath</key><string>$REPO/.updater/tick.log</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"

echo
echo "Done."
echo "  repo    $REPO"
echo "  every   $((INTERVAL / 60)) min: git pull + yt-dlp -U"
echo "  log     $REPO/.updater/tick.log"
echo
echo "Last step, once: chrome://extensions -> Developer mode -> Load unpacked"
echo "                 -> choose $REPO/dist"
