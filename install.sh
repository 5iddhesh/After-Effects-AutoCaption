#!/bin/bash
#
# After Effects AutoCaption — one-command installer (macOS)
#
# Run directly from the internet (installs deps + the panel):
#
#   curl -fsSL https://raw.githubusercontent.com/5iddhesh/After-Effects-AutoCaption/main/install.sh | bash
#
# Or, from a local clone:
#
#   ./install.sh              install Homebrew (if missing) + ffmpeg + the AE panel
#   ./install.sh --no-panel   dependencies only, skip copying AutoCaption.jsx
#
set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/5iddhesh/After-Effects-AutoCaption/main"

BLUE=$'\033[1;34m'; GREEN=$'\033[1;32m'; YELLOW=$'\033[1;33m'; RED=$'\033[1;31m'; NC=$'\033[0m'
say()  { printf "%s\n" "${BLUE}==>${NC} $*"; }
ok()   { printf "%s\n" "${GREEN}ok ${NC} $*"; }
warn() { printf "%s\n" "${YELLOW}!! ${NC} $*"; }
die()  { printf "%s\n" "${RED}xx ${NC} $*" >&2; exit 1; }

[ "$(uname)" = "Darwin" ] || die "macOS-only. On Windows install ffmpeg from https://ffmpeg.org/download.html"

INSTALL_PANEL=1
[ "${1:-}" = "--no-panel" ] && INSTALL_PANEL=0

# Where AutoCaption.jsx comes from: a local copy next to this script, else download it.
SOURCE_JSX=""
if [ -n "${BASH_SOURCE:-}" ] && [ -f "$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/AutoCaption.jsx" ]; then
  SOURCE_JSX="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/AutoCaption.jsx"
fi

# ---- 1. Homebrew ----------------------------------------------------------
if ! command -v brew >/dev/null 2>&1; then
  if   [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [ -x /usr/local/bin/brew  ];  then eval "$(/usr/local/bin/brew shellenv)"; fi
fi
if ! command -v brew >/dev/null 2>&1; then
  say "Homebrew not found — installing it (https://brew.sh)…"
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  BREW_PREFIX=/opt/homebrew; [ -x /usr/local/bin/brew ] && BREW_PREFIX=/usr/local
  eval "$("$BREW_PREFIX/bin/brew" shellenv)"
  LINE="eval \"\$($BREW_PREFIX/bin/brew shellenv)\""
  grep -qsF "$LINE" "$HOME/.zprofile" 2>/dev/null || echo "$LINE" >> "$HOME/.zprofile"
  ok "Homebrew installed and added to ~/.zprofile"
else
  ok "Homebrew present ($(brew --version | head -1))"
fi

# ---- 2. ffmpeg ------------------------------------------------------------
if command -v ffmpeg >/dev/null 2>&1; then
  ok "ffmpeg present ($(ffmpeg -version | head -1))"
else
  say "Installing ffmpeg…"; brew install ffmpeg; ok "ffmpeg installed"
fi

# ---- 3. python3 / curl (ship with macOS) ----------------------------------
command -v python3 >/dev/null 2>&1 && ok "python3 present ($(python3 --version 2>&1))" \
  || warn "python3 missing — run:  xcode-select --install"
command -v curl >/dev/null 2>&1 && ok "curl present" || die "curl missing (unexpected on macOS)"

# ---- 4. install the panel into After Effects ------------------------------
if [ "$INSTALL_PANEL" = 1 ]; then
  say "Installing AutoCaption.jsx into After Effects…"

  # get the jsx: local copy if we have one, otherwise download it
  if [ -z "$SOURCE_JSX" ]; then
    SOURCE_JSX="$(mktemp -t AutoCaption).jsx"
    curl -fsSL "$REPO_RAW/AutoCaption.jsx" -o "$SOURCE_JSX" \
      || die "Couldn't download AutoCaption.jsx from $REPO_RAW"
  fi

  shopt -s nullglob

  # Build the list of target "ScriptUI Panels" folders. AE reads scripts from
  # BOTH the app bundle and the user folder; the app-bundle one always exists
  # the moment AE is installed, so it's the reliable target on a fresh machine.
  targets=()
  # 1. App-bundle locations (/Applications/Adobe After Effects <year>/Scripts/ScriptUI Panels)
  for app in /Applications/Adobe\ After\ Effects\ */; do
    [ -d "$app" ] || continue
    targets+=("${app%/}/Scripts/ScriptUI Panels")
  done
  # 2. User locations that already exist (~/Library/Application Support/.../Scripts/ScriptUI Panels)
  for dir in "$HOME/Library/Application Support/Adobe/After Effects/"*"/Scripts/ScriptUI Panels"; do
    targets+=("$dir")
  done

  if [ "${#targets[@]}" = 0 ]; then
    warn "After Effects doesn't appear to be installed (no /Applications/Adobe After Effects … found)."
    warn "Install AE first, then re-run this. Or copy AutoCaption.jsx into its 'Scripts/ScriptUI Panels' folder by hand:"
    echo  "    $SOURCE_JSX"
  else
    found=0
    for dir in "${targets[@]}"; do
      mkdir -p "$dir" 2>/dev/null || true
      if cp "$SOURCE_JSX" "$dir/AutoCaption.jsx" 2>/dev/null && [ -f "$dir/AutoCaption.jsx" ]; then
        ok "installed → ${dir/#$HOME/~}"
        found=1
      elif [ -d "$dir" ]; then
        warn "couldn't write (needs admin): $dir"
        warn "  run:  sudo cp '$SOURCE_JSX' '$dir/AutoCaption.jsx'"
      fi
    done
    if [ "$found" = 1 ]; then
      ok "AutoCaption.jsx is in place. ${YELLOW}Fully quit (Cmd+Q) and reopen After Effects${NC} — it appears under the Window menu."
    fi
  fi
fi

echo
ok "${GREEN}All set.${NC}"
echo "    1. In After Effects: Preferences → Scripting & Expressions →"
echo "       enable 'Allow Scripts to Write Files and Access Network', then restart AE."
echo "    2. Open  Window → AutoCaption.jsx"
echo "    3. Paste a Groq (free) or OpenAI API key and caption away."
echo "       Free Groq key: https://console.groq.com/keys"
