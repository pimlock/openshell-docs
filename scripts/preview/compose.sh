#!/usr/bin/env bash
# Put together the whole GitHub Pages site from the open pull requests, for
# repos that deploy Pages from Actions (no gh-pages branch).
#   compose.sh <output dir>
#
# A Pages deployment replaces the whole site, and there is no branch to keep
# earlier previews in, so every deployment is built from scratch from what
# GitHub already records:
#   - every open pull request and its head commit
#   - the newest successful run of the build workflow (BUILD_WORKFLOW, a file
#     name such as docs-preview.yml) on exactly that commit, and its
#     docs-preview-site artifact
#   - for pull requests from forks, a docs/preview-approved commit status on
#     that commit set by github-actions[bot], which only the approval job (in
#     the fork environment) writes
# Closed pull requests drop out on the next deployment, and so do previews
# whose artifact has expired.
#
# Each preview goes to <output>/pr-<n>/ after check-site.sh. Writes a list of
# what was included to <output>/previews.json.
# Needs GH_TOKEN (actions: read, pull-requests: read, statuses: read),
# GITHUB_REPOSITORY and BUILD_WORKFLOW.
set -euo pipefail
out=$1
here=$(cd "$(dirname "$0")" && pwd)
max_total_mb=${MAX_TOTAL_MB:-900} # GitHub Pages sites are limited to 1 GB
rm -rf "$out" && mkdir -p "$out"
included='[]'
total=0

while IFS=$'\t' read -r n sha head_repo; do
  [[ "$n" =~ ^[1-9][0-9]{0,6}$ ]] || continue
  if [ "$head_repo" != "$GITHUB_REPOSITORY" ]; then
    approved=$(gh api "repos/$GITHUB_REPOSITORY/commits/$sha/statuses" --paginate \
      --jq '[.[] | select(.context == "docs/preview-approved" and .creator.login == "github-actions[bot]")][0].state // ""' | head -n1)
    if [ "$approved" != success ]; then
      echo "PR #$n: fork commit ${sha::7} not approved, skipping"
      continue
    fi
  fi
  run=$(gh api "repos/$GITHUB_REPOSITORY/actions/workflows/$BUILD_WORKFLOW/runs?head_sha=$sha&event=pull_request&status=success&per_page=1" \
    --jq '.workflow_runs[0].id // ""')
  if [ -z "$run" ]; then
    echo "PR #$n: no successful build of ${sha::7}, skipping"
    continue
  fi
  dir="$out/pr-$n"
  if ! gh run download "$run" -R "$GITHUB_REPOSITORY" -n docs-preview-site -D "$dir" 2>/dev/null; then
    echo "PR #$n: the build artifact of run $run is gone, skipping"
    rm -rf "$dir"
    continue
  fi
  if ! "$here/check-site.sh" "$dir"; then
    echo "PR #$n: rejected"
    rm -rf "$dir"
    continue
  fi
  size=$(du -sm "$dir" | cut -f1)
  if [ $((total + size)) -gt "$max_total_mb" ]; then
    echo "::warning::PR #$n left out: the site would pass ${max_total_mb} MB"
    rm -rf "$dir"
    continue
  fi
  total=$((total + size))
  included=$(jq -c --argjson n "$n" --arg sha "$sha" --argjson run "$run" '. + [{pr: $n, commit: $sha, run: $run}]' <<<"$included")
  echo "PR #$n: ${sha::7} from run $run (${size} MB)"
done < <(gh api "repos/$GITHUB_REPOSITORY/pulls?state=open&per_page=100" --paginate \
  --jq '.[] | [.number, .head.sha, (.head.repo.full_name // "deleted")] | @tsv')

jq . <<<"$included" > "$out/previews.json"
{
  echo '<!doctype html><meta charset="utf-8"><title>Docs previews</title>'
  echo '<meta name="robots" content="noindex">'
  echo '<style>body{font:16px system-ui;margin:2rem}</style><h1>Docs previews</h1><ul>'
  jq -r --arg r "$GITHUB_REPOSITORY" '.[] | "<li><a href=\"pr-\(.pr)/\">pr-\(.pr)</a> (<a href=\"https://github.com/\($r)/pull/\(.pr)\">pull request</a>, \(.commit[:7]))</li>"' "$out/previews.json"
  echo '</ul>'
} > "$out/index.html"
echo "$(jq length "$out/previews.json") previews, ${total} MB"
