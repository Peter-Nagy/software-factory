#!/usr/bin/env bash
# Started by launchd. Loads the 1Password service-account token from the macOS keychain, then runs the orchestrator.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

OP_SERVICE_ACCOUNT_TOKEN="$(security find-generic-password -s factory-op-token -w)"
export OP_SERVICE_ACCOUNT_TOKEN
export FACTORY_CONFIG="${FACTORY_CONFIG:-$HOME/factory/factory.config.yaml}"

# After a reboot Docker may not be up yet: start it and wait, so no run fails for lack of a container runtime.
if ! docker info >/dev/null 2>&1; then
  if [ -d /Applications/Docker.app ]; then open -ga Docker; elif [ -d /Applications/OrbStack.app ]; then open -ga OrbStack; fi
  for _ in $(seq 1 150); do docker info >/dev/null 2>&1 && break; sleep 2; done
  docker info >/dev/null 2>&1 || { echo "$(date) Docker did not start; exiting so launchd retries"; exit 1; }
fi

cd "$REPO_DIR"
exec node --disable-warning=ExperimentalWarning orchestrator/src/main.ts
