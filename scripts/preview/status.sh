#!/usr/bin/env bash
# Set the docs/preview commit status on the built commit.
#   status.sh <pending|success|failure|error> <description> <target url>
# Needs GH_TOKEN (statuses: write), GITHUB_REPOSITORY and RUN_SHA.
set -euo pipefail
gh api "repos/$GITHUB_REPOSITORY/statuses/$RUN_SHA" \
  -f state="$1" -f context=docs/preview -f description="$2" -f target_url="$3" > /dev/null
