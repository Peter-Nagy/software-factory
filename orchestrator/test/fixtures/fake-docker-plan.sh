#!/usr/bin/env bash
# Stands in for the planner container: writes PRODUCT.md and plan.json into the mounted /work/plan and replies.
set -euo pipefail
[ "${1:-}" = "kill" ] && exit 0
WORK=""; prev=""; REPO_MOUNT=""
for a in "$@"; do
  if [ "$prev" = "-v" ] && [[ "$a" == *:/work ]]; then WORK="${a%:/work}"; fi
  if [ "$prev" = "-v" ] && [[ "$a" == *:/work/repo:ro ]]; then REPO_MOUNT="${a%:/work/repo:ro}"; fi
  prev="$a"
done
echo "$*" > "$WORK/../argsseen"
[ -n "$REPO_MOUNT" ] && ls "$REPO_MOUNT" > "$WORK/../repo-files"
mkdir -p "$WORK/plan"
if [ -f "$WORK/plan/ISSUE.md" ]; then # an issue conversation: revise the issue only
  cp "$WORK/plan/ISSUE.md" "$WORK/../issue-seen"
  printf '# Import habits from CSV files\n\nImport habits from a CSV export.\n\n## Acceptance criteria\n- [ ] Quoted fields with newlines parse\n' > "$WORK/plan/ISSUE.md"
  echo '{"type":"system","subtype":"init","session_id":"plan-sess"}'
  echo '{"type":"result","subtype":"success","is_error":false,"session_id":"plan-sess","result":"Tightened the criteria.","num_turns":2}'
  exit 0
fi
printf '# Habit tracker\n\nTrack daily habits and streaks.\n\n## Stories\n- [ ] Add a habit\n' > "$WORK/plan/PRODUCT.md"
cat > "$WORK/plan/plan.json" <<'JSON'
{"title":"Habit tracker v1","project":{"name":"habit-tracker","kind":"web-app","priority":4},
 "issues":[
  {"key":"scaffold","title":"Scaffold the app","body":"Set up the stack.\n\n## Acceptance criteria\n- [ ] npm test runs","size":"m","risk":"low","area":"setup"},
  {"key":"habits","title":"Add and list habits","body":"Habits CRUD.\n\n## Acceptance criteria\n- [ ] can add","size":"m","risk":"low","area":"habits","dependsOn":["scaffold"]},
  {"key":"streaks","title":"Show streaks","body":"Streak counter.\n\n## Acceptance criteria\n- [ ] shows streak","size":"s","risk":"low","area":"streaks","dependsOn":["scaffold","habits"]}
 ]}
JSON
echo '{"type":"system","subtype":"init","session_id":"plan-sess"}'
echo '{"type":"result","subtype":"success","is_error":false,"session_id":"plan-sess","result":"Drafted v1 with **3 issues**. Ready to execute: 3 issues.","total_cost_usd":0.3,"num_turns":4}'
