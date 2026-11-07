#!/usr/bin/env bash
# Does this Mac's Xcode run iOS tests on a Simulator? Builds a two-test Swift package in a temp folder, creates a
# fresh Simulator on the newest iOS runtime, runs `xcodebuild test` on it, and cleans up. Runs as you (no sudo).
# Usage: bash ops/macos-runner/selftest.sh [timeout-seconds, default 600]
set -euo pipefail
TIMEOUT="${1:-600}"
echo "Xcode: $(xcodebuild -version | tr '\n' ' ')"
echo "macOS: $(sw_vers -productVersion)"
DIR="$(mktemp -d -t factory-ios-selftest)"
SIM=""
cleanup() {
  if [ -n "$SIM" ]; then xcrun simctl shutdown "$SIM" >/dev/null 2>&1 || true; xcrun simctl delete "$SIM" >/dev/null 2>&1 || true; fi
  rm -rf "$DIR"
}
trap cleanup EXIT

mkdir -p "$DIR/Sources/Selftest" "$DIR/Tests/SelftestTests"
cat > "$DIR/Package.swift" <<'EOF'
// swift-tools-version:5.9
import PackageDescription
let package = Package(
  name: "Selftest",
  platforms: [.iOS(.v17)],
  products: [.library(name: "Selftest", targets: ["Selftest"])],
  targets: [.target(name: "Selftest"), .testTarget(name: "SelftestTests", dependencies: ["Selftest"])]
)
EOF
echo 'public func greet(_ n: String) -> String { "Hello, \(n)!" }' > "$DIR/Sources/Selftest/Selftest.swift"
cat > "$DIR/Tests/SelftestTests/SelftestTests.swift" <<'EOF'
import XCTest
@testable import Selftest
final class SelftestTests: XCTestCase {
  func testGreets() { XCTAssertEqual(greet("World"), "Hello, World!") }
  func testRunsOnIOS() {
    #if os(iOS)
    XCTAssertTrue(true)
    #else
    XCTFail("not running on iOS")
    #endif
  }
}
EOF

RT_JSON="$(xcrun simctl list runtimes --json | jq '[.runtimes[] | select(.isAvailable and .platform == "iOS")] | sort_by(.version | split(".") | map(tonumber)) | last')"
RUNTIME="$(jq -r '.identifier // empty' <<<"$RT_JSON")"
[ -n "$RUNTIME" ] || { echo "No iOS Simulator runtime installed: run xcodebuild -downloadPlatform iOS"; exit 1; }
DEVICE="$(jq -r '[.supportedDeviceTypes[] | select(.productFamily == "iPhone")] | last | .identifier' <<<"$RT_JSON")"
SIM="$(xcrun simctl create factory-selftest "$DEVICE" "$RUNTIME")"
echo "Simulator: $SIM ($DEVICE, $RUNTIME)"

START=$(date +%s)
LOG="$DIR/test.log"
set +e
( cd "$DIR" && xcodebuild test -scheme Selftest -destination "id=$SIM" -derivedDataPath "$DIR/dd" >"$LOG" 2>&1 ) &
PID=$!
while kill -0 "$PID" 2>/dev/null; do
  if [ $(( $(date +%s) - START )) -ge "$TIMEOUT" ]; then kill "$PID" 2>/dev/null; echo "Timed out after ${TIMEOUT}s."; break; fi
  sleep 5
done
wait "$PID"; CODE=$?
set -e
ELAPSED=$(( $(date +%s) - START ))
grep -E "Executed [0-9]+ tests?|hung before establishing|TEST (SUCCEEDED|FAILED)|error:" "$LOG" | sort -u | head -10
if [ "$CODE" = 0 ] && grep -q "TEST SUCCEEDED" "$LOG"; then
  echo "PASS: iOS tests run on the Simulator (${ELAPSED}s)."
else
  echo "FAIL after ${ELAPSED}s (exit $CODE). Full log: kept at $DIR.log"
  cp "$LOG" "$DIR.log"
  exit 1
fi
