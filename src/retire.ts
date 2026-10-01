import type { Config, Domain, App } from "./config";
import { Cloudflare, cacheRule } from "./cloudflare";
import { quote, remote } from "./process";
import { appLock } from "./apps";

export async function retireDomain(
  c: Config,
  d: Domain,
  cf: Cloudflare,
  execute = remote,
) {
  const zone = await cf.zone(d.zone);
  const owner = `2server:${c.name}:${d.name}`;
  const records = await Promise.all(
    d.hosts.map(async (h) => ({
      host: h,
      rows: (await cf.records(zone, h)).filter((r) =>
        ["A", "AAAA", "CNAME"].includes(r.type),
      ),
    })),
  );
  for (const { host, rows } of records)
    if (rows.some((r) => r.comment !== owner || r.type !== "A"))
      throw new Error(`${host}: refusing to delete unowned or conflicting DNS`);
  const rules = await cf.ruleset(zone);
  const ref = cacheRule(c.name, d).ref;
  const owned = (rules?.rules ?? []).filter(
    (r) => r.ref === ref || r.ref === ref + "_bypass",
  );
  if (owned.some((r) => !r.id || !r.description.startsWith(owner)))
    throw new Error("Cache rule ownership mismatch");
  for (const { host, rows } of records) {
    const now = (await cf.records(zone, host)).filter((r) =>
      ["A", "AAAA", "CNAME"].includes(r.type),
    );
    if (JSON.stringify(now) !== JSON.stringify(rows))
      throw new Error("DNS changed during retirement; retry after inspection");
    for (const row of rows)
      await cf.call("DELETE", `/zones/${zone}/dns_records/${row.id}`);
  }
  for (const r of owned)
    await cf.call(
      "DELETE",
      `/zones/${zone}/rulesets/${rules!.id}/rules/${r.id}`,
    );
  // Keep the old authenticated origin route alive while Cloudflare's automatic TTL drains.
  await execute(c, retireDomainScript(c, d));
}
export function retireDomainScript(c: Config, d: Domain) {
  return `set -euo pipefail
sleep 300
exec 9>/var/lock/2server-edge.lock
flock -w 120 9
cd /opt/2server/edge
test "$(cat owner)" = ${quote(c.name)}
old=$(readlink current)
release=$(mktemp -d releases/retire.XXXXXX)
cp -a current/. "$release/"
rm -f "$release/sites/${d.name}.caddy"
jq --argjson removed ${quote(JSON.stringify(d.hosts))} '. - $removed' current/domains.json > "$release/domains.json"
restore() { ln -s "$old" current.restore; mv -Tf current.restore current; docker exec ${quote(c.edge.container)} caddy reload --config ${quote(c.edge.configPath)} >/dev/null 2>&1 || true; }
trap 'restore' ERR
ln -s "$release" current.next
mv -Tf current.next current
docker exec ${quote(c.edge.container)} caddy validate --config ${quote(c.edge.configPath)} >/dev/null
docker exec ${quote(c.edge.container)} caddy reload --config ${quote(c.edge.configPath)} >/dev/null
trap - ERR
printf '%s\\n' "$old" > previous
`;
}
export function assertAppUnreferenced(c: Config, a: App) {
  const uses = (u: Domain["upstream"]) =>
    u.kind === "import"
      ? u.name === `up_two_${a.name}`
      : u.target.startsWith(`two-${c.name}-${a.name}-`);
  if (
    c.domains.some(
      (d) => uses(d.upstream) || d.routes.some((r) => uses(r.upstream)),
    )
  )
    throw new Error(
      "Remove or reroute domains referencing this app before deletion",
    );
}
export async function retireApp(c: Config, a: App) {
  assertAppUnreferenced(c, a);
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
