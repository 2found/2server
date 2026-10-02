#!/bin/bash
set -euo pipefail
# Build/push, then deploy a source App file using this build's immutable digest.
# Apps requiring DB migration should use their migration-aware release script.
[ "$#" -ge 3 ] && [ "$#" -le 4 ] || { echo 'Usage: release.sh app.yaml registry/image:tag context [Dockerfile]' >&2; exit 2; }
CONFIG="$1" IMAGE="$2" CONTEXT="$3" DOCKERFILE="${4:-$3/Dockerfile}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
umask 077
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
bun "$ROOT/src/cli.ts" validate -f "$CONFIG"
docker buildx build --push --tag "$IMAGE" --file "$DOCKERFILE" --metadata-file "$TEMP/build.json" "$CONTEXT"
DIGEST="$(jq -er '.["containerimage.digest"] | select(test("^sha256:[0-9a-f]{64}$"))' "$TEMP/build.json")"
REPOSITORY="${IMAGE%@*}"
LAST="${REPOSITORY##*/}"
if [[ "$LAST" == *:* ]]; then REPOSITORY="${REPOSITORY%:*}"; fi
bun "$ROOT/src/cli.ts" deploy -f "$CONFIG" --image "$REPOSITORY@$DIGEST" --apply
