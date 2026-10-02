import { expect,test } from "bun:test";
import { mkdir,mkdtemp,rm,stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseResource } from "../src/cli/resources";
import { configSchema } from "../src/modules/config/application/config";
import { backupDestination,backupFiles,backupSchedule,backupScript,storageRemote } from "../src/modules/extensions/infrastructure/templates/postgres/backups";
import { provisionBackupStorage } from "../src/modules/server/application/backup-storage";
import { gcsBackupStorage } from "../src/modules/server/domain/storage";
import { provision,provisionOperations,provisionRoot } from "../src/modules/server/infrastructure/provision";

const base = {
  version: 1, name: "reader",
  ssh: { kind: "gcp", project: "example-project", zone: "europe-west1-b", instance: "legacy-vm" },
  edge: { mode: "existing" },
  backupStorage: { kind: "gcs" },
  extensions: { postgres: { passwordEnv: "POSTGRES_PASSWORD", backup: { engine: "dump" } } },
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
      provision: async (provider: string, file: string, apply: boolean, _destroy = false, options: Parameters<typeof provision>[4] = {}) => {
        expect(options.prepareInput).toBeDefined();
        await options.prepareInput!();
        applies++;
        expect(provider).toBe("gcs-backup");
        expect(apply).toBe(false);
        expect((await stat(file)).mode & 0o777).toBe(0o600);
        expect(await Bun.file(file).json()).toEqual({
          project: "example-project", region: "europe-west1", server_name: "reader",
          storage_class: "STANDARD", retention_days: 7, pgbackrest_enabled: false, service_account: "reader@example-project.iam.gserviceaccount.com",
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

test("backup-storage dry runs cannot overwrite an active apply's input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "backup-storage-lock-"));
  const root = join(dir, "root"), state = join(dir, "terraform-state");
  const c = configSchema.parse(base);
  const dryRun = configSchema.parse({...base, backupStorage: {kind: "gcs", retentionDays: 90}});
  const ready = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const originalRun = provisionOperations.run;
  let pending: Promise<void> | undefined;
  let pauseInit = true;
  const observed: number[] = [];
  const commands: string[] = [];
  const ops = {
    run: async () => JSON.stringify({
      name: "legacy-vm", zone: "projects/example-project/zones/europe-west1-b",
      serviceAccounts: [{email: "reader@example-project.iam.gserviceaccount.com", scopes: ["https://www.googleapis.com/auth/cloud-platform"]}],
    }),
    provision: async (_provider: string, file: string, apply: boolean, destroy = false, options: Parameters<typeof provision>[4] = {}) => {
      await provisionRoot(root, file, state, apply, destroy, options.prepareInput);
    },
  };
  try {
    await mkdir(root);
    provisionOperations.run = async args => {
      commands.push(args[2]);
      if (args[2] === "init" && pauseInit) {
        pauseInit = false;
        ready.resolve();
        await resume.promise;
      }
      if (args[2] === "plan") {
        const file = args.find(arg => arg.startsWith("-var-file="))!.slice("-var-file=".length);
        observed.push((await Bun.file(file).json()).retention_days);
      }
      return "";
    };
    pending = provisionBackupStorage(c, true, dir, ops);
    void pending.catch(ready.reject);
    await ready.promise;
    await expect(provisionBackupStorage(dryRun, false, dir, ops)).rejects.toThrow("Another Terraform operation holds");
    expect((await Bun.file(join(dir, "backup-storage/gcp.tfvars.json")).json()).retention_days).toBe(7);
    expect((await stat(join(state, "operation.lock"))).isDirectory()).toBe(true);
    resume.resolve();
    await pending;
    await expect(stat(join(state, "operation.lock"))).rejects.toMatchObject({code: "ENOENT"});
    await provisionBackupStorage(dryRun, false, dir, ops);
    expect(observed).toEqual([7, 90]);
    expect(commands).toEqual(["init", "plan", "apply", "init", "plan"]);
  } finally {
    resume.resolve();
    await pending?.catch(() => {});
    provisionOperations.run = originalRun;
    await rm(dir, {recursive: true, force: true});
  }
});
