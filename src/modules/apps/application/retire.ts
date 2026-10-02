import { quote,remote } from "../../../shared/infrastructure/process";
import type { Config } from "../../config/application/config";
import { assertAppUnreferenced } from "../domain/retirement";
import type { App } from "../domain/schema";
import { appLock } from "../infrastructure/runtime";

export async function retireApp(c: Config, a: App) {
  assertAppUnreferenced(c, a);
  if (a.compose) throw new Error("Retire the adopted Caddy route and Compose pair explicitly; data-preserving adoption does not infer legacy route ownership");
  await remote(
    c,
    `set -euo pipefail
${appLock(a)}
exec 9>/var/lock/2server-edge.lock
flock -w 120 9
test "$(cat /opt/2server/edge/owner)" = ${quote(c.name)}
# Check actual published sites too, including sites absent from the local manifest.
if grep -RE ${quote(`up_two_${a.name}([^a-z0-9_-]|$)|two-${c.name}-${a.name}-`)} /opt/2server/edge/current/sites/; then
  echo 'Published routes still reference this app' >&2; exit 1
fi
snippet=/opt/2server/edge/apps/${a.name}.caddy
if [ -f "$snippet" ]; then
  mv "$snippet" "$snippet.retired"
  trap 'mv "$snippet.retired" "$snippet"' ERR
  docker exec ${quote(c.edge.container)} caddy validate --config ${quote(c.edge.configPath)} >/dev/null
  docker exec ${quote(c.edge.container)} caddy reload --config ${quote(c.edge.configPath)} >/dev/null
  trap - ERR
fi
ids=$(docker ps -aq --filter label=io.2server.owner=${c.name} --filter label=io.2server.app=${a.name})
if [ -n "$ids" ]; then docker stop -t 60 $ids >/dev/null; docker rm $ids >/dev/null; fi
# Legacy unlabeled generations are handled only when a saved app contract owns them.
for color in blue green; do
  saved=/opt/2server/apps/${a.name}/$color.json
  if [ -f "$saved" ]; then
    test "$(jq -r .name "$saved")" = ${quote(a.name)}
    docker rm -f two-${c.name}-${a.name}-$color >/dev/null 2>&1 || true
  fi
done
rm -f /opt/2server/apps/${a.name}/current /opt/2server/apps/${a.name}/previous
`,
  );
}
