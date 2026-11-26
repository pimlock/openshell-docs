#!/usr/bin/env bash
# Change the previews on the calling repo's gh-pages branch.
# Each preview lives in its own folder (pr-12/), so previews don't replace
# each other. The branch root gets an index of the current previews.
#
#   pages.sh publish <slot> <dist dir>
#   pages.sh remove  <slot>
#   pages.sh prune   <file listing open pull request numbers, one per line>
#
# prune removes every pr-<n>/ whose pull request isn't in the file, and with
# MAX_AGE_DAYS set, also previews published more than that many days ago.
#
# gh-pages is always a single commit with no parents: every change replaces
# the branch, so its history never grows and clones of the repo stay small.
# The push uses --force-with-lease against the commit this run started from,
# so a concurrent change is never overwritten: the push is rejected, and the
# change is redone on top of the new branch.
#
# Needs GH_TOKEN (contents: write) and GITHUB_REPOSITORY. PREVIEW_SHA, if
# set, is recorded in the preview's .preview.json.
set -euo pipefail
action=$1
case "$action" in
  publish)
    slot=$2
    dist=$(cd "$3" && pwd)
    ;;
  remove) slot=$2 ;;
  prune)
    open_file=$(cd "$(dirname "$2")" && pwd)/$(basename "$2")
    max_age_days=${MAX_AGE_DAYS:-0}
    ;;
  *) echo "usage: pages.sh publish|remove|prune ..." >&2; exit 2 ;;
esac
if [ -n "${slot:-}" ] && ! [[ "$slot" =~ ^(pr-[1-9][0-9]{0,6}|ref-[A-Za-z0-9._-]+)$ ]]; then
  echo "bad preview folder: $slot" >&2
  exit 1
fi
remote=${PAGES_REMOTE:-"https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"} # PAGES_REMOTE: for tests
work=$(mktemp -d)

write_index() {
  {
    echo '<!doctype html><meta charset="utf-8"><title>Docs previews</title>'
    echo '<meta name="robots" content="noindex">'
    echo '<style>body{font:16px system-ui;margin:2rem}</style><h1>Docs previews</h1><ul>'
    for d in $(find . -maxdepth 1 -type d -name 'pr-*' -printf '%f\n' | sort -t- -k2 -n); do
      echo "<li><a href=\"$d/\">$d</a> (<a href=\"https://github.com/${GITHUB_REPOSITORY}/pull/${d#pr-}\">pull request</a>)</li>"
    done
    echo '</ul>'
  } > index.html
}

# Prints what it removed.
prune() {
  local now cutoff d n published
  now=$(date -u +%s)
  cutoff=$(( now - max_age_days * 86400 ))
  while IFS= read -r d; do
    n=${d#pr-}
    if ! grep -qx "$n" "$open_file"; then
      rm -rf "$d"; echo "removed $d (pull request not open)"
    elif [ "$max_age_days" -gt 0 ]; then
      published=$(jq -r '.published_at // empty' "$d/.preview.json" 2>/dev/null || true)
      if [ -n "$published" ] && [ "$(date -u -d "$published" +%s)" -lt "$cutoff" ]; then
        rm -rf "$d"; echo "removed $d (published $published)"
      fi
    fi
  done < <(find . -maxdepth 1 -type d -name 'pr-*' -printf '%f\n')
}

for attempt in 1 2 3 4 5; do
  rm -rf "$work" && mkdir -p "$work" && cd "$work"
  base=""
  if git clone -q --depth 1 --branch gh-pages "$remote" . 2>/dev/null; then
    base=$(git rev-parse HEAD)
  else
    git init -q -b gh-pages && git remote add origin "$remote"
  fi
  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

  case "$action" in
    publish)
      rm -rf "$slot" && mkdir -p "$slot" && cp -R "$dist/." "$slot/"
      jq -n --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg sha "${PREVIEW_SHA:-}" \
        '{published_at: $at, commit: $sha}' > "$slot/.preview.json"
      message="publish $slot"
      ;;
    remove)
      rm -rf "$slot"
      message="remove $slot"
      ;;
    prune)
      removed=$(prune)
      [ -n "$removed" ] && echo "$removed"
      message="prune $(echo "$removed" | grep -c . || true) previews"
      ;;
  esac
  touch .nojekyll # keep Astro's _astro/ folder
  write_index
  git add -A
  if [ -n "$base" ] && git diff --cached --quiet; then echo "unchanged"; exit 0; fi

  # Replace the branch with one parentless commit of the new tree.
  git checkout -q --orphan next
  git commit -q -m "docs previews: $message"
  if git push -q --force-with-lease="gh-pages:$base" origin HEAD:gh-pages; then
    echo "$message"
    exit 0
  fi
  echo "gh-pages changed while updating it (attempt $attempt), retrying"
  sleep $((attempt * 3))
done
echo "could not update gh-pages" >&2
exit 1
