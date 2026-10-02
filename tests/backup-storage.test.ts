import { test, expect } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema } from "../src/config";
import { gcsBackupStorage } from "../src/storage-config";
import { backupDestination, backupScript, storageRemote, backupFiles, backupSchedule } from "../src/backups";
import { provisionBackupStorage } from "../src/backup-storage";
import { parseResource } from "../src/resources";

const base = {
  version: 1, name: "reader",
  ssh: { kind: "gcp", project: "example-project", zone: "europe-west1-b", instance: "legacy-vm" },
  edge: { mode: "existing" },
  backupStorage: { kind: "gcs" },
  extensions: { postgres: { passwordEnv: "POSTGRES_PASSWORD", backup: {} } },
};
test("Standard bucket and backup destination derive from server identity and VM region", () => {
  const c = configSchema.parse(base);
  expect(gcsBackupStorage(c)).toEqual({
    project: "example-project", region: "europe-west1", serverName: "reader",
    bucket: "example-project-europe-west1-reader-2server-backup", storageClass: "STANDARD", retentionDays: 7, schedule: "*-*-* 00/12:00:00 UTC",
    destination: "gs://example-project-europe-west1-reader-2server-backup/postgres",
  });
  expect(backupDestination(c)).toBe(gcsBackupStorage(c).destination);
  expect(backupFiles(c)["backup.timer"]).toContain("OnCalendar=*-*-* 00/12:00:00 UTC");
  c.backupStorage!.schedule = "*-*-* 00:00:00 UTC";
  expect(backupSchedule(c)).toBe("*-*-* 00:00:00 UTC");
  c.extensions.postgres!.backup!.schedule = "daily";
  expect(backupSchedule(c)).toBe("daily");
  expect(backupScript(c)).toContain(gcsBackupStorage(c).destination);
  expect(storageRemote(c)).toContain("bucket_policy_only=true:example-project-europe-west1-reader-2server-backup/postgres");
  expect(parseResource(["get", "backup-storage", "-f", "server.json"])?.resource).toBe("backup-storage");
  c.extensions.postgres!.backup!.destination = "s3://existing-bucket/postgres";
  c.extensions.postgres!.backup!.region = "eu-west-1";
  expect(storageRemote(c)).toContain("region=eu-west-1:existing-bucket/postgres");
});
test("ambiguous provider, invalid zone, long bucket and missing destination fail before provisioning", () => {
  for (const input of [
    { ...base, ssh: { kind: "ssh", host: "example.com", user: "deploy" } },
    { ...base, ssh: { ...base.ssh, zone: "ambiguous" } },
    { ...base, name: "a".repeat(48) },
    { ...base, backupStorage: undefined },
    { ...base, backupStorage: { kind: "gcs", retentionDays: 0 } },
    { ...base, backupStorage: { kind: "gcs", retentionDays: 1.5 } },
    { ...base, backupStorage: { kind: "gcs", schedule: "daily\nExecStart=evil" } },
  ]) expect(() => configSchema.parse(input)).toThrow();
});
test("storage provisioning uses actual VM identity and separate private Terraform input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "backup-storage-"));
  const c = configSchema.parse(base);
  const vm = {
    name: "legacy-vm", zone: "projects/example-project/zones/europe-west1-b",
    serviceAccounts: [{ email: "reader@example-project.iam.gserviceaccount.com", scopes: ["https://www.googleapis.com/auth/cloud-platform"] }],
  };
  let applies = 0;
  try {
    const ops = {
      run: async (args: string[]) => {
        expect(args).toContain("--zone=europe-west1-b");
        expect(args).toContain("--project=example-project");
        return JSON.stringify(vm);
      },
      provision: async (provider: string, file: string, apply: boolean) => {
        applies++;
        expect(provider).toBe("gcs-backup");
        expect(apply).toBe(false);
        expect((await stat(file)).mode & 0o777).toBe(0o600);
        expect(await Bun.file(file).json()).toEqual({
          project: "example-project", region: "europe-west1", server_name: "reader",
          storage_class: "STANDARD", retention_days: 7, service_account: "reader@example-project.iam.gserviceaccount.com",
        });
      },
    };
    await provisionBackupStorage(c, false, dir, ops);
    vm.serviceAccounts[0].scopes = ["https://www.googleapis.com/auth/devstorage.read_only"];
    await expect(provisionBackupStorage(c, true, dir, ops)).rejects.toThrow("read/write");
    vm.name = "wrong-vm";
    await expect(provisionBackupStorage(c, true, dir, ops)).rejects.toThrow("identity");
    expect(applies).toBe(1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
