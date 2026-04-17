#!/usr/bin/env bash
# GratisGIS one-liner installer (prototype / skeleton).
#
# Target: Ubuntu 22.04+ or Debian 12+, root access, a domain pointing here.
#
# Design goals (see ../../docs/deployment.md):
#   - zero questions past the initial flags
#   - strong-random secrets generated locally
#   - HTTPS via Caddy + Let's Encrypt
#   - idempotent: re-running is safe
#
# Usage:
#   curl -fsSL https://get.gratisgis.org | sudo bash -s -- \
#     --domain portal.acme.org --email admin@acme.org
#
# This file is the blueprint; most functions are stubs and will be
# fleshed out in Phase 8 (Hardening).
set -euo pipefail

DOMAIN=""
EMAIL=""
VERSION="latest"
INSTALL_DIR="/etc/gratisgis"
DATA_DIR="/var/lib/gratisgis"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email)  EMAIL="$2";  shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    -h|--help)
      sed -n '3,20p' "$0"; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$DOMAIN" || -z "$EMAIL" ]]; then
  echo "ERROR: --domain and --email are required" >&2
  exit 1
fi

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: must run as root (try: sudo bash)" >&2
  exit 1
fi

log() { printf "\033[1;34m==> %s\033[0m\n" "$*"; }

preflight() {
  log "Running preflight checks"
  . /etc/os-release
  case "$ID" in
    ubuntu|debian) ;;
    *) echo "Unsupported distro: $ID (need Ubuntu or Debian)"; exit 1 ;;
  esac

  local cpu mem disk
  cpu=$(nproc)
  mem=$(awk '/MemTotal/ {print int($2/1024/1024)}' /proc/meminfo)
  disk=$(df -BG --output=avail / | tail -1 | tr -d 'G ')

  (( cpu  >= 2 )) || { echo "Need >= 2 CPUs (have $cpu)"; exit 1; }
  (( mem  >= 4 )) || { echo "Need >= 4 GB RAM (have ${mem}G)"; exit 1; }
  (( disk >= 20 )) || { echo "Need >= 20 GB free disk (have ${disk}G)"; exit 1; }
}

install_docker() {
  if command -v docker >/dev/null 2>&1; then return; fi
  log "Installing Docker Engine"
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
}

generate_secrets() {
  log "Generating secrets (one-time)"
  mkdir -p "$INSTALL_DIR"
  local env="$INSTALL_DIR/.env"
  if [[ -f "$env" ]]; then
    log "  secrets already exist, skipping"
    return
  fi
  umask 077
  cat > "$env" <<EOF
DOMAIN=$DOMAIN
EMAIL=$EMAIL
POSTGRES_PASSWORD=$(openssl rand -hex 16)
KEYCLOAK_ADMIN_PASSWORD=$(openssl rand -hex 16)
MINIO_ROOT_PASSWORD=$(openssl rand -hex 16)
NEXTAUTH_SECRET=$(openssl rand -hex 32)
PORTAL_ADMIN_INITIAL_PASSWORD=$(openssl rand -hex 8)
EOF
}

pull_stack() {
  log "Fetching GratisGIS release: $VERSION"
  mkdir -p "$INSTALL_DIR/stack"
  # TODO: swap for a signed release tarball once we cut our first tag.
  cp -a /dev/null "$INSTALL_DIR/stack/docker-compose.yml" 2>/dev/null || true
  echo "# (placeholder: production compose file not yet published)" \
    > "$INSTALL_DIR/stack/docker-compose.yml"
}

start_stack() {
  log "Starting stack"
  cd "$INSTALL_DIR/stack"
  docker compose --env-file "$INSTALL_DIR/.env" up -d
}

print_summary() {
  local pw
  pw=$(grep PORTAL_ADMIN_INITIAL_PASSWORD "$INSTALL_DIR/.env" | cut -d= -f2)
  log "Install complete!"
  echo
  echo "  Portal URL:      https://$DOMAIN"
  echo "  Admin username:  admin"
  echo "  Admin password:  $pw"
  echo
  echo "  Change the password on first sign-in."
  echo "  Manage the deployment with: gratisgis --help"
}

preflight
install_docker
generate_secrets
pull_stack
start_stack
print_summary
