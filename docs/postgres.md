# PostgreSQL operations

For a named template app, replace `postgres` in CLI commands with its app name.

This extension manages a single PostgreSQL 18 cluster on the manifest's VM. It
adds least-privilege roles, recovery checks and WAL/PITR; it does not provide HA,
automatic failover, cross-zone replicas or a guaranteed recovery SLA.

## Credentials and ownership

Set three different, at least 20-character single-line secrets in the checkout's
ignored `.env` (mode 0600), or the operator's secret environment:

| Manifest reference | Default variable | Purpose |
| --- | --- | --- |
| `passwordEnv` | `POSTGRES_PASSWORD` | Configured app user: DML, no DDL/role/database creation |
| `migrationPasswordEnv` | `POSTGRES_MIGRATION_PASSWORD` | `two_migrator`: assumes `two_owner` in the configured DB |
| `adminPasswordEnv` | `POSTGRES_ADMIN_PASSWORD` | `two_admin`: cluster administration and backup |

`two_owner` cannot log in. It owns the database/public schema and objects made
by migrations. New tables/sequences owned by it grant app DML/sequence access.
Custom schemas and functions need explicit grants in their migrations. Do not
run ordinary app queries or migrations as `two_admin`; privileged extensions
require a separate reviewed admin operation. The app cannot assume the owner role.

Only private files contain passwords; Compose/build arguments do not. SCRAM
protects password authentication. Database ports are not published on the host;
apps use the existing Docker network. This release does not enable PostgreSQL
TLS or isolate apps from each other on that shared network.

Initialization is for fresh data only. Changing secret files does not change
existing PostgreSQL passwords. Rotate the database role through authenticated
administration, update the secret, reload, then verify TCP authentication.

A fresh deployment initializes the roles automatically. An existing data directory
must belong to this manifest and contain the expected 2server role layout;
otherwise deployment stops before modifying it. Adoption of arbitrary existing
PostgreSQL clusters is outside this implementation.

## Backup configuration

Add `backup: {}` to `extensions.postgres` and configure managed `backupStorage`,
or use an existing exclusive repository prefix:

```json
{
  "database": "app",
  "username": "app",
  "passwordEnv": "POSTGRES_PASSWORD",
  "adminPasswordEnv": "POSTGRES_ADMIN_PASSWORD",
  "migrationPasswordEnv": "POSTGRES_MIGRATION_PASSWORD",
  "backup": {
    "engine": "pgbackrest",
    "destination": "gs://your-bucket/pgbackrest/server-name",
    "schedule": "*-*-* 00/12:00:00 UTC",
    "fullIntervalHours": 24,
    "retentionDays": 7,
    "restoreCheckSchedule": "Sun *-*-* 03:00:00 UTC",
    "maxAgeHours": 26,
    "restoreCheckMaxAgeHours": 192
  }
}
```

Omit `destination` to provision/use the managed GCS bucket. Omit `schedule` and
`retentionDays` to inherit `backupStorage` (12 hours and 7 days by default).
For daily backups set `schedule` to `*-*-* 00:00:00 UTC`. Set age thresholds to
allow the chosen schedule plus expected execution time. The full interval is
checked at each scheduled backup, not by a second timer; other runs are
differential. Missing `backup` means no automated backup.

The image builds PostgreSQL 18 Bookworm plus pgBackRest 2.59.2. Backups use one
pgBackRest worker, zstd compression and the database container's resource limits.
WAL archiving runs continuously; `archive_timeout=300` requests segment switches
during activity. This is not a five-minute RPO guarantee: archive failures,
upload delays and missing WAL can extend data loss. Monitor archive lag/failure
and size recovery objectives against measured restore time.

Managed GCS uses the VM service account and
`gs://<project>-<region>-<server>-2server-backup/pgbackrest/<server>`.
The VM needs metadata credentials and storage access scopes. Repository IAM
allows list/read/create/overwrite/delete, with new mutation grants scoped to
that server prefix. External GCS/S3 buckets must supply equivalent permissions;
old create/read-only `backup_bucket` grants alone are insufficient for pgBackRest.
S3 requires `backup.region` and an instance role reachable from the container
(including suitable IMDS hop limit); KMS-encrypted buckets need KMS permissions.
No operator credentials or static cloud keys are copied to the database.

pgBackRest owns physical-backup expiry. Its time-based retention keeps the full
backup needed to span the recovery window and dependent backups/WAL, so storage
can include objects older than seven days. Independent bucket age deletion must
exclude the repository. The managed Terraform rule expires only `postgres/`
logical dumps; apply `update backup-storage --apply` to older buckets before
PITR use. Deploying PostgreSQL with managed storage does this automatically.
For retention changes, update storage policy and reload the extension to refresh
pgBackRest config. See [pgBackRest retention options](https://pgbackrest.org/configuration.html#section-repository/option-repo-retention-full-type).

Deployment performs the first backup, installs the timer, then performs a
restore drill. If backup/drill fails, deployment reports failure; a healthy DB
may remain running for diagnosis. Check service results, fix the repository or
capacity issue, and rerun the affected operation. Do not claim recovery is ready
from container health alone. Backups need cloud egress; image builds need the
package registry. Schedule reloads with client reconnection in mind.

## Inspect, restore and verify

```bash
2srv get postgres -f server.local.json
2srv app postgres backup -f server.local.json --apply
2srv app postgres check-backup -f server.local.json --apply
2srv app postgres restore -f server.local.json --recovery investigate \
  --target-time 2026-10-02T00:00:00Z --apply
2srv get recovery -f server.local.json
2srv delete recovery investigate -f server.local.json --apply
```

`get postgres` returns pgBackRest backup inventory/status. `--id` optionally
selects a pgBackRest label. `--target-time` accepts an ISO UTC timestamp with `Z`.
Without a target time, restore stops at consistency at the end of the selected
backup; it does not mean replay every subsequently archived transaction.

Physical restore creates a distinct named Docker volume/container, refuses
existing targets, and never attaches the production data volume. It uses VM
networking to fetch archives, but PostgreSQL has **no TCP listener**, no app
network and defaults to read-only. Inspect through `docker exec` using the
configured database. Only trusted archives are supported; restored cluster
roles and secrets come from that backup, so treat the recovery volume as private.
Cutover is a separate operator action after checking rows, constraints,
sequences and representative app queries. Deletion checks ownership labels.

A drill restores the latest backup, waits until recovery completes, queries the
system catalog, then deletes its temporary container/volume and records success.
This proves cluster recovery, not business invariants or every historical PITR
target. Weekly drills and manual recovery need room for another cluster: at least
1.2 times current PGDATA free disk is checked, but WAL growth and older backups
can require more. The recovery container has the configured DB RAM/CPU limits
in addition to the live database, so leave host headroom. Drills serialize with
backup/deployment operations and can add IO load on this single VM.

`backup.engine: "dump"` opts into the optional custom-format logical dumps with
SHA-256 completion files. Their managed prefix is `postgres/`. Recover with:

```bash
2srv app postgres restore -f server.local.json --id DUMP_BACKUP_ID \
  --database restored_app --apply
```

For an external bucket, select the original dump prefix in the manifest used for
that operation. A new database is required; archives restore as `two_owner` in
one transaction without old ACLs/owners. Verify and apply necessary grants before
cutover. Logical dump mode has no WAL/PITR or automatic physical restore drills.

## Monitoring

PostgreSQL deployment installs a one-minute local SQL collector and textfile
metrics; it does not expose a DB credential to Prometheus. Reload the monitoring
extension to install its node-exporter metrics mount and DB alert rules:

```bash
2srv reload extension monitoring -f server.local.json --apply
```

Rules cover DB down, stale collector, failed/overdue backups and drills, WAL
archive failures/backlog, high connections, lock waits and long transactions.
Configure `extensions.alertWebhookEnv` with an HTTPS webhook secret
reference for outbound alert delivery. Without it, inspect alerts in Prometheus;
notifications are not sent. Monitoring on the same VM cannot reliably alert on
loss of that whole VM without an external observer.

Use `get monitor`, `get-log extension postgres`, and the host's
`two-<server>-postgres-{backup,restore-check,metrics}.service` journals/results.
Never print password files or publish private bundles. Deleting the extension
stops its timers and removes live DB metrics while retaining database data and
remote backups.
