import type { Config } from "../../config";
import { gcsBackupStorage, defaultBackupSchedule } from "../../storage-config";

export function backupDestination(c: Config) {
  const b = c.extensions.postgres?.backup;
  if (!b) throw new Error("PostgreSQL backup is not configured");
  if (b.destination) return b.destination;
  const s = gcsBackupStorage(c);
  return b.engine === "pgbackrest"
    ? `gs://${s.bucket}/pgbackrest/${c.name}${c.instance?`/${c.instance.name}`:""}` : s.destination + (c.instance?`/${c.instance.name}`:"");
}
export function backupSchedule(c: Config) {
  return c.extensions.postgres?.backup?.schedule ?? c.backupStorage?.schedule ?? defaultBackupSchedule;
}
export function backupRetention(c: Config) {
  return c.extensions.postgres?.backup?.retentionDays ?? c.backupStorage?.retentionDays ?? 7;
}
