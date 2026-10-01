import type { Config } from "./config";
import { remote, quote } from "./process";
import { upload } from "./edge";
import { backupFiles, backupInstallScript } from "./backups";

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
    files["password"] = requiredSecret(p.passwordEnv);
    service.environment = {
      POSTGRES_DB: p.database,
      POSTGRES_USER: p.username,
      POSTGRES_PASSWORD_FILE: "/run/secrets/postgres-password",
      POSTGRES_INITDB_ARGS: "--auth-host=scram-sha-256 --auth-local=trust",
    };
    service.volumes = [
      `${p.dataPath}:/var/lib/postgresql`,
      "./password:/run/secrets/postgres-password:ro",
    ];
    service.healthcheck = {
      test: ["CMD-SHELL", `pg_isready -U ${p.username} -d ${p.database}`],
      interval: "5s",
      timeout: "3s",
      retries: 24,
      start_period: "20s",
    };
    Object.assign(files, backupFiles(c));
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
    services: { [name]: service },
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
  for v in $(find ${quote(e.dataPath)} -maxdepth 3 -name PG_VERSION); do test "$(cat "$v")" = 18; done
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
  return `docker pull ${quote(p.image)} >/dev/null
  docker run --rm --network none --user 0:0 --security-opt no-new-privileges:true \
    --entrypoint sh -v ${quote(p.dataPath + ":/var/lib/postgresql")} ${quote(p.image)} \
    -ec 'chown postgres:postgres /var/lib/postgresql; chmod 700 /var/lib/postgresql'`;
}
export async function deployStateful(c: Config, name: Stateful) {
  const files = statefulFiles(c, name); // Resolve all required secrets before SSH.
  const e = c.extensions[name]!;
  await remote(c, statefulPreflightScript(c, name));
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
old=$(readlink current || true)
rollback() {
  if [ -n "$old" ]; then docker compose -p ${extensionProject(c, name)} -f "$old/compose.json" up -d --wait --wait-timeout 150 >/dev/null 2>&1 || true; fi
}
trap 'rollback' ERR
docker compose -p ${extensionProject(c, name)} -f ${quote(release + "/compose.json")} up -d --wait --wait-timeout 150 >/dev/null
${name === "postgres" ? `docker exec ${extensionProject(c, name)} sh -ec 'export PGPASSWORD=$(cat /run/secrets/postgres-password); psql -h 127.0.0.1 -U ${c.extensions.postgres!.username} -d ${c.extensions.postgres!.database} -v ON_ERROR_STOP=1 -Atc "SELECT 1"' >/dev/null` : ""}
${name === "redis" ? `docker exec ${extensionProject(c, name)} sh -ec 'export REDISCLI_AUTH=$(cat /run/secrets/redis-password); redis-cli ping | grep -qx PONG'` : ""}
rm -f current.next
ln -s ${quote(release)} current.next
mv -Tf current.next current
trap - ERR
${name === "postgres" ? backupInstallScript(c) : ""}
`,
  );
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
    ? `systemctl disable --now two-${c.name}-postgres-backup.timer 2>/dev/null || true
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
