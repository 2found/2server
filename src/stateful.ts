import {instanceName,instanceSecret} from './extensions/instance';
import type { Config } from "./config";
import type { Extension } from "./extensions/types";
import { remote, quote } from "./process";
import { upload } from "./edge";

// Shared lifecycle engine for stateful extensions (persistent data, one
// container per app): versioned release bundles, ownership checks, compose
// up --wait, pointer switch with rollback. Extension-specific behavior lives
// in the declaration's `stateful` hooks (see src/extensions/types.ts and
// docs/extensions.md); this file must not grow per-service branches.

export type StatefulSpec = {
  image: string;
  memoryMb: number;
  cpus: number;
  // Optional for generic service extensions; declared stateful extensions
  // (postgres, redis, nats) require it in their schemas.
  dataPath?: string;
};

function specOf(c: Config, ext: Extension): StatefulSpec {
  const e = (ext.spec?.(c) ??
    (c.extensions as unknown as Record<string, StatefulSpec | undefined>)[ext.name]) as StatefulSpec | undefined;
  if (!e) throw new Error(`Extension ${ext.name} is not configured`);
  return e;
}

export const extensionRoot = (name: string, c?: Config) =>
  `/opt/2server/extensions/${c ? instanceName(c,name) : name}`;
export const extensionProject = (c: Config, name: string) =>
  `two-${c.name}-${instanceName(c,name)}`;
export function requiredSecret(key: string, c?:Config) {
  const value = c ? instanceSecret(c,key) : process.env[key];
  if (!value || value.length < 20 || /[\x00-\x1f\x7f]/.test(value))
    throw new Error(
      `Set ${key} with 2server secret set ${c?.instance?`--app ${c.instance.name} `:""}--env-file PRIVATE_FILE --apply; use a single-line value of at least 20 characters (legacy bootstrap: 2server/.env)`,
    );
  return value;
}
export async function statefulFiles(
  c: Config,
  ext: Extension,
): Promise<Record<string, string>> {
  const e = specOf(c, ext);
  const files: Record<string, string> = { "extension.json": JSON.stringify(e), "identity.json": JSON.stringify({template:ext.context?.(c).instance?.template ?? ext.name}) };
  const service: Record<string, unknown> = {
    image: e.image,
    container_name: extensionProject(c, ext.name),
    restart: "unless-stopped",
    stop_grace_period: "60s",
    mem_limit: `${e.memoryMb}m`,
    cpus: e.cpus,
    pids_limit: 256,
    security_opt: ["no-new-privileges:true"],
    labels: { "io.2server.owner": c.name, "io.2server.extension": ext.name, "io.2server.app":ext.name },
    networks: [c.edge.network],
    logging: {
      driver: "json-file",
      options: { "max-size": "10m", "max-file": "3" },
    },
    // No published ports: clients connect from the same VM's Docker network.
  };
  await ext.stateful!.files(c, files, service);
  files["compose.json"] = JSON.stringify({
    // Compose advertises service keys as DNS aliases even with container_name.
    // Generic keys would collide with unrelated services on the shared network.
    services: { [extensionProject(c, ext.name)]: service },
    networks: { [c.edge.network]: { external: true } },
  }).replaceAll("$", "$$$$");
  return files;
}
export function statefulPreflightScript(c: Config, ext: Extension) {
  const e = specOf(c, ext);
  return `set -Eeuo pipefail
exec 7>/var/lock/2server-extension-${ext.name}.lock
flock -w 120 7
test "$(cat /opt/2server/edge/owner)" = ${quote(c.name)}
if docker inspect ${extensionProject(c, ext.name)} >/dev/null 2>&1; then
  test "$(docker inspect -f '{{index .Config.Labels "io.2server.owner"}}' ${extensionProject(c, ext.name)})" = ${quote(c.name)}
fi
${ext.stateful!.preflight?.(c) ?? ""}
if [ -f ${extensionRoot(ext.name)}/current/extension.json ]; then
  # Compare saved vs desired dataPath even when either is absent: dropping a
  # dataPath silently detaches the volume from the new container.
  test "$(jq -r '.dataPath // ""' ${extensionRoot(ext.name)}/current/extension.json)" = ${quote(e.dataPath ?? "")}
fi
${
  e.dataPath
    ? `if [ -d ${quote(e.dataPath)} ] && [ -n "$(ls -A ${quote(e.dataPath)})" ]; then
  test "$(cat ${quote(e.dataPath + "/.2server-owner")})" = ${quote(c.name + ":" + ext.name)}
fi`
    : ""
}
`;
}
export function migrateServiceAlias(c: Config, ext: Extension) {
  const container = quote(extensionProject(c, ext.name));
  return `service_changed=false
service=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' ${container} 2>/dev/null || true)
if [ -n "$service" ] && [ "$service" != ${container} ]; then
  test "$(docker inspect -f '{{index .Config.Labels "io.2server.owner"}}' ${container})" = ${quote(c.name)}
  # A container owned by this server but not by this extension (e.g. an adopted
  # Compose app whose name collides) is a hard conflict, never an alias target.
  test "$(docker inspect -f '{{index .Config.Labels "io.2server.extension"}}' ${container})" = ${quote(ext.name)} || { echo 'Container name collides with a foreign workload' >&2; exit 1; }
  service_changed=true
  docker rm -f ${container} >/dev/null
fi`;
}
export async function deployStateful(c: Config, ext: Extension) {
  const files = await statefulFiles(c, ext); // Resolve all required secrets before SSH.
  const e = specOf(c, ext);
  const hooks = ext.stateful!;
  await remote(c, statefulPreflightScript(c, ext));
  await hooks.beforeUpload?.(c);
  // Versioned bundles avoid overwriting files under a running container.
  const release = `${extensionRoot(ext.name)}/releases/${crypto.randomUUID()}`;
  await upload(c, files, release);
  await remote(
    c,
    `${statefulPreflightScript(c, ext)}
umask 077
${e.dataPath ? `mkdir -p ${quote(e.dataPath)}
printf '%s\\n' ${quote(c.name + ":" + ext.name)} > ${quote(e.dataPath + "/.2server-owner")}` : ""}
${hooks.prepareHost?.(c) ?? ""}
cd ${quote(extensionRoot(ext.name))}
${hooks.prepareRelease?.(c, release) ?? ""}
old=$(readlink current || true)
service_changed=false
rollback() {
  if [ "$service_changed" = true ]; then docker rm -f ${extensionProject(c, ext.name)} >/dev/null 2>&1 || true; fi
  if [ -n "$old" ]; then docker compose -p ${extensionProject(c, ext.name)} -f "$old/compose.json" up -d --wait --wait-timeout 150 >/dev/null 2>&1 || true; fi
}
trap 'rollback' ERR
${migrateServiceAlias(c, ext)}
docker compose -p ${extensionProject(c, ext.name)} -f ${quote(release + "/compose.json")} up -d --wait --wait-timeout 150 >/dev/null
${hooks.verify?.(c) ?? ""}
rm -f current.next
ln -s ${quote(release)} current.next
mv -Tf current.next current
rm -f retired
trap - ERR
${hooks.postInstall?.(c) ?? ""}
`,
  );
  await hooks.afterDeploy?.(c);
}
export async function removeStateful(c: Config, ext: Extension) {
  await remote(
    c,
    `set -euo pipefail
exec 7>/var/lock/2server-extension-${ext.name}.lock
flock -w 120 7
test "$(cat /opt/2server/edge/owner)" = ${quote(c.name)}
${ext.stateful!.teardown?.(c) ?? ""}
if [ -f ${extensionRoot(ext.name)}/current/compose.json ]; then
  docker compose -p ${extensionProject(c, ext.name)} -f ${extensionRoot(ext.name)}/current/compose.json down
fi
mkdir -p ${extensionRoot(ext.name)}
touch ${extensionRoot(ext.name)}/retired
# Retain data, secrets, backups and release bundles for recovery.
`,
  );
}
