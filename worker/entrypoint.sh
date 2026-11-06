#!/usr/bin/env bash
# Container start: install the read-only worker config into ~/.claude, set up git auth from GH_TOKEN, then exec the command.
set -euo pipefail

CONFIG_SRC=/home/worker/.claude-config
mkdir -p "$HOME/.claude"
if [ -d "$CONFIG_SRC" ]; then
  for item in settings.json CLAUDE.md skills agents; do
    if [ -e "$CONFIG_SRC/$item" ]; then
      rm -rf "${HOME:?}/.claude/$item"
      cp -R "$CONFIG_SRC/$item" "$HOME/.claude/$item"
    fi
  done
fi

# Skip first-run onboarding prompts in unattended runs.
if [ ! -f "$HOME/.claude.json" ]; then
  echo '{"hasCompletedOnboarding": true}' > "$HOME/.claude.json"
fi

git config --global user.name "factory-bot"
git config --global user.email "factory-bot@users.noreply.github.com"
git config --global init.defaultBranch main
git config --global --add safe.directory /work
if [ -n "${GH_TOKEN:-}" ]; then
  # The token stays in the environment; git asks this helper instead of storing it on disk.
  git config --global credential.helper '!f() { echo username=x-access-token; echo "password=${GH_TOKEN}"; }; f'
fi

exec "$@"
