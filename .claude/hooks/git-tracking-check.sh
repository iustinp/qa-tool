#!/usr/bin/env bash
# PostToolUse (Bash) hook: after a git commit/push, nudge to keep the work
# tracked in GitHub — warn when committing on the default branch, or when the
# current branch is ahead of main with no open PR. See memory git-tracking-hygiene.
input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null)
case "$cmd" in
  *"git commit"*|*"git push"*) ;;
  *) exit 0 ;;
esac
branch=$(git branch --show-current 2>/dev/null)
[ -z "$branch" ] && exit 0
msg=""
if [ "$branch" = "main" ] || [ "$branch" = "master" ]; then
  msg="⚠️ Working directly on '$branch'. Create a feature branch + open a PR (and an issue) so the work stays tracked."
else
  base="origin/main"; git rev-parse --verify -q "$base" >/dev/null 2>&1 || base="main"
  ahead=$(git rev-list --count "$base..HEAD" 2>/dev/null || echo 0)
  pr=$(gh pr list --head "$branch" --state open --json number --jq 'length' 2>/dev/null || echo 0)
  if [ "$pr" = "0" ] && [ "${ahead:-0}" -gt 0 ] 2>/dev/null; then
    msg="⚠️ Branch '$branch' is $ahead commit(s) ahead of $base with NO open PR. Open one (gh pr create) and make sure a GitHub issue covers this work — keep it tracked (memory: git-tracking-hygiene)."
  fi
fi
[ -n "$msg" ] && jq -cn --arg m "$msg" '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$m}}'
exit 0
