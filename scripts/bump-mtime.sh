#!/usr/bin/env bash
# Bumps the mtime of a file so an "on-file-change" schedule fires.
# Usage: ./scripts/bump-mtime.sh <path-to-file>
set -e
if [ -z "$1" ]; then
  echo "Usage: $0 <path-to-file>"
  exit 1
fi
touch "$1"
echo "Bumped mtime: $1"
