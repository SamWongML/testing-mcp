#!/usr/bin/env bash
# Stop-hook quality gate: typecheck + lint whenever TypeScript changed this turn.
#
# Exits 0 (silent) when there is nothing to check, so conversational turns cost nothing.
# Exits 2 with the compiler/linter output on stderr, which Claude Code feeds back to the model.
set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}" || exit 0

payload=$(cat 2>/dev/null || true)

# Already re-entered from a previous blocking gate — don't loop.
case "$payload" in *'"stop_hook_active":true'*) exit 0 ;; esac

# Nothing to gate unless tracked TypeScript actually changed.
if ! git status --porcelain -- '*.ts' | grep -q .; then
  exit 0
fi

if ! out=$(pnpm typecheck 2>&1); then
  printf 'Quality gate failed: pnpm typecheck\n\n%s\n' "$out" >&2
  exit 2
fi

if ! out=$(pnpm lint 2>&1); then
  printf 'Quality gate failed: pnpm lint\n\n%s\n' "$out" >&2
  exit 2
fi

exit 0
