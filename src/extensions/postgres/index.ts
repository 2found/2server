import { z } from "zod";
import { backupCalendar, databaseName, envKey, image, name, path } from "../../schema";
import type { Config } from "../../config";
import { remote, quote } from "../../process";
import { provisionBackupStorage } from "../../backup-storage";
import { extensionProject, extensionRoot, requiredSecret } from "../../stateful";
import { postgresInit, postgresEntrypoint } from "./init";
import { postgresDockerfile, postgresImage, pgbackrestConfig } from "./pgbackrest";
import { postgresHealthFiles, postgresHealthInstall } from "./health";
import { backupFiles, backupInstallScript } from "./backups";
import type { Extension } from "../types";

export const postgresSchema = z
  .object({
    image: image
      .refine(
        (v) =>
          /^postgres:18(?:\.[0-9]+)?(?:-[a-z0-9.-]+)?(?:@sha256:[a-f0-9]{64})?$/.test(
            v,
          ),
        "PostgreSQL images must pin major 18; major upgrades need an explicit migration",
      )
      .default("postgres:18.6-bookworm"),
    database: databaseName.default("app"),
    username: databaseName.default("app"),
    passwordEnv: envKey,
    adminPasswordEnv: envKey.default("POSTGRES_ADMIN_PASSWORD"),
    migrationPasswordEnv: envKey.default("POSTGRES_MIGRATION_PASSWORD"),
    memoryMb: z.number().int().min(256).max(131072).default(512),
    cpus: z.number().positive().max(128).default(1),
    dataPath: path.default("/opt/2server/data/postgres"),
    disk: name.optional(),
    backup: z
      .object({
        engine: z.enum(["pgbackrest", "dump"]).default("pgbackrest"),
        fullIntervalHours: z.number().int().min(1).max(168).default(24),
        retentionDays: z.number().int().min(1).max(36500).optional(),
        restoreCheckSchedule: backupCalendar.default("Sun *-*-* 03:00:00 UTC"),
        maxAgeHours: z.number().int().min(1).max(8760).default(26),
        restoreCheckMaxAgeHours: z.number().int().min(1).max(8760).default(192),
        destination: z
          .string()
          .regex(
            /^(gs|s3):\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\/[a-zA-Z0-9_/-]+$/,
          )
          .refine((v) => !v.includes("..") && !v.endsWith("/"))
          .optional(),
        // systemd calendar: single-line and no unit-file specifier expansion.
        schedule: backupCalendar.optional(),
        region: z
          .string()
          .regex(/^[a-z]+-[a-z]+-[0-9]+$/)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const postgresExtension = {
  name: "postgres",
  schema: postgresSchema.optional(),
  template: {
    passwordEnv: "POSTGRES_PASSWORD",
    adminPasswordEnv: "POSTGRES_ADMIN_PASSWORD",
    migrationPasswordEnv: "POSTGRES_MIGRATION_PASSWORD",
  },
  immutable: ["dataPath", "disk", "database", "username"],
  scoped: (c) => ({ postgres: c.extensions.postgres }),
  dataPaths: (c) => (c.extensions.postgres ? [c.extensions.postgres.dataPath] : []),
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
if [ -f ${extensionRoot("postgres")}/current/extension.json ]; then
  test "$(jq -r .username ${extensionRoot("postgres")}/current/extension.json)" = ${quote(p.username)}
  test "$(jq -r .database ${extensionRoot("postgres")}/current/extension.json)" = ${quote(p.database)}
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
        await remote(c, `systemctl start two-${c.name}-postgres-restore-check.service`);
    },
    teardown: (c) =>
      `systemctl disable --now two-${c.name}-postgres-metrics.timer two-${c.name}-postgres-restore-check.timer 2>/dev/null || true
systemctl stop two-${c.name}-postgres-metrics.service two-${c.name}-postgres-restore-check.service 2>/dev/null || true
rm -f /opt/2server/metrics/postgres.prom
systemctl disable --now two-${c.name}-postgres-backup.timer 2>/dev/null || true
systemctl stop two-${c.name}-postgres-backup.service 2>/dev/null || true`,
  },
} satisfies Extension;

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
