#!/usr/bin/env bash
set -euo pipefail

# Symphony self-hosted installer for Ubuntu 22.04/24.04

# Ensure common install paths are reachable (sudo bash strips PATH)
for p in /usr/local/bin /usr/local/sbin /snap/bin; do
  [[ ":$PATH:" != *":$p:"* ]] && export PATH="$p:$PATH"
done
# Pick up nvm-installed binaries from the invoking user's home
if [[ -n "${SUDO_USER:-}" ]]; then
  SUDO_HOME=$(eval echo "~${SUDO_USER}")
  for nvm_bin in "${SUDO_HOME}"/.nvm/versions/node/*/bin; do
    [[ -d "$nvm_bin" && ":$PATH:" != *":$nvm_bin:"* ]] && export PATH="$nvm_bin:$PATH"
  done
fi

REPO="markoinla/symphony"
BRANCH="main"
INSTALL_DIR="/opt/symphony"
RAW_BASE="https://raw.githubusercontent.com/${REPO}/${BRANCH}"
PLUGIN_VERSION="1.0.0"
WORKFLOW_FILES=(WORKFLOW.md ENRICHMENT.md TRIAGE.md MENTION.md REVIEW.md EPIC_SPLITTER.md MERGING.md)

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

# ── Safe .env loader ─────────────────────────────────────────────────────────────

load_env() {
  local env_file="${1:-${INSTALL_DIR}/.env}"
  [[ -f "${env_file}" ]] || return 0
  while IFS= read -r line || [[ -n "${line}" ]]; do
    # Skip comments and blank lines
    [[ "${line}" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${line}" ]] && continue
    # Extract key=value, stripping surrounding quotes from value
    local key="${line%%=*}"
    local val="${line#*=}"
    val="${val#\"}" ; val="${val%\"}"
    val="${val#\'}" ; val="${val%\'}"
    export "${key}=${val}"
  done < "${env_file}"
}

# ── Flag handlers ───────────────────────────────────────────────────────────────

handle_update() {
  header "Updating Symphony"
  cd "${INSTALL_DIR}"

  # Load existing env so HOST_HOME/WORKFLOWS_DIR are available
  if [[ -f "${INSTALL_DIR}/.env" ]]; then
    load_env
  fi

  curl -fsSL "${RAW_BASE}/install.sh" -o "${INSTALL_DIR}/install.sh"
  chmod +x "${INSTALL_DIR}/install.sh"
  info "Updated install.sh"

  curl -fsSL "${RAW_BASE}/docker-compose.prod.yml" -o "${INSTALL_DIR}/docker-compose.prod.yml"
  info "Updated docker-compose.prod.yml"

  install_skills
  info "Updated agent skills"

  install_workflows
  info "Updated workflow files"

  docker compose -f docker-compose.prod.yml pull
  docker compose -f docker-compose.prod.yml up -d
  info "Symphony updated successfully."
  exit 0
}

handle_reset_password() {
  header "Resetting authentication"
  docker exec symphony-postgres-1 psql -U symphony -d symphony \
    -c "DELETE FROM user_organizations; DELETE FROM users; DELETE FROM settings WHERE key = 'auth_password_hash';"
  info "All user accounts removed. Visit the dashboard to create a new account via /setup."
  exit 0
}

handle_uninstall() {
  header "Uninstalling Symphony"

  read -rp "This will stop all services and delete data. Continue? [y/N] " confirm
  [[ "$confirm" =~ ^[Yy]$ ]] || { info "Aborted."; exit 0; }

  # Resolve the real user's home
  local user_home
  if [[ -n "${SUDO_USER:-}" ]]; then
    user_home="$(getent passwd "$SUDO_USER" | cut -d: -f6)"
  else
    user_home="$HOME"
  fi

  # Stop services and remove Docker volumes
  cd "${INSTALL_DIR}" 2>/dev/null && \
    docker compose -f docker-compose.prod.yml down -v 2>/dev/null || true

  # Remove install directory
  rm -rf "${INSTALL_DIR}"
  info "Removed ${INSTALL_DIR} and all Docker volumes."

  # Remove workflow files
  rm -rf "${user_home}/.symphony"
  info "Removed ${user_home}/.symphony/"

  # Remove plugin entries from ~/.claude/plugins/
  local PLUGINS_DIR="${user_home}/.claude/plugins"
  if [[ -d "${PLUGINS_DIR}" ]]; then
    # Remove cached plugin and marketplace files
    rm -rf "${PLUGINS_DIR}/cache/symphony-skills"
    rm -rf "${PLUGINS_DIR}/marketplaces/symphony-skills"

    # Remove from installed_plugins.json
    if [[ -f "${PLUGINS_DIR}/installed_plugins.json" ]]; then
      local tmp
      tmp=$(mktemp)
      python3 -c "
import json, sys
with open('${PLUGINS_DIR}/installed_plugins.json') as f:
    data = json.load(f)
data.get('plugins', {}).pop('symphony-agent-skills@symphony-skills', None)
json.dump(data, sys.stdout, indent=2)
" > "${tmp}" && mv "${tmp}" "${PLUGINS_DIR}/installed_plugins.json" || true
    fi

    # Remove from known_marketplaces.json
    if [[ -f "${PLUGINS_DIR}/known_marketplaces.json" ]]; then
      local tmp
      tmp=$(mktemp)
      python3 -c "
import json, sys
with open('${PLUGINS_DIR}/known_marketplaces.json') as f:
    data = json.load(f)
data.pop('symphony-skills', None)
json.dump(data, sys.stdout, indent=2)
" > "${tmp}" && mv "${tmp}" "${PLUGINS_DIR}/known_marketplaces.json" || true
    fi

    # Fix ownership after modifications
    if [[ -n "${SUDO_USER:-}" ]]; then
      chown -R "${SUDO_USER}:${SUDO_USER}" "${PLUGINS_DIR}"
    fi

    info "Removed Symphony plugins from ${PLUGINS_DIR}"
  fi

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
  if command -v node &>/dev/null && command -v npm &>/dev/null; then
    info "Node.js is already installed: $(node --version)"
  else
    [[ -f /usr/bin/node ]] && warn "System Node.js found but npm is missing."
    warn "Installing Node.js v22 via NodeSource (includes npm)..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
    info "Node.js installed: $(node --version), npm $(npm --version)"
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

  # Check authentication as the real user (not root)
  local claude_authed=false
  if [[ -n "${SUDO_USER:-}" ]]; then
    sudo -u "$SUDO_USER" env "PATH=$PATH" claude auth status &>/dev/null 2>&1 && claude_authed=true
  else
    claude auth status &>/dev/null 2>&1 && claude_authed=true
  fi

  if [[ "$claude_authed" == "true" ]]; then
    info "Claude Code is authenticated."
  else
    warn "Claude Code is not authenticated."
    read -rp "  Run 'claude auth login' now? [Y/n] " ans
    if [[ ! "${ans}" =~ ^[Nn]$ ]]; then
      if [[ -n "${SUDO_USER:-}" ]]; then
        sudo -u "$SUDO_USER" env "PATH=$PATH" claude auth login || true
        sudo -u "$SUDO_USER" env "PATH=$PATH" claude auth status &>/dev/null 2>&1 && claude_authed=true
      else
        claude auth login || true
        claude auth status &>/dev/null 2>&1 && claude_authed=true
      fi
      if [[ "$claude_authed" == "true" ]]; then
        info "Claude Code authenticated successfully."
      else
        warn "Authentication not completed. Run ${BOLD}claude auth login${NC} later."
      fi
    else
      warn "Skipped. Run ${BOLD}claude auth login${NC} to authenticate later."
    fi
  fi
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

  # Check authentication as the real user (not root)
  local gh_authed=false
  if [[ -n "${SUDO_USER:-}" ]]; then
    sudo -u "$SUDO_USER" env "PATH=$PATH" gh auth status &>/dev/null 2>&1 && gh_authed=true
  else
    gh auth status &>/dev/null 2>&1 && gh_authed=true
  fi

  if [[ "$gh_authed" == "true" ]]; then
    info "GitHub CLI is authenticated."
  else
    warn "GitHub CLI is not authenticated."
    read -rp "  Run 'gh auth login' now? [Y/n] " ans
    if [[ ! "${ans}" =~ ^[Nn]$ ]]; then
      if [[ -n "${SUDO_USER:-}" ]]; then
        sudo -u "$SUDO_USER" env "PATH=$PATH" gh auth login || true
        sudo -u "$SUDO_USER" env "PATH=$PATH" gh auth status &>/dev/null 2>&1 && gh_authed=true
      else
        gh auth login || true
        gh auth status &>/dev/null 2>&1 && gh_authed=true
      fi
      if [[ "$gh_authed" == "true" ]]; then
        info "GitHub CLI authenticated successfully."
      else
        warn "Authentication not completed. Run ${BOLD}gh auth login${NC} later."
      fi
    else
      warn "Skipped. Run ${BOLD}gh auth login${NC} to authenticate later."
    fi
  fi
}

# ── Download compose & Caddyfile ────────────────────────────────────────────────

download_files() {
  header "Downloading deployment files"
  mkdir -p "${INSTALL_DIR}"

  curl -fsSL "${RAW_BASE}/install.sh" -o "${INSTALL_DIR}/install.sh"
  chmod +x "${INSTALL_DIR}/install.sh"
  info "Downloaded install.sh"

  curl -fsSL "${RAW_BASE}/docker-compose.prod.yml" \
    -o "${INSTALL_DIR}/docker-compose.prod.yml"
  info "Downloaded docker-compose.prod.yml"
}

# ── Agent skills (Claude Code plugins) ───────────────────────────────────────

install_skills() {
  header "Agent skills"

  # Resolve the real user's home for ~/.claude/plugins
  local user_home="${HOST_HOME:-$HOME}"
  if [[ -z "${HOST_HOME:-}" ]] && [[ -n "${SUDO_USER:-}" ]]; then
    user_home="$(getent passwd "$SUDO_USER" | cut -d: -f6)"
  fi

  local PLUGINS_DIR="${user_home}/.claude/plugins"
  local PLUGIN_BASE="plugins/symphony-agent-skills"
  local CACHE_DIR="${PLUGINS_DIR}/cache/symphony-skills/symphony-agent-skills/${PLUGIN_VERSION}"
  local MARKETPLACE_DIR="${PLUGINS_DIR}/marketplaces/symphony-skills"

  mkdir -p "${CACHE_DIR}/skills/commit"
  mkdir -p "${CACHE_DIR}/skills/push"
  mkdir -p "${CACHE_DIR}/skills/pull"
  mkdir -p "${CACHE_DIR}/skills/land"
  mkdir -p "${CACHE_DIR}/skills/linear"
  mkdir -p "${MARKETPLACE_DIR}/.claude-plugin"
  mkdir -p "${MARKETPLACE_DIR}/plugins/symphony-agent-skills/skills"

  # Download plugin files to cache
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

  # Mirror plugin structure into marketplace dir (so Claude Code can discover it)
  for skill in "${SKILLS[@]}" land; do
    mkdir -p "${MARKETPLACE_DIR}/plugins/symphony-agent-skills/skills/${skill}"
    cp -r "${CACHE_DIR}/skills/${skill}/." \
      "${MARKETPLACE_DIR}/plugins/symphony-agent-skills/skills/${skill}/"
  done

  # Add symphony-skills to known_marketplaces.json (merge with existing)
  local KM_FILE="${PLUGINS_DIR}/known_marketplaces.json"
  if [[ -f "${KM_FILE}" ]]; then
    # Add our entry without clobbering existing marketplaces
    local tmp
    tmp=$(mktemp)
    python3 -c "
import json, sys
with open('${KM_FILE}') as f:
    data = json.load(f)
data['symphony-skills'] = {
    'source': {'source': 'github', 'repo': 'markoinla/symphony'},
    'installLocation': '${MARKETPLACE_DIR}',
    'lastUpdated': '$(date -u +%Y-%m-%dT%H:%M:%S.000Z)'
}
json.dump(data, sys.stdout, indent=2)
" > "${tmp}" && mv "${tmp}" "${KM_FILE}"
  else
    cat > "${KM_FILE}" <<KMEOF
{
  "symphony-skills": {
    "source": {
      "source": "github",
      "repo": "markoinla/symphony"
    },
    "installLocation": "${MARKETPLACE_DIR}",
    "lastUpdated": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  }
}
KMEOF
  fi

  # Add plugin to installed_plugins.json (merge with existing)
  local IP_FILE="${PLUGINS_DIR}/installed_plugins.json"
  local NOW
  NOW="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  if [[ -f "${IP_FILE}" ]]; then
    local tmp
    tmp=$(mktemp)
    python3 -c "
import json, sys
with open('${IP_FILE}') as f:
    data = json.load(f)
data.setdefault('version', 2)
data.setdefault('plugins', {})
data['plugins']['symphony-agent-skills@symphony-skills'] = [{
    'scope': 'user',
    'installPath': '${CACHE_DIR}',
    'version': '${PLUGIN_VERSION}',
    'installedAt': '${NOW}',
    'lastUpdated': '${NOW}'
}]
json.dump(data, sys.stdout, indent=2)
" > "${tmp}" && mv "${tmp}" "${IP_FILE}"
  else
    cat > "${IP_FILE}" <<IPEOF
{
  "version": 2,
  "plugins": {
    "symphony-agent-skills@symphony-skills": [
      {
        "scope": "user",
        "installPath": "${CACHE_DIR}",
        "version": "${PLUGIN_VERSION}",
        "installedAt": "${NOW}",
        "lastUpdated": "${NOW}"
      }
    ]
  }
}
IPEOF
  fi

  # Ensure the regular user owns their .claude directory
  if [[ -n "${SUDO_USER:-}" ]]; then
    chown -R "${SUDO_USER}:${SUDO_USER}" "${user_home}/.claude"
  fi

  info "Installed agent skills (v${PLUGIN_VERSION}) to ${PLUGINS_DIR}"
}

# ── Workflow files ───────────────────────────────────────────────────────────────

install_workflows() {
  header "Workflow files"

  # WORKFLOWS_DIR is set in generate_env / loaded from .env
  local wf_dir="${WORKFLOWS_DIR:-${HOST_HOME:?}/.symphony/workflows}"
  local checksums="${wf_dir}/.checksums"
  mkdir -p "${wf_dir}"

  local installed=0 skipped=0
  local -a downloaded=()

  for wf in "${WORKFLOW_FILES[@]}"; do
    # Skip files the user has modified (checksum differs from original)
    if [[ -f "${wf_dir}/${wf}" ]] && [[ -f "${checksums}" ]]; then
      local saved current
      saved=$(grep "  ${wf}\$" "${checksums}" | awk '{print $1}' || true)
      current=$(sha256sum "${wf_dir}/${wf}" | awk '{print $1}')
      if [[ -n "${saved}" ]] && [[ "${saved}" != "${current}" ]]; then
        warn "Skipping ${wf} (locally modified)"
        skipped=$((skipped + 1))
        continue
      fi
    fi

    curl -fsSL "${RAW_BASE}/${wf}" -o "${wf_dir}/${wf}"
    downloaded+=("${wf}")
    installed=$((installed + 1))
  done

  # Update checksums only for files we downloaded (preserve old entries for skipped files)
  for wf in "${downloaded[@]}"; do
    # Remove old entry for this file if present
    if [[ -f "${checksums}" ]]; then
      sed -i "/${wf}\$/d" "${checksums}"
    fi
    sha256sum "${wf_dir}/${wf}" >> "${checksums}"
  done

  # Ensure the regular user owns the directory
  if [[ -n "${SUDO_USER:-}" ]]; then
    chown -R "${SUDO_USER}:${SUDO_USER}" "$(dirname "${wf_dir}")"
  fi

  info "Installed ${installed} workflow files to ${wf_dir}"
  if [[ "${skipped}" -gt 0 ]]; then
    warn "Skipped ${skipped} locally modified file(s)"
  fi
}

# ── Generate .env ───────────────────────────────────────────────────────────────

generate_env() {
  header "Environment configuration"

  if [[ -f "${INSTALL_DIR}/.env" ]]; then
    info ".env already exists — skipping generation (won't overwrite)."
    load_env
    return
  fi

  # Resolve the real user's home (prefer SUDO_USER's home over root's)
  if [[ -n "${SUDO_USER:-}" ]]; then
    HOST_HOME="$(getent passwd "$SUDO_USER" | cut -d: -f6)"
  else
    HOST_HOME="$HOME"
  fi

  POSTGRES_PASSWORD="$(openssl rand -hex 32)"
  SECRET_KEY_BASE="$(openssl rand -hex 64)"

  WORKFLOWS_DIR="${HOST_HOME}/.symphony/workflows"
  PUBLIC_IP="$(curl -4 -sf --max-time 5 ifconfig.me || hostname -I | awk '{print $1}')"

  cat > "${INSTALL_DIR}/.env" <<EOF
HOST_HOME=${HOST_HOME}
WORKFLOWS_DIR=${WORKFLOWS_DIR}
POSTGRES_PASSWORD="${POSTGRES_PASSWORD}"
SYMPHONY_SECRET_KEY_BASE="${SECRET_KEY_BASE}"
DATABASE_URL="ecto://symphony:${POSTGRES_PASSWORD}@postgres:5432/symphony"
SYMPHONY_PROXY_REGISTRATION_SECRET="zy9eWdmJ6nWHrFF1WL0u2tLEqbh7FpqpZHzlJy5HC64="
SYMPHONY_PUBLIC_BASE_URL="http://${PUBLIC_IP}:4000"
EOF

  info "Generated .env at ${INSTALL_DIR}/.env"

  # Export so install_workflows and other steps can use HOST_HOME/WORKFLOWS_DIR
  load_env
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
  echo -e "  Dashboard: ${BOLD}http://${IP}:4000${NC}"
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
  install_workflows
  start_services
  print_success
}

main
