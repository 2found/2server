import { quote,remote } from "../../../shared/infrastructure/process";
import type { Config } from "../../config/application/config";
import type { Domain } from "../domain/schema";
import { Cloudflare,cacheRule } from "../infrastructure/cloudflare";

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
