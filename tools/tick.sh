#!/bin/bash
#
# What the timer does, every 30 minutes.
#
# Lives in the repo rather than in the generated agent script, which is the
# whole point: the agent pulls first and then runs this, so anything the timer
# should start doing arrives in a commit. The previous version had this logic
# inlined into ~/.../.updater/tick.sh at install time, which meant adding a step
# — deno, when YouTube started requiring a JS runtime — reached nobody until
# they re-ran the installer by hand, and nothing told them to.
#
# Called with the repo path. Never fails the agent: every step is best-effort,
# because a machine nobody is sitting at should keep the parts that still work.
set -u
REPO="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# ---------------------------------------------------------------- yt-dlp
YTDLP="$(command -v yt-dlp || echo "$HOME/.local/bin/yt-dlp")"
[ -x "$YTDLP" ] && "$YTDLP" -U 2>&1 | tail -1

# ------------------------------------------------------------ JS runtime
#
# YouTube serves a challenge that has to be executed to get the good formats.
# Without a runtime nothing errors — the audio just quietly gets worse — which
# is exactly the kind of thing nobody reports.
if ! command -v deno >/dev/null && [ ! -x "$HOME/.local/bin/deno" ]; then
  echo "deno missing — installing so YouTube keeps its better formats"
  if command -v brew >/dev/null; then
    brew install deno >/dev/null 2>&1 && echo "  installed via brew"
  else
    curl -fsSL https://deno.land/install.sh | DENO_INSTALL="$HOME/.local" sh -s -- -y \
      >/dev/null 2>&1 && echo "  installed to ~/.local/bin"
  fi
fi

# --------------------------------------------------------------- staging
#
# The host clears this itself whenever it runs. This is the backstop for a
# machine that stopped using the extension with a file still sitting there.
STAGING="$HOME/Downloads/crate-goblin-staging"
if [ -d "$STAGING" ]; then
  find "$STAGING" -type f -mmin +60 -delete 2>/dev/null
  # -delete leaves the directory; .DS_Store keeps it non-empty either way.
  [ -z "$(find "$STAGING" -type f -not -name '.*' 2>/dev/null)" ] && rm -rf "$STAGING"
fi

exit 0
