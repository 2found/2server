import type { Config } from "./config";
import { quote, remote } from "./process";
import { upload } from "./edge";
import { baseCaddyfile, renderEdge } from "./render";
export async function setup(c: Config) {
  const bootstrap = await Bun.file(
    new URL("../scripts/bootstrap.sh", import.meta.url),
  ).text();
  await remote(
    c,
    `set -euo pipefail
if [ -f /opt/2server/edge/owner ]; then test "$(cat /opt/2server/edge/owner)" = ${quote(c.name)}; fi
${bootstrap}
printf '%s\n' ${quote(c.name)} > /opt/2server/edge/owner
docker network inspect ${quote(c.edge.network)} >/dev/null 2>&1 || docker network create ${quote(c.edge.network)}
`,
  );
  if (c.edge.mode === "managed") {
    // Refuse replacing an unrelated container that happens to share the name.
    await remote(
      c,
      `if docker inspect ${quote(c.edge.container)} >/dev/null 2>&1; then test "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' ${quote(c.edge.container)})" = two-server-edge; fi`,
    );
    await upload(
      c,
      {
        Caddyfile: baseCaddyfile,
        "compose.json": JSON.stringify(renderEdge(c)),
      },
      "/opt/2server/runtime",
    );
    await remote(
      c,
      `set -euo pipefail
exec 9>/var/lock/2server-edge.lock
flock -w 120 9
docker run --rm -v /opt/2server/runtime:/etc/caddy:ro -v /opt/2server/edge:/etc/2server:ro caddy:2.10.2-alpine caddy validate --config /etc/caddy/Caddyfile >/dev/null
docker compose -p two-server-edge -f /opt/2server/runtime/compose.json up -d
docker exec ${quote(c.edge.container)} caddy reload --config /etc/caddy/Caddyfile >/dev/null`,
    );
  } else {
    await remote(c, adoptionScript(c));
  }
}

export function adoptionScript(c: Config): string {
  return `set -euo pipefail
exec 9>/var/lock/2server-edge.lock
flock -w 120 9
ctr=${quote(c.edge.container)}
config=${quote(c.edge.configPath)}
source=$(docker inspect "$ctr" | jq -r --arg p "$config" '.[0].Mounts[] | select(.Destination == $p and .Type == "bind") | .Source')
[ -f "$source" ] || { echo 'Adoption requires a Caddyfile bind mount' >&2; exit 1; }
compose=$(docker inspect "$ctr" | jq -r '.[0].Config.Labels["com.docker.compose.project.config_files"]' | tr ',' '\\n' | grep -v '^/opt/2server/edge.override.json$')
project=$(docker inspect "$ctr" | jq -r '.[0].Config.Labels["com.docker.compose.project"]')
service=$(docker inspect "$ctr" | jq -r '.[0].Config.Labels["com.docker.compose.service"]')
image=$(docker inspect -f '{{.Image}}' "$ctr")
[ -f "$compose" ] && [ "$project" != null ] && [ "$service" != null ] || { echo 'Adoption requires one existing Compose file' >&2; exit 1; }
backup=$(mktemp)
cp "$source" "$backup"
restore() { cat "$backup" > "$source"; rm -f "$backup"; }
trap 'restore' ERR
for line in 'import /etc/2server/apps/*.caddy' 'import /etc/2server/current/sites/*.caddy'; do
  grep -Fxq "$line" "$source" || printf '\n%s\n' "$line" >> "$source"
done
docker run --rm --volumes-from "$ctr" -v /opt/2server/edge:/etc/2server:ro "$image" caddy validate --config "$config" >/dev/null
jq -n --arg s "$service" --arg image "$image" '{services:{($s):{image:$image,volumes:["/opt/2server/edge:/etc/2server:ro"]}}}' > /opt/2server/edge.override.json
docker compose -p "$project" -f "$compose" -f /opt/2server/edge.override.json up -d --no-deps "$service"
docker exec "$ctr" caddy reload --config "$config" >/dev/null
trap - ERR
rm -f "$backup"
`;
}
