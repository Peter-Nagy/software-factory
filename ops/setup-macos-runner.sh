#!/bin/bash
# One-time setup of the factory's macOS runner (Xcode work: iOS and other Apple-platform projects).
#
#   sudo ops/setup-macos-runner.sh
#
# Creates a hidden standard user, factory-ios, that can't read your home folder, and lets the orchestrator run
# exactly one root-owned script as that user (sudoers). Everything it starts runs inside a sandbox profile that
# also blocks your home and limits writes to the task's checkout, its own home and temp dirs.
# Safe to run again: each step checks what's already there.
set -euo pipefail

RUNNER_USER=factory-ios
ROOT=/Users/Shared/factory-macos
REPO=$(cd "$(dirname "$0")/.." && pwd -P)
cd / # commands run as the runner user can't enter your home folder

[ "$(id -u)" = 0 ] || { echo "Run with sudo: sudo $0" >&2; exit 1; }
OWNER=${SUDO_USER:-}
[ -n "$OWNER" ] && [ "$OWNER" != root ] || { echo "Run it with sudo from your own account, not as root." >&2; exit 1; }
OWNER_HOME=$(dscl . -read "/Users/$OWNER" NFSHomeDirectory | awk '{print $2}')
say() { printf '\n==> %s\n' "$*"; }

free_id() { # first id >= 600 unused as both a user id and a group id
  local id=600
  while dscl . -search /Users UniqueID "$id" | grep -q . || dscl . -search /Groups PrimaryGroupID "$id" | grep -q .; do id=$((id + 1)); done
  echo "$id"
}

say "User and group $RUNNER_USER"
if ! dscl . -read "/Groups/$RUNNER_USER" >/dev/null 2>&1; then
  gid=$(free_id)
  dseditgroup -o create -i "$gid" -r "Factory macOS runner" "$RUNNER_USER"
fi
GID=$(dscl . -read "/Groups/$RUNNER_USER" PrimaryGroupID | awk '{print $2}')
if ! id "$RUNNER_USER" >/dev/null 2>&1; then
  uid=$(free_id)
  # Random password nobody knows: the account is only used through sudo, never to log in.
  sysadminctl -addUser "$RUNNER_USER" -fullName "Factory macOS runner" -UID "$uid" -password "$(openssl rand -base64 30)" -home "/Users/$RUNNER_USER" 2>&1 | grep -v "^$" || true
fi
# Its own primary group instead of staff: your home folder is readable by staff.
dscl . -create "/Users/$RUNNER_USER" PrimaryGroupID "$GID"
dscl . -create "/Users/$RUNNER_USER" IsHidden 1
dscl . -create "/Users/$RUNNER_USER" UserShell /bin/bash
dseditgroup -o edit -d "$RUNNER_USER" -t user staff 2>/dev/null || true
dseditgroup -o edit -d "$RUNNER_USER" -t user admin 2>/dev/null || true
if [ ! -d "/Users/$RUNNER_USER" ]; then
  createhomedir -c -u "$RUNNER_USER" >/dev/null
  chown -R "$RUNNER_USER:$RUNNER_USER" "/Users/$RUNNER_USER"
fi
# Only the top folder on later runs: macOS creates protected app containers inside that even root can't re-own.
chown "$RUNNER_USER:$RUNNER_USER" "/Users/$RUNNER_USER"
chmod 700 "/Users/$RUNNER_USER"
# You join its group, so the orchestrator can prepare and push the checkouts the runner works in.
dseditgroup -o edit -a "$OWNER" -t user "$RUNNER_USER"

say "Folders in $ROOT"
install -d -o root -g wheel -m 755 "$ROOT" "$ROOT/bin"
install -d -o "$OWNER" -g "$RUNNER_USER" -m 2770 "$ROOT/worktrees"
install -d -o "$OWNER" -g "$RUNNER_USER" -m 2750 "$ROOT/config"
install -o root -g wheel -m 755 "$REPO/ops/macos-runner/run" "$ROOT/bin/run"
install -o root -g wheel -m 644 "$REPO/ops/macos-runner/sandbox.sb" "$ROOT/bin/sandbox.sb"
printf '%s\n' "$OWNER_HOME" > "$ROOT/bin/owner-home"
chown root:wheel "$ROOT/bin/owner-home"; chmod 644 "$ROOT/bin/owner-home"

say "sudoers: $OWNER may run only $ROOT/bin/run as $RUNNER_USER"
rule=/etc/sudoers.d/factory-macos-runner
tmp=$(mktemp)
printf '%s ALL=(%s) NOPASSWD: %s\n' "$OWNER" "$RUNNER_USER" "$ROOT/bin/run" > "$tmp"
visudo -cf "$tmp" >/dev/null
install -o root -g wheel -m 440 "$tmp" "$rule"
rm -f "$tmp"

say "Claude Code CLI for $RUNNER_USER (same version as yours)"
version=$(sudo -u "$OWNER" -i claude --version 2>/dev/null | awk '{print $1}')
[ -n "$version" ] || { echo "Couldn't read your claude version." >&2; exit 1; }
if [ "$(sudo -u "$RUNNER_USER" -H bash -c 'cd ~ && ~/.local/bin/claude --version 2>/dev/null' | awk '{print $1}')" != "$version" ]; then
  sudo -u "$RUNNER_USER" -H bash -c "cd ~ && curl -fsSL https://claude.ai/install.sh | bash -s $version" >/dev/null
fi
sudo -u "$RUNNER_USER" -H bash -c 'cd ~ && ~/.local/bin/claude --version'

say "Xcode: license, first-launch packages, iOS Simulator runtime"
# Developer tools access: without it, Xcode can't attach its test runner to a Simulator ("failed to bless service hub").
DevToolsSecurity -enable
dseditgroup -o edit -a "$RUNNER_USER" -t user _developer
xcodebuild -license accept
xcodebuild -runFirstLaunch
if ! xcrun simctl list runtimes | grep -q '^iOS'; then
  echo "Downloading the iOS Simulator runtime (about 8 GB)..."
  xcodebuild -downloadPlatform iOS
fi
xcrun simctl list runtimes | grep '^iOS'

say "Checks"
if sudo -u "$RUNNER_USER" ls "$OWNER_HOME" >/dev/null 2>&1; then
  echo "WARNING: $RUNNER_USER can still list $OWNER_HOME. Check its permissions (ls -ld $OWNER_HOME)." >&2
else
  echo "ok: $RUNNER_USER can't read $OWNER_HOME"
fi
dsmemberutil checkmembership -U "$RUNNER_USER" -G staff
dsmemberutil checkmembership -U "$RUNNER_USER" -G admin
DevToolsSecurity -status

cat <<EOF

Done. Log out and back in once (or restart), so your account picks up the new group membership.
Then tell Claude it's set up; it runs the runner checks and switches the factory's macOS runner on.
EOF
