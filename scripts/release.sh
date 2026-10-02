#!/bin/bash
set -euo pipefail
# Build/push one image, resolve its immutable digest, then deploy that app.
# Usage: scripts/release.sh <manifest.json|--connected> app registry/image:tag context [Dockerfile]
# --connected discovers .2server/connection.json from the current project.
[ "$#" -ge 4 ] && [ "$#" -le 5 ] || { echo 'Usage: release.sh <manifest|--connected> app image:tag context [Dockerfile]' >&2; exit 2; }
MANIFEST="$1" APP="$2" IMAGE="$3" CONTEXT="$4" DOCKERFILE="${5:-$4/Dockerfile}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
umask 077
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
if [ "$MANIFEST" = --connected ]; then
  bun "$ROOT/src/cli.ts" get app "$APP" >/dev/null
else
  bun "$ROOT/src/cli.ts" validate "$MANIFEST"
  jq -e --arg name "$APP" '[.apps[] | select(.name == $name)] | length == 1' "$MANIFEST" >/dev/null
fi
docker buildx build --push --tag "$IMAGE" --file "$DOCKERFILE" --metadata-file "$TEMP/build.json" "$CONTEXT"
DIGEST="$(jq -er '.["containerimage.digest"] | select(test("^sha256:[0-9a-f]{64}$"))' "$TEMP/build.json")"
# Strip a tag only after the final slash, preserving registry host ports.
REPOSITORY="${IMAGE%@*}"
LAST="${REPOSITORY##*/}"
if [[ "$LAST" == *:* ]]; then REPOSITORY="${REPOSITORY%:*}"; fi
if [ "$MANIFEST" = --connected ]; then
  bun "$ROOT/src/cli.ts" deploy app "$APP" --image "${REPOSITORY}@${DIGEST}" --apply
else
  bun "$ROOT/src/cli.ts" deploy app "$APP" -f "$MANIFEST" --image "${REPOSITORY}@${DIGEST}" --apply
fi
printf 'Deployed %s at %s@%s; desired image saved.\n' "$APP" "$REPOSITORY" "$DIGEST"
