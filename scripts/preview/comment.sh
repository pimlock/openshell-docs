#!/usr/bin/env bash
# Create or update the preview's single comment on a pull request.
#   comment.sh [--update-only] <file with the comment body>
# --update-only changes an existing comment and never creates one.
# Needs GH_TOKEN (pull-requests: write), GITHUB_REPOSITORY and PR.
set -euo pipefail
update_only=false
if [ "$1" = --update-only ]; then update_only=true; shift; fi
marker='<!-- openshell-docs-preview -->'
body="$marker
$(cat "$1")"
id=$(gh api "repos/${GITHUB_REPOSITORY}/issues/${PR}/comments" --paginate \
  --jq ".[] | select(.body | startswith(\"${marker}\")) | .id" | head -n1)
if [ -n "$id" ]; then
  gh api -X PATCH "repos/${GITHUB_REPOSITORY}/issues/comments/${id}" -f body="$body" > /dev/null
elif [ "$update_only" = false ]; then
  gh api "repos/${GITHUB_REPOSITORY}/issues/${PR}/comments" -f body="$body" > /dev/null
fi
