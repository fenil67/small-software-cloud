#!/usr/bin/env bash
set -euo pipefail
TAG="${1:?usage: publish.sh <tag>}"
REPO=registry.fly.io/ssc-proxy-image
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
git -C "$ROOT" diff --quiet HEAD -- apps/proxy || { echo "apps/proxy has uncommitted changes; commit first"; exit 1; }
SHA="$(git -C "$ROOT" rev-parse HEAD)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
git clone -q "$ROOT" "$WORK/repo"; git -C "$WORK/repo" checkout -q "$SHA"
cd "$WORK/repo"
pnpm install --frozen-lockfile >/dev/null
pnpm --filter @ssc/proxy test >/dev/null 2>&1 || { echo "proxy tests failed; not publishing"; exit 1; }
docker build --platform linux/amd64 -q -t "$REPO:$TAG" apps/proxy >/dev/null
docker push -q "$REPO:$TAG" >/dev/null
echo "commit: $SHA"
echo "image:  $(docker inspect --format '{{index .RepoDigests 0}}' "$REPO:$TAG")"
