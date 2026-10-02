import { quote,remote } from "../../../../../shared/infrastructure/process";
import type { Config } from "../../../../config/application/config";
import { provisionBackupStorage } from "../../../../server/application/backup-storage";
import { extensionProject,extensionRoot,requiredSecret } from "../../../application/stateful";
import { instanceName } from '../../../domain/instance';
import type { ExtensionHooks } from "../../../domain/types";
import { backupFiles,backupInstallScript } from "./backups";
import { postgresHealthFiles,postgresHealthInstall } from "./health";
import { postgresEntrypoint,postgresInit } from "./init";
import { pgbackrestConfig,postgresDockerfile,postgresImage } from "./pgbackrest";

export const postgresHooks = {
  validate(c, ctx) {
    const postgres = c.extensions.postgres;
    if (!postgres) return;
    if (["two_admin", "two_migrator", "two_owner", "postgres"].includes(postgres.username))
      ctx.addIssue({ code: "custom", message: "PostgreSQL application username is reserved" });
    if (new Set([postgres.passwordEnv, postgres.adminPasswordEnv, postgres.migrationPasswordEnv]).size !== 3)
      ctx.addIssue({ code: "custom", message: "PostgreSQL app, admin and migration secrets must be distinct" });
    if (postgres.backup?.engine === "pgbackrest" && !postgres.image.includes("-bookworm"))
      ctx.addIssue({ code: "custom", message: "pgBackRest requires the PostgreSQL 18 bookworm image" });
    if (postgres.backup && !postgres.backup.destination && !c.backupStorage)
      ctx.addIssue({ code: "custom", message: "PostgreSQL backup requires destination or server backupStorage" });
    if (postgres.disk) {
      const d = c.disks.find((d) => d.name === postgres.disk);
      if (!d || !postgres.dataPath.startsWith(d.mountPath + "/"))
        ctx.addIssue({
          code: "custom",
          message: "PostgreSQL dataPath must be below its declared disk mountPath",
        });
    }
  },
  stateful: {
    files(c, files, service) {
      const p = c.extensions.postgres!;
      files["app-password"] = requiredSecret(p.passwordEnv,c);
      files["admin-password"] = requiredSecret(p.adminPasswordEnv,c);
      files["migration-password"] = requiredSecret(p.migrationPasswordEnv,c);
      if (new Set([files["app-password"], files["admin-password"], files["migration-password"]]).size !== 3)
        throw new Error("PostgreSQL app, admin and migration passwords must differ");
      files["init.sh"] = postgresInit(c);
      files["entrypoint.sh"] = postgresEntrypoint;
      if (p.backup?.engine === "pgbackrest") {
        files["Dockerfile"] = postgresDockerfile(c);
        files[".dockerignore"] = "**\n!Dockerfile\n";
        files["pgbackrest.conf"] = pgbackrestConfig(c);
        service.image = postgresImage(c);
        service.build = { context: ".", dockerfile: "Dockerfile" };
        (service.volumes as string[]).push("../../../../../extensions/postgres/pgbackrest.conf:/etc/pgbackrest/pgbackrest.conf:ro");
        service.command = ["postgres", "-c", "archive_mode=on", "-c", "archive_timeout=300",
          "-c", "archive_command=pgbackrest --stanza=main archive-push %p"];
      }
      (service.healthcheck as Record<string, unknown>).test = ["CMD-SHELL", `export PGPASSWORD=$(cat /run/2server/app-password); psql -X -h 127.0.0.1 -U ${p.username} -d ${p.database} -Atc 'SELECT 1' >/dev/null`];
      Object.assign(files, backupFiles(c));
      Object.assign(files, postgresHealthFiles(c));
    },
    preflight(c) {
      const p = c.extensions.postgres!;
      const disk = p.disk ? c.disks.find((d) => d.name === p.disk) : undefined;
      return `${
        disk
          ? `mountpoint -q ${quote(disk.mountPath)}
test "$(readlink -f ${quote(disk.device)})" = "$(readlink -f "$(findmnt -n -o SOURCE --target ${quote(disk.mountPath)})")"`
          : ""
      }
if [ -f ${extensionRoot("postgres",c)}/current/extension.json ]; then
  test "$(jq -r .username ${extensionRoot("postgres",c)}/current/extension.json)" = ${quote(p.username)}
  test "$(jq -r .database ${extensionRoot("postgres",c)}/current/extension.json)" = ${quote(p.database)}
fi
# Never silently initialize another cluster inside a legacy major-version directory.
if [ -d ${quote(p.dataPath)} ]; then
  for v in $(find ${quote(p.dataPath)} -maxdepth 3 -name PG_VERSION); do
    test "$(cat "$v")" = 18
    test -f "$(dirname "$v")/.2server-roles-v1" || { echo 'Unrecognized PostgreSQL role layout; refusing to modify existing data' >&2; exit 1; }
  done
fi`;
    },
    prepareHost: postgresDataPreparation,
    prepareRelease: (c, release) =>
      c.extensions.postgres?.backup?.engine === "pgbackrest"
        ? `chmod 644 ${quote(release + "/pgbackrest.conf")}`
        : "",
    async beforeUpload(c) {
      if (c.extensions.postgres?.backup && !c.extensions.postgres.backup.destination)
        await provisionBackupStorage(c, true);
    },
    verify: (c) =>
      `docker exec ${extensionProject(c, "postgres")} sh -ec 'export PGPASSWORD=$(cat /run/2server/app-password); psql -h 127.0.0.1 -U ${c.extensions.postgres!.username} -d ${c.extensions.postgres!.database} -v ON_ERROR_STOP=1 -Atc "SELECT 1"' >/dev/null`,
    postInstall: (c) => postgresHealthInstall(c) + "\n" + backupInstallScript(c),
    async afterDeploy(c) {
      // Separate SSH invocation: the restore drill takes the same deployment lock.
      if (c.extensions.postgres?.backup?.engine === "pgbackrest")
        await remote(c, `systemctl start ${extensionProject(c,"postgres")}-restore-check.service`);
    },
    teardown: (c) =>
      `systemctl disable --now ${extensionProject(c,"postgres")}-metrics.timer ${extensionProject(c,"postgres")}-restore-check.timer 2>/dev/null || true
systemctl stop ${extensionProject(c,"postgres")}-metrics.service ${extensionProject(c,"postgres")}-restore-check.service 2>/dev/null || true
rm -f /opt/2server/metrics/${instanceName(c,"postgres")}.prom
systemctl disable --now ${extensionProject(c,"postgres")}-backup.timer 2>/dev/null || true
systemctl stop ${extensionProject(c,"postgres")}-backup.service 2>/dev/null || true`,
  },
} satisfies ExtensionHooks;

// PG18's entrypoint fixes PGDATA, but does not chown the parent mount before
// switching to postgres. A root-owned 0700 bind mount therefore cannot start.
// Resolve postgres through the actual image (Debian/alpine IDs differ).
export function postgresDataPreparation(c: Config) {
  const p = c.extensions.postgres!;
  return `docker image inspect ${quote(p.image)} >/dev/null 2>&1 || docker pull ${quote(p.image)} >/dev/null
  docker run --rm --network none --user 0:0 --security-opt no-new-privileges:true \
    --entrypoint sh -v ${quote(p.dataPath + ":/var/lib/postgresql")} ${quote(p.image)} \
    -ec 'chown postgres:postgres /var/lib/postgresql; chmod 700 /var/lib/postgresql'`;
}
