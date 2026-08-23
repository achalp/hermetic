#!/usr/bin/env bash
# One-command release (release-path phase 3):
#   scripts/release.sh 0.2.0        → stable release
#   scripts/release.sh 0.2.0-rc.1   → prerelease (never moves :latest)
# Bumps package.json, commits, tags vX.Y.Z, pushes both — the tag push
# triggers .github/workflows/release.yml (gate → GHCR image → Release).
set -euo pipefail
VERSION="${1:?usage: scripts/release.sh <semver, no leading v>}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || { echo "not semver: $VERSION" >&2; exit 1; }
[[ "$(git branch --show-current)" == "main" ]] || { echo "release from main only" >&2; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo "working tree not clean" >&2; exit 1; }
git pull --ff-only
node -e "const f='./package.json',p=require(f);p.version='$VERSION';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
git add package.json
git commit -m "release: v$VERSION"
git tag "v$VERSION"
git push origin main "v$VERSION"
echo "Pushed v$VERSION — release workflow: gh run watch \$(gh run list --workflow=release.yml -L1 --json databaseId -q '.[0].databaseId')"
