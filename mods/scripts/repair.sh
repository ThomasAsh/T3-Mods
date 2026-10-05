#!/usr/bin/env bash
# Runs Claude Code headless to repair the mod stack after an upstream move.
#   mods/scripts/repair.sh conflicts|verify <target> <targetSha>
# Exit 3 when no Claude credential is configured (repair skipped).
set -euo pipefail

kind="$1"
target="$2"
target_sha="$3"

if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "::warning::No CLAUDE_CODE_OAUTH_TOKEN secret; skipping AI repair."
  exit 3
fi

prompt="$(node mods/scripts/repair-prompt.mjs "$kind" "$target" "$target_sha")"
echo "::group::Repair prompt ($kind)"
echo "$prompt"
echo "::endgroup::"

claude -p "$prompt" \
  --model "${T3MODS_REPAIR_MODEL:-claude-opus-5-5}" \
  --permission-mode bypassPermissions \
  --max-turns "${T3MODS_REPAIR_MAX_TURNS:-250}" \
  --output-format text
