#!/usr/bin/env bash
# Stands in for `sudo -n -u <user> <root>/bin/run <worktree> -- <command...>` (the macOS runner) in tests.
# Takes env as JSON on stdin like the real runner, then hands the call to the fake docker scripts:
# claude -> fake-docker.sh (agent), project checks -> fake-docker-review.sh, Simulator create/delete -> logged.
set -euo pipefail
[ "$1" = "-n" ] && [ "$2" = "-u" ] || { echo "unexpected sudo call: $*" >&2; exit 9; }
shift 3 # -n -u <user>
RUN="$1"; shift
[ "${1:-}" = "--cleanup" ] && exit 0
WT="$1"; [ "$2" = "--" ]; shift 2
ROOT_LOG=$(cd "$WT/../../.." && pwd) # the test's root: <root>/worktrees/<project>/<n>
json=$(cat)
while IFS= read -r -d '' k && IFS= read -r -d '' v; do export "$k=$v"; done < <(printf '%s' "$json" | jq -j 'to_entries[] | .key, "\u0000", (.value|tostring), "\u0000"')
echo "$RUN|$WT|$1|$(printf '%s' "$json" | jq -r 'keys | join(",")')|${FACTORY_SIMULATOR:-}" >> "$ROOT_LOG/sudocalls"
export FAKE_ROOT="$ROOT_LOG"
here=$(cd "$(dirname "$0")" && pwd)
if [ -n "${FACTORY_SIMULATOR_NAME:-}" ]; then echo "Created"; echo "0A1B2C3D-0000-4000-8000-000000000001"; exit 0; fi
case "$1" in
  claude) shift; exec "$here/fake-docker.sh" run -v "$WT:/work" factory-worker:current claude "$@" ;;
  xcrun) echo "simctl $*" >> "$ROOT_LOG/simulators"; exit 0 ;;
  bash) exec "$here/fake-docker-review.sh" run -v "$WT:/work" --label "factory.gate=$(basename "${FACTORY_REPORT_DIR:?}")" macos "$@" ;;
esac
echo "unexpected runner command: $*" >&2; exit 9
