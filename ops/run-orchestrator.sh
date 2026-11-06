#!/usr/bin/env bash
# Started by launchd. Loads the 1Password service-account token from the macOS keychain, then runs the orchestrator.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

OP_SERVICE_ACCOUNT_TOKEN="$(security find-generic-password -s factory-op-token -w)"
export OP_SERVICE_ACCOUNT_TOKEN
export FACTORY_CONFIG="${FACTORY_CONFIG:-$HOME/factory/factory.config.yaml}"

cd "$REPO_DIR"
exec node --disable-warning=ExperimentalWarning orchestrator/src/main.ts
