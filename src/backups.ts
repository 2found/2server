import type { Config } from "./config";
import { quote, remote } from "./process";
const root = "/opt/2server/extensions/postgres";
const rcloneImage = "rclone/rclone:1.71.0";
export function storageRemote(c: Config) {
  const b = c.extensions.postgres?.backup;
  if (!b)
    throw new Error("Configure extensions.postgres.backup.destination first");
  if (b.destination.startsWith("gs://"))
    return `:gcs,env_auth=true,no_check_bucket=true,bucket_policy_only=true:${b.destination.slice(5)}`;
  if (!b.region) throw new Error("S3 backup requires a region");
  return `:s3,provider=AWS,env_auth=true,no_check_bucket=true,region=${b.region}:${b.destination.slice(5)}`;
}
function transfer() {
  // Host network is needed for the VM identity endpoint (including EC2 IMDSv2).
  // Never mount the Docker socket or pass provider credentials.
  return `storage() { docker run --rm --network host --cap-drop ALL --security-opt no-new-privileges:true --memory 256m --cpus 0.5 -v "$tmp:/work" ${rcloneImage} --config /dev/null --retries 3 --low-level-retries 3 "$@"; }`;
}
export function backupScript(c: Config) {
  const p = c.extensions.postgres;
  if (!p?.backup) throw new Error("PostgreSQL backup is not configured");
  const dest = storageRemote(c);
  return `#!/bin/bash
set -euo pipefail
umask 077
exec 6>/var/lock/2server-postgres-backup.lock
flock -w 120 6
mkdir -p /opt/2server/backups
tmp=$(mktemp -d /opt/2server/backups/.backup.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
${transfer()}
id=$(date -u +%Y%m%dT%H%M%SZ)-$(cat /proc/sys/kernel/random/uuid)
docker exec two-${c.name}-postgres pg_dump -U ${p.username} -d ${p.database} -Fc --no-owner --no-acl > "$tmp/$id.dump"
test -s "$tmp/$id.dump"
docker exec -i two-${c.name}-postgres pg_restore --list < "$tmp/$id.dump" >/dev/null
(cd "$tmp"; sha256sum "$id.dump" > "$id.sha256")
storage copyto "/work/$id.dump" ${quote(dest + "/")}"$id.dump" >/dev/null
# Upload checksum last: a backup is complete only when this object exists.
storage copyto "/work/$id.sha256" ${quote(dest + "/")}"$id.sha256" >/dev/null
printf '%s\\n' "$id" > /opt/2server/backups/postgres-last-success
printf '%s/%s.dump\\n' ${quote(p.backup.destination)} "$id"
`;
}
export function backupFiles(c: Config): Record<string, string> {
  const b = c.extensions.postgres?.backup;
  if (!b) return {};
  storageRemote(c); // Reject missing region during render, before remote mutation.
  const unit = `two-${c.name}-postgres-backup`;
  return {
    "backup.sh": backupScript(c),
    "backup.service": `[Unit]\nDescription=2server PostgreSQL backup (${c.name})\nAfter=docker.service network-online.target\n[Service]\nType=oneshot\nUMask=0077\nExecStart=/bin/bash ${root}/current/backup.sh\nTimeoutStartSec=6h\n`,
    "backup.timer": `[Unit]\nDescription=2server PostgreSQL backup schedule\n[Timer]\nOnCalendar=${b.schedule}\nPersistent=true\nRandomizedDelaySec=300\nUnit=${unit}.service\n[Install]\nWantedBy=timers.target\n`,
  };
}
export function backupInstallScript(c: Config) {
  const unit = `two-${c.name}-postgres-backup`;
  if (!c.extensions.postgres?.backup)
    return `systemctl disable --now ${unit}.timer 2>/dev/null || true`;
  return `systemd-analyze calendar ${quote(c.extensions.postgres.backup.schedule)} >/dev/null
install -m 644 ${root}/current/backup.service /etc/systemd/system/${unit}.service
install -m 644 ${root}/current/backup.timer /etc/systemd/system/${unit}.timer
systemctl daemon-reload
# Verify a real backup before enabling its schedule.
systemctl start ${unit}.service
systemctl enable --now ${unit}.timer`;
}
export function restoreScript(c: Config, id: string, database: string) {
  const p = c.extensions.postgres;
  if (!p) throw new Error("PostgreSQL is not configured");
  if (!/^[0-9]{8}T[0-9]{6}Z-[a-f0-9-]{36}$/.test(id))
    throw new Error(
      "Use a backup ID printed by backup postgres (without .dump)",
    );
  if (
    !/^[a-z][a-z0-9_]{0,62}$/.test(database) ||
    [p.database, "postgres", "template0", "template1"].includes(database)
  )
    throw new Error(
      "Restore requires --database with a new, non-system database name",
    );
  const dest = storageRemote(c);
  return `set -euo pipefail
umask 077
exec 7>/var/lock/2server-extension-postgres.lock
flock -w 120 7
exec 6>/var/lock/2server-postgres-backup.lock
flock -w 120 6
test "$(cat /opt/2server/edge/owner)" = ${quote(c.name)}
test "$(docker inspect -f '{{index .Config.Labels "io.2server.owner"}}' two-${c.name}-postgres)" = ${quote(c.name)}
mkdir -p /opt/2server/backups
tmp=$(mktemp -d /opt/2server/backups/.restore.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
${transfer()}
storage copyto ${quote(dest + "/" + id + ".dump")} /work/backup.dump >/dev/null
storage copyto ${quote(dest + "/" + id + ".sha256")} /work/checksum >/dev/null
# Do not trust paths embedded in the checksum object.
expected=$(cut -d ' ' -f 1 "$tmp/checksum")
[[ "$expected" =~ ^[a-f0-9]{64}$ ]]
printf '%s  backup.dump\\n' "$expected" > "$tmp/verified.sha256"
(cd "$tmp"; sha256sum -c verified.sha256 >/dev/null)
docker exec -i two-${c.name}-postgres pg_restore --list < "$tmp/backup.dump" >/dev/null
# createdb fails if the target exists. Never clean, drop, or overwrite a live DB.
docker exec two-${c.name}-postgres createdb -U ${p.username} -T template0 --owner=${p.username} ${database}
docker exec -i two-${c.name}-postgres pg_restore -U ${p.username} --dbname=${database} --single-transaction --exit-on-error --no-owner --no-acl < "$tmp/backup.dump"
docker exec two-${c.name}-postgres psql -U ${p.username} -d ${database} -v ON_ERROR_STOP=1 -Atc 'SELECT 1' >/dev/null
printf 'Restored into ${database}; switch the application only after verification.\\n'
`;
}
export async function runBackup(c: Config) {
  // Use the active deployed configuration, not an unpublished local schedule.
  storageRemote(c);
  return remote(
    c,
    `test "$(cat /opt/2server/edge/owner)" = ${quote(c.name)}\nbash ${root}/current/backup.sh`,
  );
}
