#!/usr/bin/env bash
set -euo pipefail

# OpenStudy — Universal Linux Installer
# Free, privacy-first, open-source AI learning platform.

REPO_ZIP_URL="${OPENSTUDY_ZIP_URL:-https://github.com/simoneggert16-png/openstudy/archive/refs/heads/main.zip}"
XDG_DATA_DIR="${XDG_DATA_HOME:-${HOME}/.local/share}"
INSTALL_DIR="${XDG_DATA_DIR}/openstudy"
BIN_DIR="${HOME}/.local/bin"
DESKTOP_DIR="${XDG_DATA_DIR}/applications"
DESKTOP_FILE="${DESKTOP_DIR}/openstudy.desktop"
VAULT_DIR="${HOME}/Documents/OpenStudy-Vault"
APP_URL="http://127.0.0.1:5175"

echo "================================================================"
echo "  OpenStudy — Universeller Linux Installer"
echo "  Kostenlose Open-Source-Lernplattform · Privat & Lokal"
echo "================================================================"
echo ""
echo "  Zielordner:    ${INSTALL_DIR}"
echo "  Desktop-Entry: ${DESKTOP_FILE}"
echo "  Lern-Vault:    ${VAULT_DIR}"
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

  echo "[1/5] Node.js (>= 20) und npm werden benötigt."
  echo "      Beispiele zur Installation:"
  echo "      - Ubuntu/Debian: sudo apt update && sudo apt install -y nodejs npm"
  echo "      - Fedora:        sudo dnf install -y nodejs npm"
  echo "      - Arch:          sudo pacman -S nodejs npm"
  echo "      - Oder über nvm: https://nodejs.org/en/download"
  exit 1
}

download_archive() {
  local destination="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 2 -o "${destination}" "${REPO_ZIP_URL}"
    return $?
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "${destination}" "${REPO_ZIP_URL}"
    return $?
  fi
  return 1
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
  if command -v unzip >/dev/null 2>&1 && download_archive "${zip_file}"; then
    unzip -q "${zip_file}" -d "${extract_dir}"
    local candidate
    candidate="$(find "${extract_dir}" -mindepth 1 -maxdepth 2 -name "package.json" -print -quit || true)"
    if [[ -n "${candidate}" ]]; then
      source_root="$(dirname "${candidate}")"
    fi
  elif command -v git >/dev/null 2>&1; then
    echo "      Nutze git clone als Alternative..."
    git clone --depth 1 "https://github.com/simoneggert16-png/openstudy.git" "${extract_dir}/repo"
    source_root="${extract_dir}/repo"
  else
    # Offline fallback if launched inside a local checkout
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
    echo "Fehler: OpenStudy konnte nicht heruntergeladen werden (curl/wget + unzip oder git benötigt)."
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
    cp -r "${source_root}/." "${INSTALL_DIR}/"
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

  if prompt_yes_no "      Obsidian (Flatpak/AppImage) einrichten & Lern-Vault anlegen? [J/n]" "j"; then
    if command -v flatpak >/dev/null 2>&1; then
      if flatpak list --app 2>/dev/null | grep -q "md.obsidian.Obsidian"; then
        echo "      Obsidian (Flatpak) ist bereits installiert."
      else
        echo "      Installiere Obsidian über Flathub..."
        flatpak install -y flathub md.obsidian.Obsidian || \
          echo "      Hinweis: Obsidian AppImage findest du unter https://obsidian.md/download"
      fi
    elif command -v obsidian >/dev/null 2>&1; then
      echo "      Obsidian ist bereits installiert."
    else
      echo "      Flatpak nicht gefunden. Lade Obsidian (AppImage/deb) unter https://obsidian.md/download"
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

  if prompt_yes_no "      Hinweis zu Ollama für 100 % Offline-KI anzeigen? [j/N]" "n"; then
    if command -v ollama >/dev/null 2>&1; then
      echo "      Ollama ist bereits installiert: $(ollama --version 2>/dev/null || echo 'ok')"
    else
      echo "      Offizielle Ollama Linux-Installation: https://ollama.com/download/linux"
      echo "      Nach der Installation: ollama pull gemma3:4b"
    fi
  fi
}

create_launcher_and_desktop() {
  echo "[5/5] Erstelle Starter & .desktop-Verknüpfung..."
  local start_script="${INSTALL_DIR}/start-openstudy.sh"

  cat > "${start_script}" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

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

if command -v xdg-open >/dev/null 2>&1; then
  (sleep 3 && xdg-open "http://127.0.0.1:5175") >/dev/null 2>&1 &
fi

npm run dev -- --host 127.0.0.1 --port 5175
EOF

  chmod +x "${start_script}"

  mkdir -p "${BIN_DIR}"
  ln -sf "${start_script}" "${BIN_DIR}/openstudy"

  mkdir -p "${DESKTOP_DIR}"
  cat > "${DESKTOP_FILE}" <<EOF
[Desktop Entry]
Type=Application
Name=OpenStudy
Comment=Free, privacy-first, open-source AI learning studio
Exec=${start_script}
Terminal=true
Categories=Education;Office;
Keywords=study;learning;notes;flashcards;obsidian;
StartupNotify=true
EOF

  chmod +x "${DESKTOP_FILE}"
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "${DESKTOP_DIR}" 2>/dev/null || true
  fi

  echo "      Starter:       ${start_script}"
  echo "      CLI-Link:      ${BIN_DIR}/openstudy"
  echo "      Desktop-Entry: ${DESKTOP_FILE}"
}

ensure_node
download_and_extract
install_dependencies
setup_optional_tools
create_launcher_and_desktop

echo ""
echo "Einrichtung abgeschlossen. Alle Lerninhalte bleiben privat auf deinem Gerät."
echo ""

if prompt_yes_no "OpenStudy jetzt direkt im Browser starten? [J/n]" "j"; then
  exec "${INSTALL_DIR}/start-openstudy.sh"
fi
