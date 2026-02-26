#!/usr/bin/env bash
set -euo pipefail

REPO="imjszhang/js-eyes"
SKILL_NAME="js-eyes"
INSTALL_DIR="${JS_EYES_DIR:-./skills}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { printf "${CYAN}[info]${NC}  %s\n" "$1"; }
ok()    { printf "${GREEN}[ok]${NC}    %s\n" "$1"; }
warn()  { printf "${YELLOW}[warn]${NC}  %s\n" "$1"; }
err()   { printf "${RED}[error]${NC} %s\n" "$1" >&2; }

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"
  elif command -v wget >/dev/null 2>&1; then wget -qO- "$1"
  else err "curl or wget is required."; exit 1; fi
}

download() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  else wget -qO "$2" "$1"; fi
}

confirm() {
  if [ "${JS_EYES_FORCE:-}" = "1" ]; then return 0; fi
  printf "  %s [y/N] " "$1"
  if [ -t 0 ]; then read -r reply
  elif [ -e /dev/tty ]; then read -r reply < /dev/tty
  else return 0; fi
  [ "$reply" = "y" ] || [ "$reply" = "Y" ]
}

# ── Prerequisites ─────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || { err "Node.js is required. Install: https://nodejs.org/"; exit 1; }
command -v npm  >/dev/null 2>&1 || { err "npm is required."; exit 1; }

# ── Resolve latest version ────────────────────────────────────────────
info "Fetching latest release from GitHub..."
TAG=$(fetch "https://api.github.com/repos/${REPO}/releases/latest" \
      | grep '"tag_name"' | head -1 | sed 's/.*"\(v[^"]*\)".*/\1/' || true)

if [ -n "$TAG" ]; then
  info "Latest version: ${TAG}"
  ARCHIVE_URL="https://github.com/${REPO}/archive/refs/tags/${TAG}.tar.gz"
else
  warn "Could not determine latest release — using main branch."
  ARCHIVE_URL="https://github.com/${REPO}/archive/refs/heads/main.tar.gz"
fi

# ── Prepare target directory ──────────────────────────────────────────
TARGET="${INSTALL_DIR}/${SKILL_NAME}"

if [ -d "$TARGET" ]; then
  warn "Directory already exists: ${TARGET}"
  confirm "Overwrite?" || { info "Aborted."; exit 0; }
  rm -rf "$TARGET"
fi

mkdir -p "$TARGET"

# ── Download and extract ──────────────────────────────────────────────
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

info "Downloading archive..."
download "$ARCHIVE_URL" "${TMPDIR}/archive.tar.gz"

info "Extracting skill bundle..."
tar xzf "${TMPDIR}/archive.tar.gz" -C "$TMPDIR"
EXTRACTED=$(find "$TMPDIR" -mindepth 1 -maxdepth 1 -type d | head -1)

if [ -z "$EXTRACTED" ]; then
  err "Failed to extract archive."; exit 1
fi

BUNDLE_FILES="SKILL.md SECURITY.md package.json LICENSE"
for f in $BUNDLE_FILES; do
  [ -f "${EXTRACTED}/${f}" ] && cp "${EXTRACTED}/${f}" "${TARGET}/"
done

for d in openclaw-plugin server clients; do
  [ -d "${EXTRACTED}/${d}" ] && cp -r "${EXTRACTED}/${d}" "${TARGET}/"
done

# ── Install dependencies ──────────────────────────────────────────────
info "Installing dependencies..."
(cd "$TARGET" && npm install --production 2>/dev/null || npm install)

# ── Done ──────────────────────────────────────────────────────────────
ABSOLUTE_TARGET=$(cd "$TARGET" && pwd)
PLUGIN_PATH="${ABSOLUTE_TARGET}/openclaw-plugin"

ok "JS Eyes installed to: ${ABSOLUTE_TARGET}"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Next: register the plugin in ~/.openclaw/openclaw.json"
echo ""
echo "  Add to plugins.load.paths:"
echo "    \"${PLUGIN_PATH}\""
echo ""
echo "  Add to plugins.entries:"
echo "    \"js-eyes\": {"
echo "      \"enabled\": true,"
echo "      \"config\": { \"serverPort\": 18080, \"autoStartServer\": true }"
echo "    }"
echo ""
echo "  Then restart OpenClaw."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
