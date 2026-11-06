#!/usr/bin/env bash
# Shared helpers for the S0 spikes. Compatible with macOS's bash 3.2.

SPIKES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SPIKES_DIR/.." && pwd)"
RESULTS_DIR="$SPIKES_DIR/results"
SUMMARY="$RESULTS_DIR/summary.md"
SPIKE_IMAGE="factory-worker:spike"
mkdir -p "$RESULTS_DIR"

log() { printf '\033[1m==> %s\033[0m\n' "$*" >&2; }

# result <spike> <PASS|FAIL|SKIP|INFO> <one-line detail>
result() {
  printf -- '- **%s**: %s - %s\n' "$1" "$2" "$3" >> "$SUMMARY"
  printf '%s: %s - %s\n' "$1" "$2" "$3" >&2
}

have() { command -v "$1" >/dev/null 2>&1; }

# run_with_timeout <seconds> <cmd...>  (macOS has no GNU timeout; perl is always there)
run_with_timeout() {
  local secs="$1"; shift
  perl -e 'alarm shift; exec @ARGV or die "exec failed: $!"' "$secs" "$@"
}

need_env() {
  local missing=""
  for v in "$@"; do
    if [ -z "${!v:-}" ]; then missing="$missing $v"; fi
  done
  if [ -n "$missing" ]; then
    echo "missing env:$missing"
    return 1
  fi
}

build_spike_image() {
  if docker image inspect "$SPIKE_IMAGE" >/dev/null 2>&1 && [ -z "${REBUILD:-}" ]; then return 0; fi
  log "Building $SPIKE_IMAGE (small image: node + git + claude CLI)"
  docker build -q -t "$SPIKE_IMAGE" -f "$SPIKES_DIR/Dockerfile.spike" "$REPO_DIR/worker" >/dev/null
}

# spike_docker <timeout-seconds> [docker run args...] IMAGE CMD...
# docker run with the worker conventions and a time limit, passing secrets by name only.
spike_docker() {
  local secs="$1"; shift
  run_with_timeout "$secs" docker run --rm --init --user worker --cap-drop ALL --security-opt no-new-privileges \
    -e CLAUDE_CODE_OAUTH_TOKEN \
    -v "$REPO_DIR/worker-config:/home/worker/.claude-config:ro" \
    "$@"
}
