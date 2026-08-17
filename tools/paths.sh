# Where the tools are, for anything that cannot rely on PATH.
#
# Sourced by the installer and by the timer, and mirrored in
# native-host/crate-goblin-host.py, because three separate answers to "where is
# yt-dlp" is how this went wrong twice at once:
#
#   The host looked in a short list, so a yt-dlp installed anywhere else was
#   reported as not installed while the shell could see it perfectly well.
#
#   The timer used `command -v`, which resolves against PATH — and launchd hands
#   an agent almost none. It silently found nothing every half hour for months,
#   so `yt-dlp -U` never ran once and installs quietly rotted to a year old.
#
# The list is duplicated in Python rather than shelled out to, because the host
# must not depend on a shell script existing; but the two are meant to match and
# the installer checks that they agree.
crate_bin_dirs() {
  printf '%s\n' \
    /opt/homebrew/bin \
    /usr/local/bin \
    /opt/local/bin \
    /usr/bin \
    /bin \
    "$HOME/.local/bin" \
    "$HOME/bin" \
    "$HOME/.bun/bin"
  # pip --user, whichever Python wrote it. Newest first.
  ls -d "$HOME"/Library/Python/*/bin 2>/dev/null | sort -r
}

# Resolve a tool the way the extension will see it, not the way your shell does.
find_tool() {
  local name="$1" d
  while IFS= read -r d; do
    [ -x "$d/$name" ] && { printf '%s\n' "$d/$name"; return 0; }
  done < <(crate_bin_dirs)
  return 1
}
