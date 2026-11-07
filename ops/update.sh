#!/usr/bin/env bash
# Update the running factory to origin/main, safely:
#   1. refuse local changes; show what's new
#   2. pause new runs and wait for running agents to finish (or --now: interrupt them; they resume after the restart)
#   3. fast-forward, install, typecheck, test and build; any failure puts the old commit back, no restart
#   4. restart, then wait for /api/health to report the new commit with a fresh heartbeat
#   5. if it doesn't come up healthy: roll back to the old commit, rebuild and restart again
# Usage: bash ops/update.sh [--now] [--wait <minutes>] [--yes]
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
# Bash reads a script as it runs, and this one is replaced by the update: run from a copy.
if [ -z "${FACTORY_UPDATE_REPO:-}" ]; then
  FACTORY_UPDATE_REPO="$(cd "$(dirname "$0")/.." && pwd)"; export FACTORY_UPDATE_REPO
  copy="$(mktemp -t factory-update)"; cp "$0" "$copy"
  exec bash "$copy" "$@"
fi
REPO="$FACTORY_UPDATE_REPO"
LABEL="${FACTORY_LAUNCHD_LABEL:-eu.peterszn.factory.orchestrator}"
PORT="${FACTORY_DASHBOARD_PORT:-4777}"
LOG="${FACTORY_LOGS:-$HOME/factory/logs}/update.log"
export FACTORY_CONFIG="${FACTORY_CONFIG:-$HOME/factory/factory.config.yaml}"
NOW=0; WAIT_MIN=30; YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --now) NOW=1 ;;
    --wait) WAIT_MIN="$2"; shift ;;
    --yes|-y) YES=1 ;;
    *) echo "Unknown option $1"; exit 2 ;;
  esac
  shift
done
mkdir -p "$(dirname "$LOG")"
say() { echo "$*"; echo "$(date '+%F %T') $*" >> "$LOG"; }
cli() { node --disable-warning=ExperimentalWarning "$REPO/orchestrator/src/cli.ts" "$@"; }
cd "$REPO"

[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || { echo "Not on main."; exit 1; }
git diff --quiet && git diff --cached --quiet || { echo "There are local changes; commit or stash them first."; exit 1; }
OLD="$(git rev-parse HEAD)"
git fetch -q origin main
NEW="$(git rev-parse origin/main)"
if [ "$OLD" = "$NEW" ]; then echo "Already up to date ($(git log -1 --format='%h %s'))."; exit 0; fi
git merge-base --is-ancestor "$OLD" "$NEW" || { echo "Local main has commits that aren't on origin/main; push or reset them first."; exit 1; }
echo "New on origin/main:"
git log --format='  %h %s' "$OLD..$NEW"
if [ "$YES" = 0 ]; then read -r -p "Update now? [y/N] " a; [ "$a" = y ] || [ "$a" = Y ] || exit 0; fi
say "update ${OLD:0:7} -> ${NEW:0:7} started"

# Builds the checkout in place: dependencies when the lockfiles changed, then the checks and the dashboard.
install_and_build() {
  local from="$1" to="$2" check="$3"
  if ! git diff --quiet "$from" "$to" -- package-lock.json; then npm ci --no-audit --no-fund >/dev/null; fi
  if ! git diff --quiet "$from" "$to" -- dashboard/package-lock.json; then (cd dashboard && npm ci --no-audit --no-fund >/dev/null); fi
  if [ "$check" = 1 ]; then
    npm run -s typecheck
    npm test >/tmp/factory-update-test.log 2>&1 || { tail -40 /tmp/factory-update-test.log; return 1; }
    (cd dashboard && npx tsc -b)
  fi
  (cd dashboard && npm run -s build >/dev/null)
}

health() { curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true; }
# Waits until the running process reports commit $1 with a heartbeat after $2.
wait_healthy() {
  local want="$1" since="$2"
  for _ in $(seq 1 60); do
    local h; h="$(health)"
    if [ -n "$h" ] && node -e '
      const h = JSON.parse(process.argv[1]);
      process.exit(h.version === process.argv[2] && (h.heartbeatAt ?? 0) >= Number(process.argv[3]) ? 0 : 1);
    ' "$h" "$want" "$since"; then return 0; fi
    sleep 3
  done
  return 1
}
restart() { launchctl kickstart -k "gui/$(id -u)/$LABEL"; }
running_agents() { docker ps -q --filter label=factory.role 2>/dev/null | wc -l | tr -d ' '; }

PAUSED=0
resume_if_paused() { if [ "$PAUSED" = 1 ]; then cli resume >/dev/null; fi; }
trap resume_if_paused EXIT
if [ "$NOW" = 0 ] && [ "$(running_agents)" -gt 0 ]; then
  cli pause 2 >/dev/null; PAUSED=1
  say "paused new runs; waiting up to $WAIT_MIN min for $(running_agents) running agent(s) to finish"
  deadline=$(( $(date +%s) + WAIT_MIN * 60 ))
  while [ "$(running_agents)" -gt 0 ]; do
    if [ "$(date +%s)" -ge "$deadline" ]; then say "agents still running after $WAIT_MIN min; run again later or with --now"; exit 1; fi
    sleep 15
  done
fi

git merge -q --ff-only "$NEW"
if ! install_and_build "$OLD" "$NEW" 1; then
  say "checks failed on ${NEW:0:7}; staying on ${OLD:0:7} (not restarted)"
  git reset -q --hard "$OLD"
  install_and_build "$NEW" "$OLD" 0
  exit 1
fi

T=$(date +%s)
restart
if wait_healthy "$NEW" "$T"; then
  say "updated to ${NEW:0:7}; healthy"
  exit 0
fi

say "${NEW:0:7} didn't come up healthy; rolling back to ${OLD:0:7}"
tail -20 "$HOME"/factory/logs/orchestrator*.log 2>/dev/null || true
git reset -q --hard "$OLD"
install_and_build "$NEW" "$OLD" 0
T=$(date +%s)
restart
if wait_healthy "$OLD" "$T"; then say "rolled back to ${OLD:0:7}; healthy"; else say "rollback to ${OLD:0:7} isn't healthy either; check the orchestrator log"; fi
exit 1
