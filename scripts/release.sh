#!/bin/bash
set -euo pipefail
# Build/push one image, resolve its immutable digest, then deploy that app.
# Usage (from 2server/): scripts/release.sh manifest.json app registry/image:tag context [Dockerfile]
[ "$#" -ge 4 ] && [ "$#" -le 5 ] || { echo 'Usage: release.sh manifest app image:tag context [Dockerfile]' >&2; exit 2; }
MANIFEST="$1" APP="$2" IMAGE="$3" CONTEXT="$4" DOCKERFILE="${5:-$4/Dockerfile}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
umask 077
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
bun "$ROOT/src/cli.ts" validate "$MANIFEST"
jq -e --arg name "$APP" '[.apps[] | select(.name == $name)] | length == 1' "$MANIFEST" >/dev/null
docker buildx build --push --tag "$IMAGE" --file "$DOCKERFILE" --metadata-file "$TEMP/build.json" "$CONTEXT"
DIGEST="$(jq -er '.["containerimage.digest"] | select(test("^sha256:[0-9a-f]{64}$"))' "$TEMP/build.json")"
# Strip a tag only after the final slash, preserving registry host ports.
REPOSITORY="${IMAGE%@*}"
LAST="${REPOSITORY##*/}"
if [[ "$LAST" == *:* ]]; then REPOSITORY="${REPOSITORY%:*}"; fi
jq --arg name "$APP" --arg image "${REPOSITORY}@${DIGEST}" \
  '.apps = [.apps[] | select(.name == $name) | .image = $image]' "$MANIFEST" > "$TEMP/release.json"
bun "$ROOT/src/cli.ts" deploy "$TEMP/release.json" --apply
printf 'Deployed %s at %s@%s; record this digest in your manifest.\n' "$APP" "$REPOSITORY" "$DIGEST"
