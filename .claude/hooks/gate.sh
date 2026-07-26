#!/usr/bin/env bash
# Stop-hook quality gate: typecheck + lint whenever TypeScript changed this turn, plus
# `pnpm validate` whenever the tests/ corpus changed — a test that cannot fail is a build error.
#
# Exits 0 (silent) when there is nothing to check, so conversational turns cost nothing.
# Exits 2 with the failing tool's output on stderr, which Claude Code feeds back to the model.
set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}" || exit 0

payload=$(cat 2>/dev/null || true)

# Already re-entered from a previous blocking gate — don't loop.
case "$payload" in *'"stop_hook_active":true'*) exit 0 ;; esac

# Nothing to gate unless tracked TypeScript actually changed.
if ! git status --porcelain -- '*.ts' | grep -q .; then
  exit 0
fi

gate() {
  if ! out=$("$@" 2>&1); then
    printf 'Quality gate failed: %s\n\n%s\n' "$*" "$out" >&2
    exit 2
  fi
}

gate pnpm typecheck
gate pnpm lint

# The corpus carries its own strictness rules (packages/cli/src/strict.ts), and only
# `validate` applies them — tsc and eslint cannot see a test that asserts nothing.
if git status --porcelain -- 'tests/' | grep -q .; then
  gate pnpm validate
fi

exit 0
