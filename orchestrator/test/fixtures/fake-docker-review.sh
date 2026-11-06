#!/usr/bin/env bash
# Stands in for `docker run` during the review stage. Gate steps are identified by their factory.gate label,
# the reviewer by factory.role=reviewer. Behaviour comes from <root>/review-mode:
#   fail=<step>       that gate step exits 1
#   review=approve|changes|garbage
set -euo pipefail
[ "${1:-}" = "kill" ] && exit 0
WORK=""; GATE=""; ROLE=""; prev=""
for a in "$@"; do
  if [ "$prev" = "-v" ] && [[ "$a" == *:/work || "$a" == *:/work:ro ]]; then WORK="${a%:/work*}"; fi
  if [ "$prev" = "--label" ]; then
    case "$a" in factory.gate=*) GATE="${a#factory.gate=}" ;; factory.role=*) ROLE="${a#factory.role=}" ;; esac
  fi
  prev="$a"
done
ROOT="$WORK/../../.."
MODE_FILE="$ROOT/review-mode"
want() { grep -qx "$1" "$MODE_FILE" 2>/dev/null; }
if [ -n "$GATE" ]; then
  echo "$GATE" >> "$ROOT/gatesrun"
  if want "fail=$GATE"; then echo "FAIL: $GATE broke at line 3"; exit 1; fi
  echo "ok $GATE"; exit 0
fi
if [ "$ROLE" = "reviewer" ]; then
  [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -n "${GH_TOKEN+set}" ] || { echo "reviewer missing env" >&2; exit 3; }
  echo "review" >> "$ROOT/reviewsrun"
  echo '{"type":"system","subtype":"init","session_id":"sess-review"}'
  if want "review=changes"; then
    echo '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-review","result":"x","structured_output":{"verdict":"request_changes","criteria":[{"criterion":"Shows a list","met":false,"evidence":"no test"}],"blocking":[{"file":"src/a.ts","line":4,"problem":"Null dereference","fix":"Guard it"}],"notes":[]}}'
  elif want "review=garbage"; then
    echo '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-review","result":"I think it is fine"}'
  else
    echo '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-review","result":"x","structured_output":{"verdict":"approve","criteria":[{"criterion":"Shows a list","met":true,"evidence":"list.test.ts"}],"blocking":[],"notes":["Consider caching"]}}'
  fi
  exit 0
fi
echo "unexpected docker call: $*" >&2; exit 9
