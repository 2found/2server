// One server identity drives both the bucket and the backup destination.
export const defaultBackupSchedule = "*-*-* 00/6:00:00 UTC";
export function gcsBackupStorage(c: {
  name: string;
  ssh: { kind: string; project?: string; zone?: string };
  backupStorage?: { kind: "gcs"; storageClass: string; retentionDays: number; schedule: string };
}) {
  if (!c.backupStorage || c.ssh.kind !== "gcp" || !c.ssh.project)
    throw new Error("GCS backupStorage requires a GCP SSH configuration");
  const region = /^([a-z]+-[a-z]+[0-9]+)-[a-z]$/.exec(c.ssh.zone ?? "")?.[1];
  if (!region) throw new Error("Cannot derive backup region from the VM zone");
  const bucket = `${c.ssh.project}-${region}-${c.name}-2server-backup`;
  if (bucket.length > 63 || !/^[a-z0-9][a-z0-9-]+[a-z0-9]$/.test(bucket))
    throw new Error("Derived backup bucket must fit GCS's 63-character naming limit");
  return {
    project: c.ssh.project,
    region,
    serverName: c.name,
    bucket,
    storageClass: c.backupStorage.storageClass,
    retentionDays: c.backupStorage.retentionDays,
    schedule: c.backupStorage.schedule,
    destination: `gs://${bucket}/postgres`,
  };
}
