import { chmod,mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "../../../shared/infrastructure/process";
import { backupObjectAdminRequired } from "../../extensions/application/contributions";
import type { Config } from "../../config/application/config";
import { gcsBackupStorage } from "../domain/storage";
import { provision } from "../infrastructure/provision";

export const backupStorageOperations = { run, provision };
export async function provisionBackupStorage(
  c: Config,
  apply: boolean,
  state = join(homedir(), ".local", "state", "2server", c.name),
  ops = backupStorageOperations,
) {
  const storage = gcsBackupStorage(c);
  if (c.ssh.kind !== "gcp") throw new Error("GCP SSH is required");
  const vm = JSON.parse(await ops.run([
    "gcloud", "compute", "instances", "describe", c.ssh.instance,
    `--project=${storage.project}`, `--zone=${c.ssh.zone}`, "--format=json",
  ]));
  if (vm.name !== c.ssh.instance || !vm.zone?.endsWith(`/zones/${c.ssh.zone}`))
    throw new Error("Provider VM identity does not match the manifest");
  const accounts = vm.serviceAccounts ?? [];
  if (accounts.length !== 1 || !/^[a-zA-Z0-9@._-]+\.gserviceaccount\.com$/.test(accounts[0]?.email ?? ""))
    throw new Error("VM must have one attached service account for backup storage");
  if (!accounts[0].scopes?.includes("https://www.googleapis.com/auth/cloud-platform") &&
      !accounts[0].scopes?.includes("https://www.googleapis.com/auth/devstorage.read_write") &&
      !accounts[0].scopes?.includes("https://www.googleapis.com/auth/devstorage.full_control"))
    throw new Error("VM access scope must allow Cloud Storage read/write before backup setup");
  const dir = join(state, "backup-storage");
  const file = join(dir, "gcp.tfvars.json");
  const input = JSON.stringify({
    project: storage.project,
    region: storage.region,
    server_name: storage.serverName,
    storage_class: storage.storageClass,
    retention_days: storage.retentionDays,
    // Frozen Terraform input name; permission intent comes from capabilities.
    pgbackrest_enabled: backupObjectAdminRequired(c),
    service_account: accounts[0].email,
  }, null, 2);
  // A separate root/state provisions storage for an adopted VM without adopting
  // or mutating that VM, its network, disks, or project-wide IAM.
  await ops.provision("gcs-backup", file, apply, false, {prepareInput: async () => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    await Bun.write(file, input);
    await chmod(file, 0o600);
  }});
}
