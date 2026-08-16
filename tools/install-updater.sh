#!/bin/bash
#
# Installs a launchd agent that keeps this checkout current.
#
# The extension reloads itself when it notices a newer version on disk (see
# src/lib/update.js); this is the half that puts it there. Together they mean a
# friend loads the unpacked extension once and never touches chrome://extensions
# again.
#
#   ./tools/install-updater.sh            install (or refresh) the agent
#   ./tools/install-updater.sh --uninstall  remove it
#
set -euo pipefail

LABEL="sh.crate.soundcloud-updater"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
# Pull twice as often as the extension checks, so the files are almost always
# already in place when it looks.
INTERVAL=1800

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "removed $LABEL"
  exit 0
fi

# The directory this script lives in, resolved — so it works from anywhere and
# survives the checkout being moved.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ ! -d "$REPO/.git" ]]; then
  echo "error: $REPO is not a git checkout — clone it first" >&2
  exit 1
fi

# launchd runs with a near-empty PATH, so bare `git` is not found. Bake in the
# absolute path rather than relying on a login shell that won't be there.
GIT="$(command -v git)"
if [[ -z "$GIT" ]]; then
  echo "error: git not found on PATH" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$REPO/.updater"

# --ff-only so a local edit is never silently merged or overwritten: the pull
# fails loudly in the log and the extension keeps running the version it has,
# which is the right outcome for a machine nobody is sitting at.
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$GIT</string>
    <string>-C</string>
    <string>$REPO</string>
    <string>pull</string>
    <string>--ff-only</string>
    <string>--quiet</string>
  </array>
  <key>StartInterval</key><integer>$INTERVAL</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$REPO/.updater/pull.log</string>
  <key>StandardErrorPath</key><string>$REPO/.updater/pull.log</string>
</dict>
</plist>
PLIST_EOF

# bootout first so re-running this picks up a changed path or interval.
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"

echo "installed $LABEL"
echo "  repo     $REPO"
echo "  every    $((INTERVAL / 60)) min"
echo "  log      $REPO/.updater/pull.log"
echo
echo "Load $REPO/dist as an unpacked extension once, and that's it."
