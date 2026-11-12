#!/usr/bin/env bash
# Create or update this workflow's single comment on a pull request.
#   comment.sh <file with the comment body>
# Needs GH_TOKEN (pull-requests: write), GITHUB_REPOSITORY and PR.
set -euo pipefail
marker='<!-- openshell-docs-preview -->'
body="$marker
$(cat "$1")"
id=$(gh api "repos/${GITHUB_REPOSITORY}/issues/${PR}/comments" --paginate \
  --jq ".[] | select(.body | startswith(\"${marker}\")) | .id" | head -n1)
if [ -n "$id" ]; then
  gh api -X PATCH "repos/${GITHUB_REPOSITORY}/issues/comments/${id}" -f body="$body" > /dev/null
else
  gh api "repos/${GITHUB_REPOSITORY}/issues/${PR}/comments" -f body="$body" > /dev/null
fi
