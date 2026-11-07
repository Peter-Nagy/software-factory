#!/usr/bin/env bash
# Stands in for a Studio phase agent. Writes the phase's document and status file into the mounted /work.
# Per-phase behaviour from <work>/../mode-<phase>: "questions" (asks, not ready), "interview" (structured questions), "narrow" / "dont" (research verdict),
# "spikes" (architecture names a spike), "fail" (agent error). Default: done, ready.
set -euo pipefail
[ "${1:-}" = "kill" ] && exit 0
WORK=""; PHASE=""; prev=""
for a in "$@"; do
  if [ "$prev" = "-v" ] && [[ "$a" == *:/work ]]; then WORK="${a%:/work}"; fi
  if [ "$prev" = "--label" ] && [[ "$a" == factory.phase=* ]]; then PHASE="${a#factory.phase=}"; fi
  prev="$a"
done
MODE=$(cat "$WORK/../mode-$PHASE" 2>/dev/null || echo done)
# The stand-in: answers every open question ("first option" or a free-text guess).
if [[ " $* " == *" factory.standin=1 "* ]]; then
  echo "standin-$PHASE" >> "$WORK/../turns"
  echo "$*" > "$WORK/../args-standin-$PHASE"
  [ "$MODE" = "standin-fail" ] && { echo '{"type":"result","subtype":"success","is_error":false,"session_id":"st","result":"nope","num_turns":1}'; exit 0; }
  node -e 'const fs=require("fs");const [w,p]=process.argv.slice(1);const q=JSON.parse(fs.readFileSync(w+"/status/"+p+".json","utf8")).questions;fs.writeFileSync(w+"/status/"+p+".answers.json",JSON.stringify(q.map(x=>typeof x==="string"?{answer:"guess for "+x,reason:"guess"}:{answer:(x.options[0]||{label:"x"}).label,reason:"recommended"})))' "$WORK" "$PHASE"
  echo '{"type":"result","subtype":"success","is_error":false,"session_id":"st","result":"Answered.","num_turns":2}'
  exit 0
fi
echo "$PHASE" >> "$WORK/../turns"
echo "$*" > "$WORK/../args-$PHASE"
echo '{"type":"system","subtype":"init","session_id":"sess-'"$PHASE"'"}'
if [ "$MODE" = "fail" ]; then
  echo '{"type":"result","subtype":"error_max_turns","is_error":true,"session_id":"sess-'"$PHASE"'","result":"gave up","num_turns":80}'
  exit 0
fi
mkdir -p "$WORK/docs/design" "$WORK/status"
case "$PHASE" in
  brief) printf '# Brief\n\nA running app for me.\n' > "$WORK/docs/BRIEF.md" ;;
  research) printf '# Research\n\nStrava, Runna. [source](https://example.com)\n' > "$WORK/docs/RESEARCH.md" ;;
  product) printf '# Running app\n\nRun with friends.\n\n## Stories\n- [ ] Track a run\n' > "$WORK/docs/PRODUCT.md" ;;
  design)
    printf '# Design\n\n- home.html: today\n' > "$WORK/docs/DESIGN.md"
    printf '<!doctype html><meta name="viewport" content="width=390"><style>body{background:#111;color:#fff}</style><h1>Today</h1><script>parent.document.title="pwned"</script>' > "$WORK/docs/design/home.html"
    ;;
  architecture)
    printf '# Architecture\n\nSwiftUI.\n' > "$WORK/docs/ARCHITECTURE.md"
    if [ "$MODE" = "spikes" ]; then echo '[{"key":"background-gps","question":"Does GPS keep running in the background?","approach":"tiny app"}]' > "$WORK/docs/spikes.json"; else echo '[]' > "$WORK/docs/spikes.json"; fi
    ;;
  spikes) printf '# Spikes\n\nbackground-gps: yes (unverified)\n' > "$WORK/docs/SPIKES.md" ;;
  launch)
    mkdir -p "$WORK/docs/launch"
    printf '# Launch kit\n\nStore listing: Stride.\n' > "$WORK/docs/LAUNCH.md"
    printf '<!doctype html><h1>Run together</h1>' > "$WORK/docs/launch/landing.html"
    ;;
esac
# "rounds": asks until it has seen two rounds of answers, then is done; "endless": always asks.
if [ "$MODE" = "rounds" ]; then
  n=$(grep -c "^$PHASE\$" "$WORK/../turns" || true)
  if [ "$n" -ge 3 ]; then MODE=done; else MODE=interview; fi
fi
[ "$MODE" = "endless" ] && MODE=interview
case "$MODE" in
  questions) echo '{"ready": false, "questions": ["Which platform?"], "summary": "need input"}' > "$WORK/status/$PHASE.json" ;;
  interview) echo '{"ready": false, "summary": "asking", "coverage": [{"topic": "Who", "done": true}, {"topic": "Platforms", "done": false}], "questions": [{"header": "Platform", "question": "Which platforms?", "options": [{"label": "iPhone", "description": "Fastest"}, {"label": "Web"}], "recommended": "iPhone"}, "Describe your typical run"]}' > "$WORK/status/$PHASE.json" ;;
  narrow) echo '{"ready": true, "questions": [], "summary": "sharper angle", "verdict": "narrow"}' > "$WORK/status/$PHASE.json" ;;
  dont) echo '{"ready": true, "questions": [], "summary": "use Runna", "verdict": "dont"}' > "$WORK/status/$PHASE.json" ;;
  *) echo '{"ready": true, "questions": [], "summary": "done", "verdict": "build"}' > "$WORK/status/$PHASE.json" ;;
esac
echo '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-'"$PHASE"'","result":"Drafted the '"$PHASE"'.","num_turns":3}'
