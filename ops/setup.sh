#!/usr/bin/env bash
# Mac mini setup for the software factory. Idempotent: safe to run again after pulling updates.
#
#   bash ops/setup.sh                # tools, folders, config, npm deps, worker image
#   bash ops/setup.sh --power        # also: never sleep, restart after power loss (asks for your password)
#   bash ops/setup.sh --launchd      # also: install and start the orchestrator as a launchd service
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FACTORY_HOME="$HOME/factory"
CONFIG="$FACTORY_HOME/factory.config.yaml"
WITH_POWER=no
WITH_LAUNCHD=no
for arg in "$@"; do
  case "$arg" in
    --power) WITH_POWER=yes ;;
    --launchd) WITH_LAUNCHD=yes ;;
    *) echo "Unknown option $arg"; exit 1 ;;
  esac
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

[ "$(uname)" = "Darwin" ] || { echo "This script is for macOS."; exit 1; }

step "Homebrew packages"
if ! have brew; then
  echo "Install Homebrew first: https://brew.sh  (then re-run this script)"
  exit 1
fi
brew install node@24 git jq gh cloudflared >/dev/null
brew link --overwrite --force node@24 >/dev/null 2>&1 || true
for cask in orbstack 1password-cli tailscale; do
  brew list --cask "$cask" >/dev/null 2>&1 || brew install --cask "$cask"
done

step "Claude Code CLI"
if ! have claude; then
  npm install -g @anthropic-ai/claude-code
fi
claude --version

step "Folders and config"
mkdir -p "$FACTORY_HOME"/{state,repos,worktrees,logs}
if [ ! -e "$FACTORY_HOME/software-factory" ] && [ "$REPO_DIR" != "$FACTORY_HOME/software-factory" ]; then
  ln -s "$REPO_DIR" "$FACTORY_HOME/software-factory"
fi
if [ ! -f "$CONFIG" ]; then
  cp "$REPO_DIR/factory.config.example.yaml" "$CONFIG"
  echo "Created $CONFIG - edit the github section before starting the orchestrator."
fi

step "Node dependencies"
(cd "$REPO_DIR" && npm install --no-fund --no-audit)
(cd "$REPO_DIR" && npm test >/dev/null && echo "Unit tests pass.")

step "Worker image"
if ! docker info >/dev/null 2>&1; then
  open -a OrbStack || true
  echo "Waiting for OrbStack to start..."
  for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 2; done
fi
CLAUDE_VERSION="$(claude --version | awk '{print $1}')"
docker build -t "factory-worker:$CLAUDE_VERSION" --build-arg "CLAUDE_CODE_VERSION=$CLAUDE_VERSION" "$REPO_DIR/worker"
docker tag "factory-worker:$CLAUDE_VERSION" factory-worker:current
echo "Built factory-worker:$CLAUDE_VERSION (tagged current)"

if [ "$WITH_POWER" = yes ]; then
  step "Power settings (sudo)"
  sudo pmset -a sleep 0 disksleep 0 displaysleep 30 autorestart 1 womp 1 powernap 0
  sudo systemsetup -setrestartfreeze on >/dev/null 2>&1 || true
  pmset -g | grep -E ' sleep|autorestart'
fi

if [ "$WITH_LAUNCHD" = yes ]; then
  step "launchd service"
  if ! security find-generic-password -s factory-op-token -w >/dev/null 2>&1; then
    echo "Store the 1Password service-account token in your keychain first:"
    echo "  security add-generic-password -s factory-op-token -a factory -w '<token>'"
    exit 1
  fi
  PLIST="$HOME/Library/LaunchAgents/eu.peterszn.factory.orchestrator.plist"
  sed -e "s#__REPO_DIR__#$REPO_DIR#g" -e "s#__HOME__#$HOME#g" "$REPO_DIR/ops/launchd/eu.peterszn.factory.orchestrator.plist" > "$PLIST"
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "Orchestrator running. Logs: $FACTORY_HOME/logs/orchestrator.log"
fi

step "Done"
cat <<EOF
Next:
  1. Run the S0 spikes:   bash spikes/run-all.sh   (see spikes/README.md)
  2. Edit $CONFIG
  3. Follow docs/RUNBOOK.md for the GitHub App, 1Password vault and first project
EOF
