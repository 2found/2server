import { test, expect } from "bun:test";
import { configSchema } from "../src/config";
import { statefulFiles, statefulPreflightScript } from "../src/stateful";
import { postgresExtension } from "../src/extensions";
import { backupDestination, backupScript, backupFiles, restoreScript } from "../src/extensions/postgres/backups";
import { pgbackrestConfig, physicalRestoreScript, removeRecoveryScript } from "../src/extensions/postgres/pgbackrest";
import { postgresHealthFiles, postgresAlertRules } from "../src/extensions/postgres/health";
import { parseResource } from "../src/resources";
const base = {
  version: 1, name: "fixture", edge: { mode: "managed" },
  ssh: { kind: "gcp", project: "example-project", zone: "europe-west1-b", instance: "vm" },
  backupStorage: { kind: "gcs" },
  extensions: { postgres: { passwordEnv: "TEST_HARDEN_APP", adminPasswordEnv: "TEST_HARDEN_ADMIN", migrationPasswordEnv: "TEST_HARDEN_MIGRATE", backup: {} } },
};
test("fresh PostgreSQL separates app/migration/admin; unrecognized data refuses implicit privilege changes", async () => {
  const c = configSchema.parse(base);
  for (const k of ["APP", "ADMIN", "MIGRATE"]) process.env[`TEST_HARDEN_${k}`] = `fixture-only-${k}-strong-password`;
  try {
    const files = await statefulFiles(c, postgresExtension), service = JSON.parse(files["compose.json"]).services["two-fixture-postgres"];
    expect(service.environment.POSTGRES_USER).toBe("two_admin");
    expect(files["init.sh"]).toContain("NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION");
    expect(files["init.sh"]).toContain("SET role TO 'two_owner'");
    expect(files["init.sh"]).toContain("\\gexec");
    expect(files["Dockerfile"]).toContain("pgbackrest=2.59.2-1.pgdg12+1");
    expect(files[".dockerignore"]).toBe("**\n!Dockerfile\n");
    expect(service.ports).toBeUndefined();
    expect(statefulPreflightScript(c,postgresExtension)).toContain("Unrecognized PostgreSQL role layout");
    expect(files["compose.json"]).not.toContain(process.env.TEST_HARDEN_ADMIN!);
    process.env.TEST_HARDEN_ADMIN = process.env.TEST_HARDEN_APP;
    await expect(statefulFiles(c, postgresExtension)).rejects.toThrow("must differ");
  } finally { for (const k of ["APP", "ADMIN", "MIGRATE"]) delete process.env[`TEST_HARDEN_${k}`]; }
});
test("PITR repository keeps WAL chains and defaults to full/differential backups with isolated drills", async () => {
  const c = configSchema.parse(base);
  expect(c.extensions.postgres!.backup!.engine).toBe("pgbackrest");
  expect(backupDestination(c)).toBe("gs://example-project-europe-west1-fixture-2server-backup/pgbackrest/fixture");
  const conf = pgbackrestConfig(c);
  expect(conf).toContain("repo1-retention-full-type=time\nrepo1-retention-full=7");
  expect(conf).toContain("repo1-gcs-key-type=auto");
  expect(conf).not.toContain("repo1-retention-archive=");
  expect(backupScript(c)).toContain('kind=diff');
  expect(backupScript(c)).toContain('kind=full');
  expect(backupFiles(c)["restore-check.timer"]).toContain("Sun *-*-* 03:00:00 UTC");
  const script = physicalRestoreScript(c,{name:"verify",targetTime:"2026-10-02T00:00:00Z"});
  expect(script).toContain("--type=time");
  expect(script).toContain("target already exists");
  expect(script).toContain("listen_addresses=");
  expect(script).toContain("default_transaction_read_only=on");
  expect(script).not.toContain(c.extensions.postgres!.dataPath+":");
  expect(removeRecoveryScript(c,"verify")).toContain('io.2server.recovery');
  for (const name of ["", "../postgres", "foo;exit", "a".repeat(33)]) expect(() => physicalRestoreScript(c,{name})).toThrow();
  expect(() => physicalRestoreScript(c,{name:"verify",targetTime:"now;shutdown"})).toThrow();
  expect(() => physicalRestoreScript(c,{name:"verify",id:"../backup"})).toThrow();
  expect(parseResource(["restore","postgres","-f","server.json","--recovery","check","--target-time","2026-10-02T00:00:00Z"])?.options.recovery).toBe("check");
  const legacy = restoreScript(c,"20261002T000000Z-12345678-1234-1234-1234-123456789abc","old_dump");
  expect(legacy).toContain("-backup/postgres/");
  expect(legacy).not.toContain("-backup/pgbackrest/");
});
test("monitoring distinguishes failed/stale collection, DB down, overdue backup/drill and WAL failure", async () => {
  const c = configSchema.parse(base), files = postgresHealthFiles(c);
  expect(files["metrics.sh"]).toContain("two_postgres_up 0");
  expect(files["metrics.sh"]).toContain("statement_timeout=3000");
  expect(files["metrics.sh"]).toContain("mv -f");
  for (const alert of ["PostgreSQLDown","PostgreSQLMetricsStale","PostgreSQLBackupOverdue","PostgreSQLRestoreCheckOverdue","PostgreSQLWALArchiveFailure","PostgreSQLConnectionsHigh"])
    expect(postgresAlertRules).toContain(alert);
  for (const postgres of [
    {...base.extensions.postgres, username:"two_admin"},
    {...base.extensions.postgres, adminPasswordEnv:"TEST_HARDEN_APP"},
    {...base.extensions.postgres, image:"postgres:18-alpine"},
    {...base.extensions.postgres, backup:{maxAgeHours:0}},
  ]) expect(() => configSchema.parse({...base,extensions:{postgres}})).toThrow();
});
