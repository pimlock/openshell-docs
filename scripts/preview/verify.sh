#!/usr/bin/env bash
# Decide which pull request a build belongs to. Step 2 of the preview.
#   verify.sh <meta.json from the build>
#
# The build ran the pull request's code, so meta.json can say anything. Its
# pull request number is used only when GitHub says that pull request's head
# is the commit the build ran on (RUN_SHA, from the workflow_run event).
# - head matches:            outputs pr, fork, url
# - an older commit of it:   outdated build; outputs nothing, succeeds
# - anything else:           fails (spoofed or wrong number)
#
# Needs GH_TOKEN, GITHUB_REPOSITORY, GITHUB_OUTPUT, RUN_SHA, OWNER, REPO_NAME.
set -euo pipefail
meta=$1
pr=$(jq -r '.pr | tostring' "$meta")
if ! [[ "$pr" =~ ^[1-9][0-9]{0,6}$ ]]; then
  echo "::error::meta.json has no valid pull request number"
  exit 1
fi
read -r head state head_repo < <(gh api "repos/$GITHUB_REPOSITORY/pulls/$pr" \
  --jq '[.head.sha, .state, (.head.repo.full_name // "deleted")] | join(" ")')
if [ "$head" != "$RUN_SHA" ]; then
  if gh api "repos/$GITHUB_REPOSITORY/pulls/$pr/commits" --paginate --jq '.[].sha' | grep -qx "$RUN_SHA"; then
    echo "::notice::Build of ${RUN_SHA::7} is outdated: PR #$pr is now at ${head::7}. Skipping."
    exit 0
  fi
  echo "::error::meta.json names PR #$pr, but ${RUN_SHA::7} is not a commit of that pull request."
  exit 1
fi
if [ "$state" != open ]; then
  echo "::notice::PR #$pr is $state. Skipping."
  exit 0
fi
fork=false
if [ "$head_repo" != "$GITHUB_REPOSITORY" ]; then fork=true; fi
{
  echo "pr=$pr"
  echo "fork=$fork"
  echo "url=https://${OWNER,,}.github.io/$REPO_NAME/pr-$pr/"
} >> "$GITHUB_OUTPUT"
echo "PR #$pr at ${RUN_SHA::7} (fork: $fork)"
