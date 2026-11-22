#!/usr/bin/env bash
set -euo pipefail

# OpenStudy — Universal macOS Installer
# Free, privacy-first, open-source AI learning platform.

REPO_ZIP_URL="${OPENSTUDY_ZIP_URL:-https://github.com/simoneggert16-png/openstudy/archive/refs/heads/main.zip}"
INSTALL_DIR="${HOME}/Applications/OpenStudy"
VAULT_DIR="${HOME}/Documents/OpenStudy-Vault"
DESKTOP_LAUNCHER="${HOME}/Desktop/OpenStudy.command"
APP_URL="http://127.0.0.1:5175"

# Ensure common Homebrew and Node paths are visible when launched via Finder
export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"

clear 2>/dev/null || true
echo "================================================================"
echo "  OpenStudy — Universeller macOS Installer"
echo "  Kostenlose Open-Source-Lernplattform · Privat & Lokal"
echo "================================================================"
echo ""
echo "  Zielordner:  ${INSTALL_DIR}"
echo "  Lern-Vault:  ${VAULT_DIR}"
echo ""

prompt_yes_no() {
  local prompt_text="$1"
  local default_answer="$2"
  local reply=""
  read -r -p "${prompt_text} " reply || reply=""
  if [[ -z "${reply}" ]]; then
    reply="${default_answer}"
  fi
  case "${reply}" in
    y|Y|j|J|yes|YES|ja|JA) return 0 ;;
    *) return 1 ;;
  esac
}

ensure_node() {
  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    echo "[1/5] Node.js erkannt: $(node -v)"
    return 0
  fi

  echo "[1/5] Node.js wurde nicht gefunden."
  if command -v brew >/dev/null 2>&1; then
    if prompt_yes_no "      Node.js automatisch via Homebrew installieren? [J/n]" "j"; then
      brew install node
      return 0
    fi
  fi

  echo "      Bitte installiere Node.js LTS von https://nodejs.org/en/download"
  echo "      und starte Install-OpenStudy.command danach erneut."
  open "https://nodejs.org/en/download" 2>/dev/null || true
  exit 1
}

download_and_extract() {
  echo "[2/5] Lade OpenStudy herunter..."
  mkdir -p "${INSTALL_DIR}"

  local env_backup=""
  if [[ -f "${INSTALL_DIR}/.env.local" ]]; then
    env_backup="$(cat "${INSTALL_DIR}/.env.local")"
  fi

  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "${tmp_dir}"' RETURN

  local zip_file="${tmp_dir}/openstudy.zip"
  local extract_dir="${tmp_dir}/extracted"
  mkdir -p "${extract_dir}"

  local source_root=""
  if curl -fsSL --retry 2 -o "${zip_file}" "${REPO_ZIP_URL}"; then
    unzip -q "${zip_file}" -d "${extract_dir}"
    local candidate
    candidate="$(find "${extract_dir}" -mindepth 1 -maxdepth 2 -name "package.json" -print -quit || true)"
    if [[ -n "${candidate}" ]]; then
      source_root="$(dirname "${candidate}")"
    fi
  else
    # Offline fallback when run directly inside a local OpenStudy checkout
    local script_dir
    script_dir="$(cd "$(dirname "$0")" && pwd)"
    local repo_parent
    repo_parent="$(cd "${script_dir}/../.." 2>/dev/null && pwd || true)"
    if [[ -f "${repo_parent}/package.json" ]]; then
      echo "      Offline-Fallback: nutze lokale OpenStudy-Dateien."
      source_root="${repo_parent}"
    fi
  fi

  if [[ -z "${source_root}" ]]; then
    echo "Fehler: OpenStudy konnte nicht heruntergeladen werden. Prüfe deine Internetverbindung."
    exit 1
  fi

  if command -v rsync >/dev/null 2>&1; then
    rsync -a \
      --exclude 'node_modules' \
      --exclude '.git' \
      --exclude 'dist' \
      --exclude '.env' \
      --exclude '.env.local' \
      --exclude 'private' \
      --exclude 'secrets' \
      "${source_root}/" "${INSTALL_DIR}/"
  else
    cp -R "${source_root}/." "${INSTALL_DIR}/"
    rm -rf "${INSTALL_DIR}/.git" "${INSTALL_DIR}/dist"
  fi

  if [[ -n "${env_backup}" ]]; then
    printf '%s\n' "${env_backup}" > "${INSTALL_DIR}/.env.local"
  fi
}

install_dependencies() {
  echo "[3/5] Installiere lokale Pakete (npm install)..."
  (
    cd "${INSTALL_DIR}"
    npm install --no-audit --no-fund
  )
}

setup_optional_tools() {
  echo "[4/5] Optionale Tools & Lern-Vault"

  if prompt_yes_no "      Obsidian mitinstallieren & Lern-Vault anlegen? [J/n]" "j"; then
    if [[ -d "/Applications/Obsidian.app" || -d "${HOME}/Applications/Obsidian.app" ]]; then
      echo "      Obsidian ist bereits installiert."
    elif command -v brew >/dev/null 2>&1; then
      echo "      Installiere Obsidian via Homebrew..."
      brew install --cask obsidian || open "https://obsidian.md/download" 2>/dev/null || true
    else
      echo "      Öffne offizielle Obsidian-Downloadseite (DMG)..."
      open "https://obsidian.md/download" 2>/dev/null || true
    fi

    mkdir -p "${VAULT_DIR}"
    if [[ ! -f "${VAULT_DIR}/Willkommen-bei-OpenStudy.md" ]]; then
      cat > "${VAULT_DIR}/Willkommen-bei-OpenStudy.md" <<'EOF'
# Willkommen in deinem OpenStudy Lern-Vault

Dieser Ordner gehört dir allein und bleibt vollständig lokal auf deinem Gerät.

## Erste Schritte
- Öffne diesen Ordner in **Obsidian** als lokalen Vault.
- Verknüpfe deinen Vault in **OpenStudy** unter *Import & Sync*.
- Erstelle für jedes Fach eigene Notizen und verlinke Konzepte mit `[[Begriff]]`.
EOF
    fi
    echo "      Lern-Vault bereit: ${VAULT_DIR}"
  fi

  if prompt_yes_no "      Ollama für 100 % Offline-KI (ohne API-Key) mitinstallieren? [j/N]" "n"; then
    if command -v ollama >/dev/null 2>&1 || [[ -d "/Applications/Ollama.app" ]]; then
      echo "      Ollama ist bereits installiert."
    elif command -v brew >/dev/null 2>&1; then
      echo "      Installiere Ollama via Homebrew..."
      brew install --cask ollama || open "https://ollama.com/download" 2>/dev/null || true
    else
      echo "      Öffne offizielle Ollama-Downloadseite..."
      open "https://ollama.com/download" 2>/dev/null || true
    fi
  fi
}

create_launcher() {
  echo "[5/5] Erstelle Starter..."
  local launcher="${INSTALL_DIR}/Start-OpenStudy.command"

  cat > "${launcher}" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "${APP_DIR}"

echo "================================================================"
echo "  OpenStudy — Lokale Lernplattform & Companion Bridge"
echo "  App:    http://127.0.0.1:5175"
echo "  Bridge: http://127.0.0.1:4319"
echo "  Fenster offen lassen, solange du lernst (Ctrl+C zum Beenden)."
echo "================================================================"
echo ""

BRIDGE_PID=""
cleanup() {
  if [[ -n "${BRIDGE_PID}" ]]; then
    kill "${BRIDGE_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if [[ -f "bridge/server.mjs" ]]; then
  node bridge/server.mjs &
  BRIDGE_PID=$!
fi

(sleep 3 && open "http://127.0.0.1:5175") >/dev/null 2>&1 &
npm run dev -- --host 127.0.0.1 --port 5175
EOF

  chmod +x "${launcher}"

  if prompt_yes_no "      Verknüpfung auf dem Schreibtisch (OpenStudy.command) anlegen? [J/n]" "j"; then
    ln -sf "${launcher}" "${DESKTOP_LAUNCHER}"
    echo "      Desktop-Verknüpfung erstellt: ${DESKTOP_LAUNCHER}"
  fi
}

ensure_node
download_and_extract
install_dependencies
setup_optional_tools
create_launcher

echo ""
echo "Einrichtung abgeschlossen. Alle Lerninhalte bleiben privat auf deinem Mac."
echo ""

if prompt_yes_no "OpenStudy jetzt direkt im Browser starten? [J/n]" "j"; then
  exec "${INSTALL_DIR}/Start-OpenStudy.command"
fi
