# Stateful services and storage

Use `2srv init app NAME --template TEMPLATE -o FILE` for `postgres`, `redis`
or `nats`, then validate/plan/deploy the file. Discover backup and restore commands
with `2srv app NAME help`; always select the installed instance name. Named apps
use `2srv secret set --app NAME --env-file PRIVATE_FILE --apply` and the keys
declared by the generated App file. Read `docs/postgres.md` under the installed
product root for role separation and recovery. The storage/recovery constraints
below also apply to named apps, but their legacy global-secret setup does not.

## Legacy whole-server manifests

For source-driven App/Extension/Domain files, read [source configuration](source-config.md) first.
Secret values belong on the VM: `secret set [--app NAME] --env-file PRIVATE_FILE --apply`.
App desired configuration belongs in source; VM snapshots record applied state.

Read `src/modules/config/application/config.ts`, the manifest and `docs/operator-guide.md#postgresql-redis-and-nats`.
Use PostgreSQL 18, Redis standalone, and NATS Core or JetStream. They are
single-VM services, not multi-host HA. Prefer resource commands scoped to one
extension over reapplying every extension.

## Deploy and remove

Create/update with a complete extension JSON spec and a secret variable in a private
env file; run legacy commands with that file available to Bun (for example
`bun --env-file /private/server.env <product-root>/src/cli.ts ...`). The installed
launcher does not load a product-root `.env` when invoked from another project.
The CLI resolves secrets before SSH and requires at least 20 single-line characters. Never print
secret files or Compose configuration that might contain credentials.

```bash
2srv create extension postgres -f server.local.json --spec postgres.json
2srv create extension postgres -f server.local.json --spec postgres.json --apply
2srv get extension postgres -f server.local.json
2srv get-log extension postgres -f server.local.json --tail 100
```

Use `redis` or `nats` similarly. `reload extension NAME` reapplies its config and
checks readiness. Stateful reloads can interrupt clients; they are not blue/green.
PostgreSQL init variables do not rotate an existing database password. For a
rotation, change the database role through its own authenticated administration
flow, update the referenced secret, then reapply and verify TCP authentication.
Changing database/user/dataPath or major version is a migration, not an update.

`delete extension NAME --apply` removes the service and backup timer while
retaining data and private release bundles. Do not add `--volumes`, remove data
paths, or revoke shared provider permissions as an implicit part of removal.

## PostgreSQL permissions, backups and recovery

Read `docs/postgres.md` under the installed product root for the current runbook.
Fresh clusters create three roles: the configured app login (DML only), `two_migrator`
(assumes non-login `two_owner` in the app DB), and superuser `two_admin`.
Legacy manifests require three distinct secrets in their private env file: `POSTGRES_PASSWORD`,
`POSTGRES_MIGRATION_PASSWORD`, `POSTGRES_ADMIN_PASSWORD` (or manifest overrides).
Use the migration login for schema changes, never the admin login in the app.
Missing credentials: name the required keys and the appropriate private-file/VM setup;
do not ask the user to paste passwords into chat. Init does not rotate passwords.
Unrecognized data is refused; do not fabricate ownership/layout marker files.

With `backup: {}`, the default is pgBackRest plus WAL archiving, full/differential
backups every 12 hours and weekly isolated restore checks. Full backups become
due after 24 hours; other scheduled runs are differential. Frequency, full
interval, retention, drill schedule and alert age thresholds are configurable.
`backupStorage` defaults to regional GCS STANDARD, seven days, bucket
`<ssh.project>-<region-from-ssh.zone>-<name>-2server-backup`.
Managed physical storage uses `pgbackrest/<name>`; optional `engine: "dump"` uses
`postgres/`. PostgreSQL deployment applies managed storage and verifies its first
backup and drill. Storage config alone neither installs PostgreSQL nor backs up
Cloud SQL. Resolve the target database before claiming a backup is active.

pgBackRest must retain base backups and WAL spanning the recovery window. Never
apply an independent object-age deletion rule to its prefix: managed GCS expiry
is limited to `postgres/`. Seven days is a recovery window, not a hard maximum
age for all physical files. Reload PostgreSQL after config changes; apply managed
storage changes with `update backup-storage --apply`. External repositories need
VM identity list/read/create/overwrite/delete permission and lifecycle exclusions.
Use an exclusive prefix per cluster; do not share a repository between primaries.

```bash
2srv get postgres -f server.local.json
2srv app NAME backup -f server.local.json --apply
2srv app NAME check-backup -f server.local.json --apply
2srv app NAME restore -f server.local.json --recovery inspect --target-time 2026-10-02T00:00:00Z --apply
2srv app NAME recoveries -f server.local.json
2srv delete recovery inspect -f server.local.json --apply
```

Physical restore is an isolated volume/container without a TCP listener; existing
targets are rejected. No live data is overwritten and no application is switched.
Without a timestamp, recovery stops at consistency at the end of the selected
backup. Inspect representative application rows/queries before a separate cutover.
Drills need disk for another cluster plus spare RAM/CPU on the same VM. They
verify cluster recovery, not business correctness. A failed deployment can leave
the healthy DB running: inspect backup/drill service results before retrying.

For explicit dump mode, use `app NAME restore --id BACKUP_ID --database NEW_DB`.
Only trusted archives are supported; restore runs as the owner role and refuses
an existing database. A failed logical restore may leave an empty target DB;
inspect it rather than dropping it by name automatically.

DB metrics are collected locally every minute. Reload existing monitoring to
install its textfile mount/rules. Configure `alertWebhookEnv` for outbound
notifications; without it, rules are visible only in Prometheus. Same-VM
monitoring cannot guarantee notification when the entire VM is lost.

Read replicas remain research only; see `docs/roadmap.md` for proposals. Do not
invent replica CLI commands or provision a second VM implicitly. Current PostgreSQL remains single-VM without automatic failover.

## Disks

Terraform `data_disks` creates and attaches separate persistent disks. Copy the
`data_disks` output into the manifest, retaining exact provider IDs/device paths.
For AWS also record the `vm` output; NVMe serial verification requires Nitro.
Use `create disk NAME --apply` only for an intentionally empty attached disk: it
verifies attachment/identity, refuses existing signatures and formats ext4, then
mounts by UUID through fstab. Partitioned disks, LVM, encryption layers and boot
disks require another adapter and must not be forced through this command.

Set PostgreSQL `disk` to the disk name and `dataPath` below its mountPath. The
extension refuses startup when that mount/device is absent, preventing a second
empty database on the boot disk. Growth is online for whole-disk ext4/XFS:

```bash
2srv resize disk database -f server.local.json --size-gb 100 --apply
```

It checks the actual attached provider volume, grows it, waits for the guest to
observe the size, then grows the filesystem. It never shrinks or formats during
resize. Update the original Terraform size afterwards to avoid configuration
drift. A timeout after provider resize is partial success; inspect and rerun the
same size to finish filesystem growth, not a second create. Terraform protects
data disks against destruction; VM retirement needs explicit state/data handling
when those disks exist.

## Redis and NATS reliability

Read `docs/reliability.md` before tuning availability or durability. Redis requires
50% memory headroom for AOF rewrite; `appendfsync` is `everysec` or `always`.
Deployment sets host `vm.overcommit_memory=1`. Wrong credentials/AOF write errors
fail health; truncated AOF refuses startup. Preserve data and investigate before
repairing or retrying. NATS JetStream defaults to `syncInterval: "always"`; explain
the throughput/durability tradeoff before choosing a duration. Clients own bounded
stream retention, durable consumers, acknowledgements and reconnect behavior.
Neither extension has automated off-VM backup; local crash recovery is not HA.
Reload monitoring to install runtime metrics; explicit extension deletion marks
retirement so retained metadata does not create false down alerts.
