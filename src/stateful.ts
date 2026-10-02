import type { Config } from "./config";
import { remote, quote } from "./process";
import { upload } from "./edge";
import { backupFiles, backupInstallScript } from "./backups";
import { provisionBackupStorage } from "./backup-storage";
import { postgresInit, postgresEntrypoint } from "./postgres";
import { postgresDockerfile, postgresImage, pgbackrestConfig } from "./pgbackrest";
import { postgresHealthFiles, postgresHealthInstall } from "./postgres-health";

export const statefulNames = ["postgres", "redis", "nats"] as const;
export type Stateful = (typeof statefulNames)[number];
export const extensionRoot = (name: Stateful) =>
  `/opt/2server/extensions/${name}`;
export const extensionProject = (c: Config, name: Stateful) =>
  `two-${c.name}-${name}`;
export function requiredSecret(key: string) {
  const value = process.env[key];
  if (!value || value.length < 20 || /[\x00-\x1f\x7f]/.test(value))
    throw new Error(
      `Set ${key} in 2server/.env to a single-line secret of at least 20 characters`,
    );
  return value;
}
export function statefulFiles(
  c: Config,
  name: Stateful,
): Record<string, string> {
  const e = c.extensions[name];
  if (!e) throw new Error(`Extension ${name} is not configured`);
  const files: Record<string, string> = { "extension.json": JSON.stringify(e) };
  const service: Record<string, unknown> = {
    image: e.image,
    container_name: extensionProject(c, name),
    restart: "unless-stopped",
    mem_limit: `${e.memoryMb}m`,
    cpus: e.cpus,
    pids_limit: 256,
    security_opt: ["no-new-privileges:true"],
    labels: { "io.2server.owner": c.name, "io.2server.extension": name },
    networks: [c.edge.network],
    logging: {
      driver: "json-file",
      options: { "max-size": "10m", "max-file": "3" },
    },
    // No published ports: clients connect from the same VM's Docker network.
  };
  if (name === "postgres") {
    const p = c.extensions.postgres!;
    files["app-password"] = requiredSecret(p.passwordEnv);
    files["admin-password"] = requiredSecret(p.adminPasswordEnv);
    files["migration-password"] = requiredSecret(p.migrationPasswordEnv);
    if (new Set([files["app-password"], files["admin-password"], files["migration-password"]]).size !== 3)
      throw new Error("PostgreSQL app, admin and migration passwords must differ");
    files["init.sh"] = postgresInit(c);
    files["entrypoint.sh"] = postgresEntrypoint;
    service.entrypoint = ["bash", "/run/2server-input/entrypoint.sh"];
    service.tmpfs = ["/run/2server:mode=0700"];
    service.command = ["postgres"];
    service.environment = {
      POSTGRES_DB: p.database,
      POSTGRES_USER: "two_admin",
      POSTGRES_PASSWORD_FILE: "/run/2server/admin-password",
      POSTGRES_INITDB_ARGS: "--auth-host=scram-sha-256 --auth-local=trust",
    };
    service.volumes = [
      `${p.dataPath}:/var/lib/postgresql`,
      "./:/run/2server-input:ro",
    ];
    if (p.backup?.engine === "pgbackrest") {
      files["Dockerfile"] = postgresDockerfile(c);
      files[".dockerignore"] = "**\n!Dockerfile\n";
      files["pgbackrest.conf"] = pgbackrestConfig(c);
      service.image = postgresImage(c);
      service.build = { context: ".", dockerfile: "Dockerfile" };
      (service.volumes as string[]).push("./pgbackrest.conf:/etc/pgbackrest/pgbackrest.conf:ro");
      service.command = ["postgres", "-c", "archive_mode=on", "-c", "archive_timeout=300",
        "-c", "archive_command=pgbackrest --stanza=main archive-push %p"];
    }
    service.healthcheck = {
      test: ["CMD-SHELL", `export PGPASSWORD=$(cat /run/2server/app-password); psql -X -h 127.0.0.1 -U ${p.username} -d ${p.database} -Atc 'SELECT 1' >/dev/null`],
      interval: "5s",
      timeout: "3s",
      retries: 24,
      start_period: "20s",
    };
    Object.assign(files, backupFiles(c));
    Object.assign(files, postgresHealthFiles(c));
  } else if (name === "redis") {
    const r = c.extensions.redis!;
    files["password"] = requiredSecret(r.passwordEnv);
    files["redis.conf"] =
      `bind 0.0.0.0\nprotected-mode yes\nport 6379\nrequirepass ${JSON.stringify(requiredSecret(r.passwordEnv))}\nappendonly yes\nappendfsync everysec\ndir /data\nmaxmemory ${r.maxmemoryMb}mb\nmaxmemory-policy noeviction\n`;
    // The official entrypoint switches to redis after the root-only input is copied.
    service.entrypoint = [
      "sh",
      "-ec",
      "chown redis:redis /data; chmod 700 /data; cp /run/secrets/redis.conf /data/redis.conf; chown redis:redis /data/redis.conf; exec /usr/local/bin/docker-entrypoint.sh redis-server /data/redis.conf",
    ];
    service.volumes = [
      `${r.dataPath}:/data`,
      "./redis.conf:/run/secrets/redis.conf:ro",
      "./password:/run/secrets/redis-password:ro",
    ];
    // An unauthenticated PING must report NOAUTH. Authenticated readiness is below.
    service.healthcheck = {
      test: ["CMD-SHELL", "redis-cli ping 2>&1 | grep -q NOAUTH"],
      interval: "5s",
      timeout: "3s",
      retries: 24,
    };
  } else {
    const n = c.extensions.nats!;
    files["nats.conf"] = JSON.stringify({
      server_name: extensionProject(c, name),
      port: 4222,
      http: "127.0.0.1:8222",
      authorization: { token: requiredSecret(n.tokenEnv) },
      ...(n.jetstream
        ? {
            jetstream: {
              store_dir: "/data/jetstream",
              max_memory_store: n.maxMemoryMb * 1024 * 1024,
              max_file_store: n.maxFileGb * 1024 ** 3,
            },
          }
        : {}),
    });
    service.user = "0:0";
    service.cap_drop = ["ALL"];
    service.command = ["-c", "/etc/nats/nats.conf"];
    service.volumes = [
      `${n.dataPath}:/data`,
      "./nats.conf:/etc/nats/nats.conf:ro",
    ];
    service.healthcheck = {
      test: [
        "CMD-SHELL",
        `wget -qO- 'http://127.0.0.1:8222/healthz${n.jetstream ? "?js-enabled-only=true" : ""}' >/dev/null`,
      ],
      interval: "5s",
      timeout: "3s",
      retries: 24,
    };
  }
  files["compose.json"] = JSON.stringify({
    // Compose advertises service keys as DNS aliases even with container_name.
    // Generic keys would collide with unrelated services on the shared network.
    services: { [extensionProject(c, name)]: service },
    networks: { [c.edge.network]: { external: true } },
  }).replaceAll("$", "$$");
  return files;
}
export function statefulPreflightScript(c: Config, name: Stateful) {
  const e = c.extensions[name]!;
  const disk =
    name === "postgres" && c.extensions.postgres?.disk
      ? c.disks.find((d) => d.name === c.extensions.postgres!.disk)
      : undefined;
  return `set -euo pipefail
exec 7>/var/lock/2server-extension-${name}.lock
flock -w 120 7
test "$(cat /opt/2server/edge/owner)" = ${quote(c.name)}
if docker inspect ${extensionProject(c, name)} >/dev/null 2>&1; then
  test "$(docker inspect -f '{{index .Config.Labels "io.2server.owner"}}' ${extensionProject(c, name)})" = ${quote(c.name)}
fi
${
  disk
    ? `mountpoint -q ${quote(disk.mountPath)}
test "$(readlink -f ${quote(disk.device)})" = "$(readlink -f "$(findmnt -n -o SOURCE --target ${quote(disk.mountPath)})")"`
    : ""
}
if [ -d ${quote(e.dataPath)} ] && [ -n "$(ls -A ${quote(e.dataPath)})" ]; then
  test "$(cat ${quote(e.dataPath + "/.2server-owner")})" = ${quote(c.name + ":" + name)}
fi
if [ -f ${extensionRoot(name)}/current/extension.json ]; then
  test "$(jq -r .dataPath ${extensionRoot(name)}/current/extension.json)" = ${quote(e.dataPath)}
  ${
    name === "postgres"
      ? `test "$(jq -r .username ${extensionRoot(name)}/current/extension.json)" = ${quote(c.extensions.postgres!.username)}
  test "$(jq -r .database ${extensionRoot(name)}/current/extension.json)" = ${quote(c.extensions.postgres!.database)}`
      : ""
  }
fi
# Never silently initialize another cluster inside a legacy major-version directory.
${
  name === "postgres"
    ? `if [ -d ${quote(e.dataPath)} ]; then
  for v in $(find ${quote(e.dataPath)} -maxdepth 3 -name PG_VERSION); do
    test "$(cat "$v")" = 18
    test -f "$(dirname "$v")/.2server-roles-v1" || { echo 'Unrecognized PostgreSQL role layout; refusing to modify existing data' >&2; exit 1; }
  done
fi`
    : ""
}
`;
}
export function postgresDataPreparation(c: Config) {
  const p = c.extensions.postgres!;
  // PG18's entrypoint fixes PGDATA, but does not chown the parent mount before
  // switching to postgres. A root-owned 0700 bind mount therefore cannot start.
  // Resolve postgres through the actual image (Debian/alpine IDs differ).
  return `docker image inspect ${quote(p.image)} >/dev/null 2>&1 || docker pull ${quote(p.image)} >/dev/null
  docker run --rm --network none --user 0:0 --security-opt no-new-privileges:true \
    --entrypoint sh -v ${quote(p.dataPath + ":/var/lib/postgresql")} ${quote(p.image)} \
    -ec 'chown postgres:postgres /var/lib/postgresql; chmod 700 /var/lib/postgresql'`;
}
export function migrateServiceAlias(c: Config, name: Stateful) {
  const container = quote(extensionProject(c, name));
  return `service_changed=false
service=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' ${container} 2>/dev/null || true)
if [ -n "$service" ] && [ "$service" != ${container} ]; then
  test "$(docker inspect -f '{{index .Config.Labels "io.2server.owner"}}' ${container})" = ${quote(c.name)}
  service_changed=true
  docker rm -f ${container} >/dev/null
fi`;
}
export async function deployStateful(c: Config, name: Stateful) {
  const files = statefulFiles(c, name); // Resolve all required secrets before SSH.
  const e = c.extensions[name]!;
  await remote(c, statefulPreflightScript(c, name));
  if (name === "postgres" && c.extensions.postgres?.backup && !c.extensions.postgres.backup.destination)
    await provisionBackupStorage(c, true);
  // Versioned bundles avoid overwriting files under a running container.
  const release = `${extensionRoot(name)}/releases/${crypto.randomUUID()}`;
  await upload(c, files, release);
  await remote(
    c,
    `${statefulPreflightScript(c, name)}
umask 077
mkdir -p ${quote(e.dataPath)}
printf '%s\\n' ${quote(c.name + ":" + name)} > ${quote(e.dataPath + "/.2server-owner")}
${name === "postgres" ? postgresDataPreparation(c) : ""}
cd ${quote(extensionRoot(name))}
${name === "postgres" && c.extensions.postgres?.backup?.engine === "pgbackrest" ? `chmod 644 ${quote(release + "/pgbackrest.conf")}` : ""}
old=$(readlink current || true)
service_changed=false
rollback() {
  if [ "$service_changed" = true ]; then docker rm -f ${extensionProject(c, name)} >/dev/null 2>&1 || true; fi
  if [ -n "$old" ]; then docker compose -p ${extensionProject(c, name)} -f "$old/compose.json" up -d --wait --wait-timeout 150 >/dev/null 2>&1 || true; fi
}
trap 'rollback' ERR
${migrateServiceAlias(c, name)}
docker compose -p ${extensionProject(c, name)} -f ${quote(release + "/compose.json")} up -d --wait --wait-timeout 150 >/dev/null
${name === "postgres" ? `docker exec ${extensionProject(c, name)} sh -ec 'export PGPASSWORD=$(cat /run/2server/app-password); psql -h 127.0.0.1 -U ${c.extensions.postgres!.username} -d ${c.extensions.postgres!.database} -v ON_ERROR_STOP=1 -Atc "SELECT 1"' >/dev/null` : ""}
${name === "redis" ? `docker exec ${extensionProject(c, name)} sh -ec 'export REDISCLI_AUTH=$(cat /run/secrets/redis-password); redis-cli ping | grep -qx PONG'` : ""}
rm -f current.next
ln -s ${quote(release)} current.next
mv -Tf current.next current
trap - ERR
${name === "postgres" ? postgresHealthInstall(c) : ""}
${name === "postgres" ? backupInstallScript(c) : ""}
`,
  );
  // Separate SSH invocation: the restore drill takes the same deployment lock.
  if (name === "postgres" && c.extensions.postgres?.backup?.engine === "pgbackrest")
    await remote(c, `systemctl start two-${c.name}-postgres-restore-check.service`);
}
export async function removeStateful(c: Config, name: Stateful) {
  await remote(
    c,
    `set -euo pipefail
exec 7>/var/lock/2server-extension-${name}.lock
flock -w 120 7
test "$(cat /opt/2server/edge/owner)" = ${quote(c.name)}
${
  name === "postgres"
      ? `systemctl disable --now two-${c.name}-postgres-metrics.timer two-${c.name}-postgres-restore-check.timer 2>/dev/null || true
systemctl stop two-${c.name}-postgres-metrics.service two-${c.name}-postgres-restore-check.service 2>/dev/null || true
rm -f /opt/2server/metrics/postgres.prom
systemctl disable --now two-${c.name}-postgres-backup.timer 2>/dev/null || true
systemctl stop two-${c.name}-postgres-backup.service 2>/dev/null || true`
    : ""
}
if [ -f ${extensionRoot(name)}/current/compose.json ]; then
  docker compose -p ${extensionProject(c, name)} -f ${extensionRoot(name)}/current/compose.json down
fi
# Retain data, secrets, backups and release bundles for recovery.
`,
  );
}
