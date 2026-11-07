#!/usr/bin/env bash
# Stands in for `docker run` during the review stage. Gate steps are identified by their factory.gate label,
# the reviewer by factory.role=reviewer. Behaviour comes from <root>/review-mode:
#   fail=<step>       that gate step exits 1
#   tests=<n>         test/e2e steps report n passing tests in JUnit XML (default 3; 0 = an empty suite)
#   noreport          test/e2e steps exit 0 without writing a report
#   review=approve|changes|garbage
# The reviewer's prompt is saved to <root>/reviewprompt.
set -euo pipefail
[ "${1:-}" = "kill" ] && exit 0
[ "${1:-}" = "volume" ] && exit 0
# Project toolchain images: <root> isn't known yet for these calls, so state lives in $DOCKER_FAKE_STATE.
if [ "${1:-}" = "image" ]; then
  img="${@: -1}"
  case "$img" in factory-project-*) [ -f "${DOCKER_FAKE_STATE:?}/built-$img" ] && { echo sha256:p; exit 0; } || exit 1 ;; *) echo sha256:base; exit 0 ;; esac
fi
if [ "${1:-}" = "build" ]; then
  tag=""; prev=""; for a in "$@"; do [ "$prev" = "-t" ] && tag="$a"; prev="$a"; done
  echo "$tag" >> "${DOCKER_FAKE_STATE:?}/builds"
  grep -qx imagefail "${DOCKER_FAKE_STATE}/review-mode" 2>/dev/null && { echo "E: Unable to locate package golang"; exit 1; }
  touch "${DOCKER_FAKE_STATE}/built-$tag"; exit 0
fi
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
  for a in "$@"; do case "$a" in factory-worker:*|factory-project-*) echo "$a" >> "$ROOT/gateimages" ;; esac; done
  if want "fail=$GATE"; then echo "FAIL: $GATE broke at line 3"; exit 1; fi
  if [ "$GATE" = "test" ] || [ "$GATE" = "e2e" ]; then
    if ! want "noreport"; then
      n=$(grep -E '^tests=' "$MODE_FILE" 2>/dev/null | cut -d= -f2 || true); n=${n:-3}
      dir="$WORK${FACTORY_REPORT_DIR#/work}"
      { echo '<testsuites><testsuite name="s">'; i=0; while [ "$i" -lt "$n" ]; do i=$((i+1)); echo "<testcase name=\"t$i\"/>"; done; echo '</testsuite></testsuites>'; } > "$dir/junit.xml"
    fi
  fi
  echo "ok $GATE"; exit 0
fi
if [ "$ROLE" = "reviewer" ]; then
  [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -n "${GH_TOKEN+set}" ] || { echo "reviewer missing env" >&2; exit 3; }
  echo "review" >> "$ROOT/reviewsrun"
  printf '%s' "$*" > "$ROOT/reviewprompt"
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
