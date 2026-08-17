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

# Every copy, not just the winner.
#
# One machine turned out to have three yt-dlp installs across different Python
# versions. Uninstalling "the" one removed a copy that was not being used and
# nothing changed, which is impossible to reason about when the tool only ever
# reports a single path.
find_all_tools() {
  local name="$1" d
  while IFS= read -r d; do
    [ -x "$d/$name" ] && printf '%s\n' "$d/$name"
  done < <(crate_bin_dirs)
}

# Resolve a tool the way the extension will see it, not the way your shell does.
find_tool() {
  local name="$1" d
  while IFS= read -r d; do
    [ -x "$d/$name" ] && { printf '%s\n' "$d/$name"; return 0; }
  done < <(crate_bin_dirs)
  return 1
}

# Bring yt-dlp up to date, whichever way it was installed.
#
# `yt-dlp -U` only works on the standalone binary. A pip install refuses with
# "You installed yt-dlp with pip ... Use that to update", which is a correct and
# completely inert answer for a timer: it printed an error every half hour and
# the copy stayed a year old.
#
# Homebrew's copy is preferred when it can be had, because /opt/homebrew/bin is
# first in the search order — installing it takes precedence over the stale one
# without having to remove anything.
update_ytdlp() {
  local ytdlp="$1" out
  out="$("$ytdlp" -U 2>&1 | tail -2)"
  printf '%s\n' "$out"

  case "$out" in
    *"installed yt-dlp with pip"*|*"Use that to update"*|*"wheel from PyPi"*)
      if command -v brew >/dev/null; then
        echo "pip-managed and cannot self-update — installing Homebrew's, which takes precedence"
        brew install yt-dlp 2>&1 | tail -2
      elif command -v pip3 >/dev/null; then
        echo "pip-managed — updating with pip"
        pip3 install --user --upgrade yt-dlp 2>&1 | tail -2
      fi
      ;;
  esac
}
