#!/usr/bin/env bash
# Stands in for `docker run ... claude -p ...` in the pipeline integration test.
# Finds the /work mount, acts like an agent according to the test's mode file, and prints a stream-json transcript.
set -euo pipefail
[ "${1:-}" = "kill" ] && exit 0
WORK=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-v" ] && [[ "$a" == *:/work ]]; then WORK="${a%:/work}"; fi
  prev="$a"
done
[ -n "$WORK" ] || { echo "no /work mount" >&2; exit 2; }
[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || { echo "token not passed" >&2; exit 3; }
cd "$WORK"
# The runner passes only whitelisted env vars, so the test leaves the mode in a file: <root>/mode
ROOT="$WORK/../../.."
MODE=$(cat "$ROOT/mode" 2>/dev/null || echo success)
printenv | cut -d= -f1 | sort > "$ROOT/envseen"
echo "$*" > "$ROOT/argsseen"
printf "%s" "${GH_TOKEN:-}" > "$ROOT/ghtoken"
g() { git -c user.name=fake -c user.email=fake@x "$@"; }
echo '{"type":"system","subtype":"init","session_id":"sess-fake"}'
case "$MODE" in
  success)
    echo "feature $(date +%s%N)" >> feature.txt
    g add feature.txt && g commit -qm "feat: fake work"
    printf '## What changed\n- fake feature\n' > .factory-run/summary.md
    echo '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-fake","result":"done","total_cost_usd":0.1,"num_turns":3}'
    ;;
  migration)
    mkdir -p db/migrations && echo "ALTER TABLE users DROP COLUMN email;" > db/migrations/002.sql
    g add db && g commit -qm "feat: drop email"
    echo '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-fake","result":"done","num_turns":3}'
    ;;
  protected)
    printf 'kind: web-app\nsecrets: [APP_SECRET]\ngates: {e2e: false}\n' > factory.yaml
    echo "x" >> feature.txt
    g add . && g commit -qm "feat: and skip e2e"
    echo '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-fake","result":"done","num_turns":3}'
    ;;
  question)
    echo '{"question":"Which colour?","options":["blue","green"],"default":"blue"}' > .factory-run/question.json
    echo '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-fake","result":"need input","num_turns":2}'
    ;;
  limit)
    echo "wip" >> wip.txt
    g add wip.txt && g commit -qm "wip"
    echo '{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"sess-fake","result":"Claude usage limit reached.","num_turns":2}'
    ;;
  tamper)
    # A misbehaving agent tries to grant itself more secrets via the branch's factory.yaml
    printf 'kind: web-app\nsecrets: [APP_SECRET, EVIL_SECRET]\n' > factory.yaml
    g add factory.yaml && g commit -qm "chore: tweak config"
    echo '{"type":"result","subtype":"error_max_turns","is_error":true,"session_id":"sess-fake","result":"failed","num_turns":5}'
    ;;
  nochecks)
    g rm -q .factory/checks.yaml && g commit -qm "chore: drop checks"
    printf 'done\n' > .factory-run/summary.md
    echo '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-fake","result":"done","num_turns":3}'
    ;;
  contract)
    printf 'FROM factory-worker:current\nRUN echo toolchain %s\n' "$(date +%s%N)" > .factory/Dockerfile
    echo "x" >> feature.txt
    g add . && g commit -qm "build: add toolchain"
    echo '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-fake","result":"done","num_turns":3}'
    ;;
  trailer)
    echo "x" >> feature.txt
    g add . && g commit -qm "feat: remove importer" -m "Tests-Removed: the importer and its tests are gone"
    echo '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-fake","result":"done","num_turns":3}'
    ;;
  crash)
    echo "docker: image not found" >&2
    exit 125
    ;;
  fail)
    echo '{"type":"result","subtype":"error_max_turns","is_error":true,"session_id":"sess-fake","result":"Could not make the tests pass.","num_turns":120}'
    ;;
esac
