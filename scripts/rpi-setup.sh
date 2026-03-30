#!/usr/bin/env bash
set -euo pipefail

# ─── Brain Polymarket Bot — Raspberry Pi Setup ──────────────────────────────
# Nainstaluje vsechno potrebne na ciste Raspberry Pi OS (Bookworm 64-bit).
# Pouziti: curl -sL <url> | bash   nebo   bash scripts/rpi-setup.sh
#
# Co nainstaluje:
#   - System updates + build tools
#   - Docker + Docker Compose (oficialni repo)
#   - Node.js 20 LTS (nodesource)
#   - Yarn 4 (corepack)
#   - Git
#   - SQLite3
#   - Naklonuje repo a pripravi .env
# ─────────────────────────────────────────────────────────────────────────────

REPO_URL="https://github.com/janblazej/brain-polymarket-bot.git"
INSTALL_DIR="$HOME/brain-polymarket-bot"

echo "========================================"
echo "  Brain Polymarket Bot — RPi Setup"
echo "========================================"
echo ""

# ─── 1. System update ───────────────────────────────────────────────────────

echo "[1/7] System update..."
sudo apt-get update -qq
sudo apt-get upgrade -y -qq

# ─── 2. Build essentials + tools ─────────────────────────────────────────────

echo "[2/7] Installing build tools..."
sudo apt-get install -y -qq \
  curl \
  wget \
  git \
  ca-certificates \
  gnupg \
  lsb-release \
  build-essential \
  python3 \
  sqlite3 \
  htop \
  jq

# ─── 3. Docker + Docker Compose ─────────────────────────────────────────────

echo "[3/7] Installing Docker..."

if command -v docker &>/dev/null; then
  echo "  Docker already installed: $(docker --version)"
else
  # Add Docker's official GPG key
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg

  # Add Docker repo (Raspberry Pi OS is Debian-based)
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
    $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
    sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

  sudo apt-get update -qq
  sudo apt-get install -y -qq \
    docker-ce \
    docker-ce-cli \
    containerd.io \
    docker-buildx-plugin \
    docker-compose-plugin

  # Add current user to docker group (no sudo needed for docker commands)
  sudo usermod -aG docker "$USER"
  echo "  Docker installed: $(docker --version)"
  echo "  Docker Compose: $(docker compose version)"
fi

# ─── 4. Node.js 20 LTS ──────────────────────────────────────────────────────

echo "[4/7] Installing Node.js 20..."

if command -v node &>/dev/null && node -v | grep -q "v20"; then
  echo "  Node.js already installed: $(node -v)"
else
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
  echo "  Node.js installed: $(node -v)"
fi

# ─── 5. Yarn 4 via Corepack ─────────────────────────────────────────────────

echo "[5/7] Enabling Yarn 4..."
sudo corepack enable
corepack prepare yarn@4.13.0 --activate
echo "  Yarn: $(yarn -v)"

# ─── 6. Clone repo + install deps ───────────────────────────────────────────

echo "[6/7] Setting up project..."

if [ -d "$INSTALL_DIR" ]; then
  echo "  Directory exists, pulling latest..."
  cd "$INSTALL_DIR"
  git pull --ff-only
else
  echo "  Cloning repo..."
  git clone "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

echo "  Installing dependencies..."
yarn install

# ─── 7. Environment config ──────────────────────────────────────────────────

echo "[7/7] Preparing environment..."

if [ ! -f .env ]; then
  cp .env.example .env
  echo "  Created .env from .env.example"
  echo ""
  echo "  !! DULEZITE: Nastav OPENAI_API_KEY v .env !!"
  echo "  nano $INSTALL_DIR/.env"
else
  echo "  .env already exists, skipping"
fi

# Create data directory for SQLite databases
mkdir -p data

# ─── Done ────────────────────────────────────────────────────────────────────

echo ""
echo "========================================"
echo "  Setup Complete!"
echo "========================================"
echo ""
echo "Dalsi kroky:"
echo ""
echo "  1. Nastav API klice:"
echo "     nano $INSTALL_DIR/.env"
echo "     -> OPENAI_API_KEY=sk-..."
echo ""
echo "  2. Spust vsechny services:"
echo "     cd $INSTALL_DIR"
echo "     docker compose up -d"
echo ""
echo "  3. Over ze vsechno bezi:"
echo "     docker compose ps"
echo "     curl http://localhost:3000/health | jq"
echo ""
echo "  4. Sleduj logy:"
echo "     docker compose logs -f feature-engine agent-gateway"
echo ""
echo "  5. Dashboard:"
echo "     http://<rpi-ip>:3100"
echo ""
echo "  Porty: 3000 (API) | 3100 (Dashboard) | 3001-3013 (Services)"
echo ""

# Remind about docker group (needs re-login)
if ! groups | grep -q docker; then
  echo "  POZOR: Odloguj se a prihlasi zpet aby fungovaly docker"
  echo "  prikazy bez sudo (pridano do docker group)."
  echo ""
fi
