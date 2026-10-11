import { readdir,rm } from "node:fs/promises";
import { join } from "node:path";
import { operatorState } from "../../../shared/infrastructure/operator-state";
import { quote,remote } from "../../../shared/infrastructure/process";
import { deleteVmSecrets } from "../../../shared/infrastructure/vm-secrets";
import type { Config } from "../../config/application/config";
import { domainsRoutingTo,imageRepository,purgeDataPathIssue } from "../domain/purge";
import type { Extension } from "../domain/types";
import { withExtensionDomains } from "./registry";
import { extensionProject,extensionRoot,removeStateful,specOf } from "./stateful";

// `delete --purge`: retire, then remove everything the instance owns on the VM
// (container, extension root, data, images, lock) plus its app-scoped secrets
// and deployment records. Every precondition is checked before any effect and
// again on the VM; a path that cannot be proven owned is refused, never removed.

export type PurgePlan = {
  app: string;
  containers: string[];
  extensionRoot: string;
  dataPath: string | null;
  imageRepository: string | null;
  lock: string;
  secrets: string;
};
const appScoped = (c: Config, name: string) => !!(c.extensionApps?.[name] || c.extensions.services?.[name]);
export function purgePlan(c: Config, ext: Extension): PurgePlan {
  if (ext.source) throw new Error("External apps are retired through their provider; --purge applies to VM workloads");
  if (ext.stateful) {
    const { beforeUpload, postInstall, afterDeploy } = ext.stateful;
    if (beforeUpload || postInstall || afterDeploy)
      throw new Error(`Purge is unsupported for ${ext.name}: its template installs host or external artifacts outside the instance root; delete without --purge retains them`);
  } else if (!ext.purge) throw new Error(`Purge is unsupported for ${ext.name}; delete without --purge retains its data`);
  const containers = [...new Set([...(ext.containers?.(c) ?? []), extensionProject(c, ext.name)])];
  const routed = domainsRoutingTo(withExtensionDomains(c), containers);
  if (routed.length)
    throw new Error(`Domain ${routed.join(", ")} still routes to ${ext.name}; retire it with 2srv delete domain NAME --apply (or reroute it) before purging`);
  const spec = ext.stateful ? specOf(c, ext) : (ext.spec?.(c) as { image?: string } | undefined);
  const dataPath = (ext.stateful ? specOf(c, ext).dataPath : ext.dataPaths?.(c)[0]) ?? null;
  const issue = dataPath ? purgeDataPathIssue(dataPath) : undefined;
  if (issue) throw new Error(`Refusing to purge dataPath ${dataPath}: ${issue}`);
  return {
    app: ext.name, containers, extensionRoot: extensionRoot(ext.name), dataPath,
    imageRepository: spec?.image ? imageRepository(spec.image) : null,
    lock: `/var/lock/2server-extension-${ext.name}.lock`,
    secrets: appScoped(c, ext.name) ? `app-scoped VM secrets of ${ext.name}` : "server-scoped secrets are retained; remove them with 2srv secret delete --key KEY",
  };
}
// Runs after removeStateful under the same per-extension lock file.
export function statefulPurgeScript(c: Config, ext: Extension, plan: PurgePlan): string {
  const refuse = (why: string) => `refuse ${quote(why)}`;
  return `set -euo pipefail
exec 7>${plan.lock}
flock -w 120 7
test "$(cat /opt/2server/edge/owner)" = ${quote(c.name)}
refuse() { echo "Refusing purge: $1" >&2; exit 1; }
for n in ${plan.containers.map(quote).join(" ")}; do
  if docker container inspect "$n" >/dev/null 2>&1; then ${refuse("a container still exists")}; fi
done
if [ -n "$(docker ps -aq --filter label=io.2server.owner=${c.name} --filter label=io.2server.app=${ext.name})" ]; then ${refuse("an owned container still exists")}; fi
if grep -RqsF ${plan.containers.map(n => `-e ${quote(n + ":")}`).join(" ")} /opt/2server/edge/current/sites/; then ${refuse("published routes still reference this app")}; fi
root=${quote(plan.extensionRoot)}
root_state=absent
if [ -e "$root" ] || [ -L "$root" ]; then
  { [ -d "$root" ] && [ ! -L "$root" ]; } || ${refuse("extension root is not a plain directory")}
  if [ -f "$root/current/extension.json" ]; then
    [ "$(jq -r '.dataPath // ""' "$root/current/extension.json")" = ${quote(plan.dataPath ?? "")} ] || ${refuse("installed dataPath differs from the manifest")}
  fi
  root_state=removed
fi
data_state=none
${plan.dataPath ? `data=${quote(plan.dataPath)}
case "$data" in /opt/2server/?*|/srv/?*) ;; *) ${refuse("unsafe data path")};; esac
data_state=absent
if [ -e "$data" ] || [ -L "$data" ]; then
  { [ -d "$data" ] && [ ! -L "$data" ] && [ "$(readlink -f -- "$data")" = "$data" ]; } || ${refuse("data path is not a plain directory")}
  { [ -f "$data/.2server-owner" ] && [ ! -L "$data/.2server-owner" ]; } || ${refuse("data path has no ownership marker")}
  [ "$(cat -- "$data/.2server-owner")" = ${quote(`${c.name}:${ext.name}`)} ] || ${refuse("data path is owned by another workload")}
  data_state=removed
fi` : ""}
# Every check passed; remove owned state.
if [ "$root_state" = removed ]; then rm -rf --one-file-system -- "$root"; fi
if [ "$data_state" = removed ]; then rm -rf --one-file-system -- "$data"; fi
removed=$(mktemp) in_use=$(mktemp)
trap 'rm -f "$removed" "$in_use"' EXIT
${plan.imageRepository ? `# Docker refuses images any container (running or stopped) still uses.
docker image ls --digests --format '{{json .}}' | jq -r --arg repo ${quote(plan.imageRepository)} 'select(.Repository == $repo) | if .Tag != "<none>" then .Repository + ":" + .Tag elif .Digest != "<none>" then .Repository + "@" + .Digest else .ID end' | sort -u | while IFS= read -r ref; do
  if docker image rm "$ref" >/dev/null 2>&1; then echo "$ref" >> "$removed"; else echo "$ref" >> "$in_use"; fi
done` : ""}
rm -f -- ${plan.lock}
jq -cn --arg root "$root_state" --arg data "$data_state" --rawfile removed "$removed" --rawfile inUse "$in_use" '{container:"absent",extensionRoot:$root,dataPath:$data,images:{removed:($removed|split("\\n")|map(select(length>0))),inUse:($inUse|split("\\n")|map(select(length>0)))},lock:"removed"}'
`;
}
// Read-only: immutable control revisions and edge releases are shared rollback
// history, so purge reports what still mentions the app instead of rewriting it.
export function retainedHistoryScript(app: string, containers: string[]): string {
  return `set -euo pipefail
control=0
for snapshot in /opt/2server/control/revisions/*/snapshot.json; do
  [ -f "$snapshot" ] || continue
  if jq -e --arg app ${quote(app)} '(.appSecrets // {}) | has($app)' "$snapshot" >/dev/null 2>&1; then control=$((control+1)); fi
done
edge=0
for sites in /opt/2server/edge/releases/*/sites; do
  [ -d "$sites" ] || continue
  if grep -RqsF ${containers.map(n => `-e ${quote(n + ":")}`).join(" ")} "$sites"; then edge=$((edge+1)); fi
done
printf '{"controlRevisionsWithSecrets":%s,"edgeReleasesWithRoutes":%s}\\n' "$control" "$edge"
`;
}
const lastJson = (output: string) => JSON.parse(output.trim().split("\n").at(-1) ?? "{}");
async function purgeControlReferences(c: Config, name: string) {
  const keys = appScoped(c, name) ? deleteVmSecrets(name) : undefined;
  const dir = join(operatorState(c.name), "deployments");
  let records = 0;
  for (const file of await readdir(dir).catch(() => [] as string[])) {
    const record = await Bun.file(join(dir, file)).json().catch(() => undefined);
    if (["App", "Extension", "Service"].includes(record?.document?.kind) && record.document.metadata?.name === name) {
      await rm(join(dir, file), { force: true });
      records++;
    }
  }
  return {
    secretKeys: keys ?? (appScoped(c, name) ? "unavailable without a connected session" : "server-scoped secrets retained"),
    deploymentRecords: records,
  };
}
export async function purgeExtension(c: Config, ext: Extension): Promise<Record<string, unknown>> {
  const plan = purgePlan(c, ext);
  let host: Record<string, unknown>;
  if (ext.stateful) {
    await removeStateful(c, ext);
    host = lastJson(await remote(c, statefulPurgeScript(c, ext, plan)));
  } else host = await ext.purge!(withExtensionDomains(c));
  const control = await purgeControlReferences(c, ext.name);
  // A failed report must not fail a purge that has already removed state.
  const retainedHistory = await remote(c, retainedHistoryScript(ext.name, plan.containers)).then(lastJson, () => "unavailable");
  return { app: ext.name, purged: true, host, control, retainedHistory };
}
