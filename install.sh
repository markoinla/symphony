#!/usr/bin/env bash
set -euo pipefail

# Symphony self-hosted installer for Ubuntu 22.04/24.04

REPO="markoinla/symphony"
BRANCH="main"
INSTALL_DIR="/opt/symphony"
RAW_BASE="https://raw.githubusercontent.com/${REPO}/${BRANCH}"
SEED_DIR="${INSTALL_DIR}/plugin-seed"
PLUGIN_VERSION="1.0.0"

# ── Colors ──────────────────────────────────────────────────────────────────────

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m' # No Color

info()    { echo -e "${GREEN}✓${NC} $*"; }
warn()    { echo -e "${YELLOW}⚠${NC} $*"; }
err()     { echo -e "${RED}✗${NC} $*" >&2; }
header()  { echo -e "\n${BOLD}── $* ──${NC}"; }

# ── Flag handlers ───────────────────────────────────────────────────────────────

handle_update() {
  header "Updating Symphony"
  cd "${INSTALL_DIR}"

  curl -fsSL "${RAW_BASE}/install.sh" -o "${INSTALL_DIR}/install.sh"
  chmod +x "${INSTALL_DIR}/install.sh"
  info "Updated install.sh"

  curl -fsSL "${RAW_BASE}/docker-compose.prod.yml" -o "${INSTALL_DIR}/docker-compose.prod.yml"
  info "Updated docker-compose.prod.yml"

  curl -fsSL "${RAW_BASE}/deploy/Caddyfile" -o "${INSTALL_DIR}/Caddyfile"
  info "Updated Caddyfile"

  install_skills
  info "Updated agent skills"

  docker compose -f docker-compose.prod.yml pull
  docker compose -f docker-compose.prod.yml up -d
  info "Symphony updated successfully."
  exit 0
}

handle_reset_password() {
  header "Resetting password"
  docker exec symphony-postgres-1 psql -U symphony -d symphony \
    -c "DELETE FROM settings WHERE key = 'auth_password_hash';"
  info "Password cleared. Visit the dashboard to set a new one."
  exit 0
}

handle_uninstall() {
  header "Uninstalling Symphony"

  read -rp "This will stop all services and delete data. Continue? [y/N] " confirm
  [[ "$confirm" =~ ^[Yy]$ ]] || { info "Aborted."; exit 0; }

  cd "${INSTALL_DIR}" 2>/dev/null && \
    docker compose -f docker-compose.prod.yml down -v 2>/dev/null || true

  rm -rf "${INSTALL_DIR}"
  info "Removed ${INSTALL_DIR} and all Docker volumes."
  info "Symphony has been uninstalled."
  exit 0
}

# ── Root check ──────────────────────────────────────────────────────────────────

check_root() {
  if [[ "$EUID" -ne 0 ]]; then
    err "This script must be run as root (use sudo)."
    exit 1
  fi
  info "Running as root."
}

# ── Docker ──────────────────────────────────────────────────────────────────────

install_docker() {
  header "Docker"
  if command -v docker &>/dev/null; then
    info "Docker is already installed: $(docker --version)"
  else
    warn "Docker not found. Installing..."
    curl -fsSL https://get.docker.com | sh
    info "Docker installed."
  fi

  if [[ -n "${SUDO_USER:-}" ]]; then
    usermod -aG docker "$SUDO_USER" 2>/dev/null || true
    info "Added $SUDO_USER to the docker group."
  fi
}

# ── Node.js 22 ──────────────────────────────────────────────────────────────────

install_node() {
  header "Node.js"
  if command -v node &>/dev/null; then
    NODE_VER="$(node --version)"
    info "Node.js is already installed: ${NODE_VER}"
  else
    warn "Node.js not found. Installing v22 via NodeSource..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
    info "Node.js installed: $(node --version)"
  fi
}

# ── Claude Code CLI ─────────────────────────────────────────────────────────────

install_claude() {
  header "Claude Code CLI"
  if command -v claude &>/dev/null; then
    info "Claude Code CLI is already installed."
  else
    warn "Claude Code CLI not found. Installing..."
    npm install -g @anthropic-ai/claude-code
    info "Claude Code CLI installed."
  fi
  warn "Reminder: run ${BOLD}claude auth login${NC} to authenticate."
}

# ── GitHub CLI ──────────────────────────────────────────────────────────────────

install_gh() {
  header "GitHub CLI"
  if command -v gh &>/dev/null; then
    info "GitHub CLI is already installed: $(gh --version | head -1)"
  else
    warn "GitHub CLI not found. Installing..."
    (type -p wget >/dev/null || (apt-get update && apt-get install -y wget)) \
      && mkdir -p -m 755 /etc/apt/keyrings \
      && out=$(mktemp) \
      && wget -qO "$out" https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      && cat "$out" | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null \
      && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
      && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        | tee /etc/apt/sources.list.d/github-cli.list >/dev/null \
      && apt-get update \
      && apt-get install -y gh
    info "GitHub CLI installed."
  fi
  warn "Reminder: run ${BOLD}gh auth login${NC} to authenticate."
}

# ── Download compose & Caddyfile ────────────────────────────────────────────────

download_files() {
  header "Downloading deployment files"
  mkdir -p "${INSTALL_DIR}"

  curl -fsSL "${RAW_BASE}/docker-compose.prod.yml" \
    -o "${INSTALL_DIR}/docker-compose.prod.yml"
  info "Downloaded docker-compose.prod.yml"

  curl -fsSL "${RAW_BASE}/deploy/Caddyfile" \
    -o "${INSTALL_DIR}/Caddyfile"
  info "Downloaded Caddyfile"
}

# ── Agent skills (plugin seed) ────────────────────────────────────────────────

install_skills() {
  header "Agent skills"

  local PLUGIN_BASE="plugins/symphony-agent-skills"
  local CACHE_DIR="${SEED_DIR}/cache/symphony-skills/symphony-agent-skills/${PLUGIN_VERSION}"
  local MARKETPLACE_DIR="${SEED_DIR}/marketplaces/symphony-skills"

  mkdir -p "${CACHE_DIR}/skills/commit"
  mkdir -p "${CACHE_DIR}/skills/push"
  mkdir -p "${CACHE_DIR}/skills/pull"
  mkdir -p "${CACHE_DIR}/skills/land"
  mkdir -p "${CACHE_DIR}/skills/linear"
  mkdir -p "${CACHE_DIR}/.claude-plugin"
  mkdir -p "${MARKETPLACE_DIR}/.claude-plugin"

  # Download plugin manifest
  curl -fsSL "${RAW_BASE}/${PLUGIN_BASE}/.claude-plugin/plugin.json" \
    -o "${CACHE_DIR}/.claude-plugin/plugin.json"

  # Download skill files
  local SKILLS=(commit push pull linear)
  for skill in "${SKILLS[@]}"; do
    curl -fsSL "${RAW_BASE}/${PLUGIN_BASE}/skills/${skill}/SKILL.md" \
      -o "${CACHE_DIR}/skills/${skill}/SKILL.md"
  done

  # Land skill has SKILL.md + land_watch.py
  curl -fsSL "${RAW_BASE}/${PLUGIN_BASE}/skills/land/SKILL.md" \
    -o "${CACHE_DIR}/skills/land/SKILL.md"
  curl -fsSL "${RAW_BASE}/${PLUGIN_BASE}/skills/land/land_watch.py" \
    -o "${CACHE_DIR}/skills/land/land_watch.py"

  # Download marketplace definition
  curl -fsSL "${RAW_BASE}/.claude-plugin/marketplace.json" \
    -o "${MARKETPLACE_DIR}/.claude-plugin/marketplace.json"

  # Write known_marketplaces.json
  cat > "${SEED_DIR}/known_marketplaces.json" <<'SEED_EOF'
{
  "symphony-skills": {
    "source": {
      "source": "github",
      "repo": "markoinla/symphony"
    }
  }
}
SEED_EOF

  info "Installed agent skills (v${PLUGIN_VERSION})"
}

# ── Generate .env ───────────────────────────────────────────────────────────────

generate_env() {
  header "Environment configuration"

  if [[ -f "${INSTALL_DIR}/.env" ]]; then
    info ".env already exists — skipping generation (won't overwrite)."
    return
  fi

  # Resolve the real user's home (prefer SUDO_USER's home over root's)
  if [[ -n "${SUDO_USER:-}" ]]; then
    HOST_HOME="$(getent passwd "$SUDO_USER" | cut -d: -f6)"
  else
    HOST_HOME="$HOME"
  fi

  POSTGRES_PASSWORD="$(openssl rand -base64 32)"
  SECRET_KEY_BASE="$(openssl rand -base64 64)"

  cat > "${INSTALL_DIR}/.env" <<EOF
HOST_HOME=${HOST_HOME}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
SYMPHONY_SECRET_KEY_BASE=${SECRET_KEY_BASE}
DATABASE_URL=ecto://symphony:${POSTGRES_PASSWORD}@postgres:5432/symphony
SYMPHONY_PROXY_REGISTRATION_SECRET=zy9eWdmJ6nWHrFF1WL0u2tLEqbh7FpqpZHzlJy5HC64=
CLAUDE_CODE_PLUGIN_SEED_DIR=${SEED_DIR}
EOF

  info "Generated .env at ${INSTALL_DIR}/.env"
}

# ── Start services ──────────────────────────────────────────────────────────────

start_services() {
  header "Starting Symphony"
  cd "${INSTALL_DIR}"
  docker compose -f docker-compose.prod.yml up -d
  info "Services started."
}

# ── Print success ──────────────────────────────────────────────────────────────

print_success() {
  IP=$(curl -4 -sf ifconfig.me || hostname -I | awk '{print $1}')
  echo ""
  echo -e "${GREEN}${BOLD}════════════════════════════════════════════════${NC}"
  echo -e "${GREEN}${BOLD}  Symphony is running!${NC}"
  echo -e "${GREEN}${BOLD}════════════════════════════════════════════════${NC}"
  echo ""
  echo -e "  Dashboard: ${BOLD}http://${IP}${NC}"
  echo ""
  echo -e "  Useful commands:"
  echo -e "    Update:          ${BOLD}sudo bash ${INSTALL_DIR}/install.sh --update${NC}"
  echo -e "    Reset password:  ${BOLD}sudo bash ${INSTALL_DIR}/install.sh --reset-password${NC}"
  echo -e "    Uninstall:       ${BOLD}sudo bash ${INSTALL_DIR}/install.sh --uninstall${NC}"
  echo -e "    View logs:       ${BOLD}cd ${INSTALL_DIR} && docker compose -f docker-compose.prod.yml logs -f${NC}"
  echo ""
}

# ── Parse flags ─────────────────────────────────────────────────────────────────

for arg in "$@"; do
  case "$arg" in
    --update)         handle_update ;;
    --reset-password) handle_reset_password ;;
    --uninstall)      handle_uninstall ;;
    *)                err "Unknown flag: $arg"; exit 1 ;;
  esac
done

# ── Main ────────────────────────────────────────────────────────────────────────

main() {
  echo -e "${BOLD}Symphony Installer${NC}"
  echo ""

  check_root
  install_docker
  install_node
  install_claude
  install_gh
  download_files
  install_skills
  generate_env
  start_services
  print_success
}

main
