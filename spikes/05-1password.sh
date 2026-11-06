#!/usr/bin/env bash
# S0-5: can a 1Password service account read secrets from the Factory vault?
# Setup: create vault "Factory", an item "SPIKE_TEST" (type: API Credential) with credential "hello",
# and a service account with read access to that vault. Export OP_SERVICE_ACCOUNT_TOKEN.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
NAME="S0-5 1Password service account"

if ! have op; then result "$NAME" SKIP "1Password CLI (op) not installed"; exit 0; fi
if ! need_env OP_SERVICE_ACCOUNT_TOKEN >/dev/null; then result "$NAME" SKIP "OP_SERVICE_ACCOUNT_TOKEN not set"; exit 0; fi

who=$(op whoami 2>&1 | tr '\n' ' ' | head -c 160)
value=$(run_with_timeout 30 op read --no-newline "op://Factory/SPIKE_TEST/credential" 2>&1)
if [ "$value" = "hello" ]; then
  vaults=$(op vault list --format json 2>/dev/null | jq -r '[.[].name] | join(",")')
  result "$NAME" PASS "read SPIKE_TEST; visible vaults: [$vaults]"
else
  result "$NAME" FAIL "whoami: $who; read: $(echo "$value" | head -c 160)"
fi
