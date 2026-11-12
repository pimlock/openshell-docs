#!/usr/bin/env bash
# Publish or remove one preview on the calling repo's gh-pages branch.
# Each preview lives in its own folder (pr-12/), so previews don't replace
# each other. The branch root gets an index of the current previews.
#
#   pages.sh publish <slot> <dist dir>
#   pages.sh remove  <slot>
#
# Needs GH_TOKEN (contents: write) and GITHUB_REPOSITORY.
set -euo pipefail
action=$1
slot=$2
dist=${3:+$(cd "$3" && pwd)}
remote="https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
work=$(mktemp -d)

write_index() {
  {
    echo '<!doctype html><meta charset="utf-8"><title>Docs previews</title>'
    echo '<style>body{font:16px system-ui;margin:2rem}</style><h1>Docs previews</h1><ul>'
    for d in $(ls -d pr-*/ 2>/dev/null | sort -t- -k2 -n); do
      n=${d%/}
      echo "<li><a href=\"$n/\">$n</a> (<a href=\"https://github.com/${GITHUB_REPOSITORY}/pull/${n#pr-}\">pull request</a>)</li>"
    done
    echo '</ul>'
  } > index.html
}

# Several previews can publish at once: retry on a rejected push.
for attempt in 1 2 3 4 5; do
  rm -rf "$work" && mkdir -p "$work" && cd "$work"
  if ! git clone -q --depth 1 --branch gh-pages "$remote" . 2>/dev/null; then
    git init -q -b gh-pages && git remote add origin "$remote"
  fi
  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  rm -rf "$slot"
  if [ "$action" = publish ]; then mkdir -p "$slot" && cp -R "$dist/." "$slot/"; fi
  touch .nojekyll # keep Astro's _astro/ folder
  write_index
  git add -A
  if git diff --cached --quiet; then exit 0; fi
  git commit -qm "docs preview: $action $slot"
  if git push -q origin gh-pages; then exit 0; fi
  echo "push rejected (attempt $attempt), retrying"
  sleep $((attempt * 3))
done
echo "could not update gh-pages" >&2
exit 1
