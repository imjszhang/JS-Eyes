#!/usr/bin/env bash
set -euo pipefail

REPO="imjszhang/js-eyes"
SKILL_NAME="js-eyes"
SITE_URL="https://js-eyes.com"
INSTALL_DIR="${JS_EYES_DIR:-./skills}"
SUB_SKILL="${JS_EYES_SKILL:-${1:-}}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { printf "${CYAN}[info]${NC}  %s\n" "$1"; }
ok()    { printf "${GREEN}[ok]${NC}    %s\n" "$1"; }
warn()  { printf "${YELLOW}[warn]${NC}  %s\n" "$1"; }
err()   { printf "${RED}[error]${NC} %s\n" "$1" >&2; }

http_get() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"
  elif command -v wget >/dev/null 2>&1; then wget -qO- "$1"
  else err "curl or wget is required."; exit 1; fi
}

try_download() {
  local dest="$1"; shift
  for url in "$@"; do
    info "Trying: ${url}"
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL --connect-timeout 10 "$url" -o "$dest" 2>/dev/null && return 0
    elif command -v wget >/dev/null 2>&1; then
      wget --timeout=10 -qO "$dest" "$url" 2>/dev/null && return 0
    fi
    warn "Failed, trying next source..."
  done
  return 1
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

# ══════════════════════════════════════════════════════════════════════
# Sub-skill install: JS_EYES_SKILL=<id> or bash -s -- <skill-id>
# ══════════════════════════════════════════════════════════════════════
if [ -n "$SUB_SKILL" ]; then
  JS_EYES_ROOT="${INSTALL_DIR}/${SKILL_NAME}"
  if [ ! -d "$JS_EYES_ROOT" ]; then
    err "JS Eyes is not installed at ${JS_EYES_ROOT}."
    err "Install js-eyes first: curl -fsSL ${SITE_URL}/install.sh | bash"
    exit 1
  fi

  info "Installing extension skill: ${SUB_SKILL}"
  info "Fetching skill registry..."
  REGISTRY_JSON=$(http_get "${SITE_URL}/skills.json" 2>/dev/null || true)

  if [ -z "$REGISTRY_JSON" ]; then
    err "Could not fetch skill registry from ${SITE_URL}/skills.json"
    exit 1
  fi

  _download_urls_raw=$(node -e "
    let r; try { r = JSON.parse(process.argv[1]); } catch (_) { process.exit(1); }
    const s = r.skills && r.skills.find(x => x.id === process.argv[2]);
    if (!s) process.exit(1);
    const urls = [s.downloadUrl];
    if (s.downloadUrlFallback) urls.push(s.downloadUrlFallback);
    console.log(urls.join('\n'));
  " "$REGISTRY_JSON" "$SUB_SKILL" 2>/dev/null) || true

  if [ -z "$_download_urls_raw" ]; then
    err "Skill '${SUB_SKILL}' not found in registry."
    info "Available skills:"
    printf '%s' "$REGISTRY_JSON" | grep '"id"' | sed 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/  - \1/'
    exit 1
  fi

  download_urls=()
  while IFS= read -r _line; do
    [ -n "$_line" ] && download_urls+=("$_line")
  done <<< "$_download_urls_raw"

  TARGET="${JS_EYES_ROOT}/skills/${SUB_SKILL}"
  if [ -d "$TARGET" ]; then
    warn "Directory already exists: ${TARGET}"
    confirm "Overwrite?" || { info "Aborted."; exit 0; }
    rm -rf "$TARGET"
  fi
  mkdir -p "$TARGET"

  _tmpdir=$(mktemp -d)
  trap 'rm -rf "$_tmpdir"' EXIT

  SKILL_ZIP="${_tmpdir}/skill.zip"
  info "Downloading ${SUB_SKILL}..."
  if ! try_download "$SKILL_ZIP" "${download_urls[@]}"; then
    err "Failed to download skill bundle."; exit 1
  fi

  info "Extracting..."
  if command -v unzip >/dev/null 2>&1; then
    unzip -qo "$SKILL_ZIP" -d "$TARGET"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$SKILL_ZIP" "$TARGET"
  else
    err "unzip or python3 is required."; exit 1
  fi

  if [ -f "${TARGET}/package.json" ]; then
    info "Installing dependencies..."
    (cd "$TARGET" && npm install --production 2>/dev/null || npm install)
  fi

  ABSOLUTE_TARGET=$(cd "$TARGET" && pwd)
  PLUGIN_PATH="${ABSOLUTE_TARGET}/openclaw-plugin"

  ok "${SUB_SKILL} installed to: ${ABSOLUTE_TARGET}"
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Next: register the plugin in ~/.openclaw/openclaw.json"
  echo ""
  echo "  Add to plugins.load.paths:"
  echo "    \"${PLUGIN_PATH}\""
  echo ""
  echo "  Add to plugins.entries:"
  echo "    \"${SUB_SKILL}\": { \"enabled\": true }"
  echo ""
  echo "  Then restart OpenClaw."
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  exit 0
fi

# ══════════════════════════════════════════════════════════════════════
# Main skill install (no argument)
# ══════════════════════════════════════════════════════════════════════

# ── Resolve latest version ────────────────────────────────────────────
info "Fetching latest release info..."
TAG=$(http_get "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null \
      | grep '"tag_name"' | head -1 | sed 's/.*"\(v[^"]*\)".*/\1/' || true)

if [ -n "$TAG" ]; then
  info "Latest version: ${TAG}"
else
  warn "Could not determine latest release — using latest available."
fi

# ── Prepare target directory ──────────────────────────────────────────
TARGET="${INSTALL_DIR}/${SKILL_NAME}"

if [ -d "$TARGET" ]; then
  warn "Directory already exists: ${TARGET}"
  confirm "Overwrite?" || { info "Aborted."; exit 0; }
  rm -rf "$TARGET"
fi

mkdir -p "$TARGET"

# ── Download with multi-source fallback ───────────────────────────────
_tmpdir=$(mktemp -d)
trap 'rm -rf "$_tmpdir"' EXIT

SKILL_ZIP="${_tmpdir}/skill.zip"
ARCHIVE_ZIP="${_tmpdir}/archive.zip"
USE_SKILL_ZIP=0

urls_skill_zip=("${SITE_URL}/js-eyes-skill.zip")
urls_archive=()
if [ -n "$TAG" ]; then
  urls_archive=("https://github.com/${REPO}/archive/refs/tags/${TAG}.zip")
else
  urls_archive=("https://github.com/${REPO}/archive/refs/heads/main.zip")
fi

info "Downloading skill bundle..."

if try_download "$SKILL_ZIP" "${urls_skill_zip[@]}"; then
  USE_SKILL_ZIP=1
elif [ "${#urls_archive[@]}" -gt 0 ] && try_download "$ARCHIVE_ZIP" "${urls_archive[@]}"; then
  USE_SKILL_ZIP=0
else
  err "All download sources failed. Check your network and try again."
  exit 1
fi

# ── Extract ───────────────────────────────────────────────────────────
info "Extracting skill bundle..."

extract_zip() {
  local zipfile="$1" dest="$2"
  if command -v unzip >/dev/null 2>&1; then
    unzip -qo "$zipfile" -d "$dest"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$zipfile" "$dest"
  else
    err "unzip or python3 is required to extract the skill bundle zip."; exit 1
  fi
}

if [ "$USE_SKILL_ZIP" = "1" ]; then
  extract_zip "$SKILL_ZIP" "$TARGET"
else
  EXTRACT_DIR="${_tmpdir}/extract"
  mkdir -p "$EXTRACT_DIR"
  extract_zip "$ARCHIVE_ZIP" "$EXTRACT_DIR"
  EXTRACTED=""
  for d in "$EXTRACT_DIR"/*/; do
    [ -d "$d" ] && EXTRACTED="${d%/}" && break
  done
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
fi

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
