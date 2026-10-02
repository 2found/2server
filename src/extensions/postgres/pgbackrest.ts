import { createHash } from "node:crypto";
import type { Config } from "../../config";
import { quote } from "../../process";
import { backupDestination, backupRetention } from "./backup-policy";

const root = "/opt/2server/extensions/postgres";
export const pgbackrestVersion = "2.59.2-1.pgdg12+1";
export function postgresDockerfile(c: Config) {
  return `FROM ${c.extensions.postgres!.image}
RUN apt-get update && apt-get install -y --no-install-recommends pgbackrest=${pgbackrestVersion} ca-certificates && rm -rf /var/lib/apt/lists/*
`;
}
export function postgresImage(c: Config) {
  return c.extensions.postgres?.backup?.engine === "pgbackrest"
    ? `2server/postgres:${createHash("sha256").update(postgresDockerfile(c)).digest("hex").slice(0, 16)}`
    : c.extensions.postgres!.image;
}
export function pgbackrestConfig(c: Config) {
  const url = new URL(backupDestination(c));
  if (url.protocol === "s3:" && !c.extensions.postgres!.backup!.region)
    throw new Error("S3 pgBackRest requires a region");
  const cloud = url.protocol === "gs:"
    ? `repo1-type=gcs\nrepo1-gcs-bucket=${url.hostname}\nrepo1-gcs-key-type=auto`
    : `repo1-type=s3\nrepo1-s3-bucket=${url.hostname}\nrepo1-s3-region=${c.extensions.postgres!.backup!.region}\nrepo1-s3-endpoint=s3.${c.extensions.postgres!.backup!.region}.amazonaws.com\nrepo1-s3-key-type=auto`;
  return `[global]
${cloud}
repo1-path=${url.pathname}
repo1-retention-full-type=time
repo1-retention-full=${backupRetention(c)}
process-max=1
compress-type=zst
start-fast=y
log-level-console=warn
log-level-file=off
archive-timeout=120

[main]
pg1-path=/var/lib/postgresql/18/docker
pg1-user=two_admin
pg1-socket-path=/var/run/postgresql
`;
}
export function pgbackrestBackupScript(c: Config) {
  const b = c.extensions.postgres!.backup!;
  const ctr = `two-${c.name}-postgres`;
  return `#!/bin/bash
set -Eeuo pipefail
umask 077
exec 6>/var/lock/2server-postgres-backup.lock
flock -w 120 6
mkdir -p /opt/2server/backups
trap 'printf 1 > /opt/2server/backups/postgres-backup-failed' ERR
backrest() { docker exec --user postgres ${ctr} pgbackrest --stanza=main "$@"; }
backrest stanza-create
backrest check
info=$(backrest --output=json info)
full=$(printf '%s' "$info" | jq '[.[0].backup[]? | select(.type == "full") | .timestamp.stop] | max // 0')
kind=diff
if [ "$(($(date +%s) - full))" -ge ${b.fullIntervalHours * 3600} ]; then kind=full; fi
backrest --type="$kind" backup
# Dependency-aware expiry: never age-delete the individual WAL/backup objects.
backrest expire
backrest --output=json info | jq -er '.[0].backup[-1].label' > /opt/2server/backups/postgres-last-success
date +%s > /opt/2server/backups/postgres-last-success-epoch
printf 0 > /opt/2server/backups/postgres-backup-failed
printf 'pgBackRest backup complete: %s\\n' "$(cat /opt/2server/backups/postgres-last-success)"
`;
}

export type PhysicalRecovery = { name: string; targetTime?: string; id?: string; check?: boolean };
export function physicalRestoreScript(c: Config, options: PhysicalRecovery) {
  if (c.extensions.postgres?.backup?.engine !== "pgbackrest")
    throw new Error("Physical recovery requires backup.engine=pgbackrest");
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(options.name)) throw new Error("Recovery requires a safe --recovery name (max 32 characters)");
  if (options.id && !/^\d{8}-\d{6}F(?:_\d{8}-\d{6}[DI])?$/.test(options.id))
    throw new Error("Invalid pgBackRest backup label");
  if (options.targetTime && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(options.targetTime) || !Number.isFinite(Date.parse(options.targetTime)) || new Date(options.targetTime).toISOString().slice(0, 19) !== options.targetTime.slice(0, 19)))
    throw new Error("PITR --target-time must be an ISO UTC timestamp");
  const ctr = `two-${c.name}-recovery-${options.name}`;
  const pg = `two-${c.name}-postgres`;
  const image = postgresImage(c);
  const target = options.targetTime
    ? `--type=time --target=${quote(options.targetTime.replace("T", " ").replace("Z", "+00"))} --target-action=promote`
    : "--type=immediate --target-action=promote";
  return `#!/bin/bash
set -euo pipefail
umask 077
exec 7>/var/lock/2server-extension-postgres.lock
flock -w 120 7
exec 6>/var/lock/2server-postgres-backup.lock
flock -w 120 6
test "$(cat /opt/2server/edge/owner)" = ${quote(c.name)}
test "$(docker inspect -f '{{index .Config.Labels "io.2server.owner"}}' ${pg})" = ${quote(c.name)}
if docker inspect ${ctr} >/dev/null 2>&1 || docker volume inspect ${ctr} >/dev/null 2>&1; then
  echo 'Recovery target already exists; select a new name. No data overwritten.' >&2; exit 1
fi
created=false
cleanup() {
  code=$?
  ${options.check ? `if [ "$code" -ne 0 ]; then mkdir -p /opt/2server/backups; printf 1 > /opt/2server/backups/postgres-restore-check-failed; fi` : ""}
  if [ "$created" = true ]; then
    docker rm -f ${ctr}-restore >/dev/null 2>&1 || true
    docker rm -f ${ctr} >/dev/null 2>&1 || true
    docker volume rm ${ctr} >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
docker volume create --label io.2server.owner=${c.name} --label io.2server.recovery=true ${ctr} >/dev/null
created=true
docker run --rm --network none --user 0:0 -v ${ctr}:/var/lib/postgresql --entrypoint sh ${quote(image)} -ec 'chown postgres:postgres /var/lib/postgresql; chmod 700 /var/lib/postgresql'
need=$(docker exec ${pg} du -sk /var/lib/postgresql/18/docker | awk '{print $1}')
free=$(docker run --rm --network none -v ${ctr}:/recovery --entrypoint sh ${quote(image)} -ec 'df -Pk /recovery' | tail -1 | awk '{print $4}')
test "$free" -gt "$((need + need / 5))" || { echo 'Insufficient disk for isolated recovery' >&2; exit 1; }
docker run --rm --name ${ctr}-restore --label io.2server.owner=${c.name} --label io.2server.recovery=true --network host --user postgres --memory ${c.extensions.postgres!.memoryMb}m --cpus ${c.extensions.postgres!.cpus} \\
  -v ${ctr}:/var/lib/postgresql -v ${root}/current/pgbackrest.conf:/etc/pgbackrest/pgbackrest.conf:ro \\
  --entrypoint pgbackrest ${quote(image)} --stanza=main --archive-mode=off ${target} ${options.id ? `--set=${quote(options.id)}` : ""} restore
# Host networking permits archive-get with VM identity; listen_addresses is empty.
# No application network, TCP listener or production volume is attached.
docker run -d --name ${ctr} --label io.2server.owner=${c.name} --label io.2server.recovery=true \\
  --network host --user postgres --memory ${c.extensions.postgres!.memoryMb}m --cpus ${c.extensions.postgres!.cpus} \\
  --security-opt no-new-privileges:true --pids-limit 256 --log-opt max-size=10m --log-opt max-file=2 \\
  -v ${ctr}:/var/lib/postgresql -v ${root}/current/pgbackrest.conf:/etc/pgbackrest/pgbackrest.conf:ro \\
  ${quote(image)} postgres -c listen_addresses= -c archive_mode=off -c archive_command= -c default_transaction_read_only=on >/dev/null
ready=false
for attempt in $(seq 1 120); do
  if [ "$(docker inspect -f '{{.State.Running}}' ${ctr})" != true ]; then break; fi
  if [ "$(docker exec ${ctr} psql -X -U two_admin -d ${c.extensions.postgres!.database} -Atc 'SELECT NOT pg_is_in_recovery()' 2>/dev/null || true)" = t ]; then ready=true; break; fi
  sleep 5
done
test "$ready" = true || { echo 'Recovery did not reach its target; original database is untouched' >&2; exit 1; }
docker exec ${ctr} psql -X -U two_admin -d ${c.extensions.postgres!.database} -v ON_ERROR_STOP=1 -Atc 'SELECT count(*) FROM pg_catalog.pg_class' >/dev/null
${options.check ? `docker rm -f ${ctr} >/dev/null
docker volume rm ${ctr} >/dev/null
created=false
mkdir -p /opt/2server/backups
date +%s > /opt/2server/backups/postgres-last-restore-check-epoch
printf 0 > /opt/2server/backups/postgres-restore-check-failed` : `created=false
printf 'Recovered isolated cluster ${ctr}. Inspect with docker exec; original database is untouched.\\n'`}
trap - EXIT
`;
}

export function removeRecoveryScript(c: Config, name: string) {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) throw new Error("Invalid recovery name");
  const ctr = `two-${c.name}-recovery-${name}`;
  return `set -euo pipefail
exec 7>/var/lock/2server-extension-postgres.lock
flock -w 120 7
test "$(docker inspect -f '{{index .Config.Labels "io.2server.owner"}}' ${ctr})" = ${quote(c.name)}
test "$(docker inspect -f '{{index .Config.Labels "io.2server.recovery"}}' ${ctr})" = true
test "$(docker volume inspect -f '{{index .Labels "io.2server.owner"}}' ${ctr})" = ${quote(c.name)}
test "$(docker volume inspect -f '{{index .Labels "io.2server.recovery"}}' ${ctr})" = true
docker rm -f ${ctr}
docker volume rm ${ctr}
`;
}
