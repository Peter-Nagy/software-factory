#!/usr/bin/env bash
# The orchestrator's watchdog, run by launchd every 5 minutes (ops/launchd/eu.peterszn.factory.watchdog.plist).
# launchd already restarts a crashed orchestrator; this catches one that runs but is stuck (no fresh heartbeat on
# /api/health) or not answering. Two failed checks in a row: restart it, and push an alert if ntfy is configured
# (the orchestrator can't tell you itself that it's stuck). Pause it with: touch ~/factory/state/watchdog.off
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
LABEL="${FACTORY_LAUNCHD_LABEL:-eu.peterszn.factory.orchestrator}"
PORT="${FACTORY_DASHBOARD_PORT:-4777}"
STATE_DIR="${FACTORY_STATE:-$HOME/factory/state}"
CONFIG="${FACTORY_CONFIG:-$HOME/factory/factory.config.yaml}"
LOG="$HOME/factory/logs/watchdog.log"
COUNT_FILE="$STATE_DIR/watchdog.failures"
mkdir -p "$STATE_DIR" "$(dirname "$LOG")"
[ -f "$STATE_DIR/watchdog.off" ] && exit 0
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

push() { # title, body, priority
  grep -qE '^push:' "$CONFIG" 2>/dev/null || return 0
  local server topic token
  server="$(sed -n 's/^ *server: *\(https\{0,1\}:[^ ]*\).*/\1/p' "$CONFIG" | head -1)"
  token="$(security find-generic-password -s factory-op-token -w 2>/dev/null)" || return 0
  topic="$(OP_SERVICE_ACCOUNT_TOKEN="$token" op read --no-newline "op://Factory/NTFY_TOPIC/credential" 2>/dev/null)" || return 0
  curl -fsS --max-time 10 -H "X-Title: $1" -H "X-Priority: $3" -H "X-Tags: rotating_light" -d "$2" "${server:-https://ntfy.sh}/$topic" >/dev/null 2>&1 \
    || log "push failed"
}

health="$(curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)"
if [ -n "$health" ] && node -e 'process.exit(JSON.parse(process.argv[1]).ok === true ? 0 : 1)' "$health" 2>/dev/null; then
  failures="$(cat "$COUNT_FILE" 2>/dev/null || echo 0)"
  if [ "$failures" -ge 2 ]; then
    log "healthy again after $failures failed checks"
    push "Factory is back" "The orchestrator is healthy again." 3
  fi
  echo 0 > "$COUNT_FILE"
  exit 0
fi

failures=$(( $(cat "$COUNT_FILE" 2>/dev/null || echo 0) + 1 ))
echo "$failures" > "$COUNT_FILE"
log "check failed ($failures in a row): ${health:-no answer}"
if [ "$failures" = 2 ]; then
  log "restarting $LABEL"
  launchctl kickstart -k "gui/$(id -u)/$LABEL" >> "$LOG" 2>&1
  push "Factory restarted" "The orchestrator stopped answering or its heartbeat went stale; the watchdog restarted it. Running agents resume on their own." 5
elif [ "$failures" -ge 4 ] && [ $(( failures % 12 )) = 4 ]; then
  push "Factory still down" "The orchestrator has been unhealthy for $(( failures * 5 )) minutes, even after a restart. Check ~/factory/logs/orchestrator.log." 5
fi
