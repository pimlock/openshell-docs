#!/usr/bin/env bash
# Check a downloaded preview is plain files before publishing it.
#   check-site.sh <dir>
# The build ran the pull request's code, so refuse anything but regular
# files and directories (symlinks could point outside the preview once
# copied), oversized builds, and builds without an index page.
set -euo pipefail
dir=$1
max_mb=${MAX_MB:-200}
odd=$(find "$dir" ! -type f ! -type d | head -n 5)
if [ -n "$odd" ]; then
  echo "::error::The preview contains files that aren't regular files:"
  echo "$odd"
  exit 1
fi
size=$(du -sm "$dir" | cut -f1)
if [ "$size" -gt "$max_mb" ]; then
  echo "::error::The preview is ${size} MB; the limit is ${max_mb} MB."
  exit 1
fi
if [ ! -f "$dir/index.html" ]; then
  echo "::error::The preview has no index.html."
  exit 1
fi
echo "$(find "$dir" -type f | wc -l) files, ${size} MB"
