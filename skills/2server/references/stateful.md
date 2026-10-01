# Stateful services and storage

Read `src/config.ts`, the manifest and the README's stateful extension section.
Use PostgreSQL 18, Redis standalone, and NATS Core or JetStream. They are
single-VM services, not multi-host HA. Prefer resource commands scoped to one
extension over reapplying every extension.

## Deploy and remove

Create/update with a complete extension JSON spec and a secret variable in the
ignored product `.env`; run commands from the product root. The CLI resolves
secrets before SSH and requires at least 20 single-line characters. Never print
secret files or Compose configuration that might contain credentials.

```bash
bun src/cli.ts create extension postgres -f server.local.json --spec postgres.json
bun src/cli.ts create extension postgres -f server.local.json --spec postgres.json --apply
bun src/cli.ts get extension postgres -f server.local.json
bun src/cli.ts get-log extension postgres -f server.local.json --tail 100
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

## Backups and recovery

Configure `extensions.postgres.backup` with an existing `gs://bucket/prefix` or
`s3://bucket/prefix`, a systemd calendar schedule, and an S3 region when relevant.
Backups run on the VM using its identity, not the operator's login. The Terraform
`backup_bucket` input grants access to an existing dedicated bucket; for an
adopted VM, inspect its identity and bucket permissions first. Bucket lifecycle,
retention, versioning and access policies remain owned by that bucket's operator.
A deployment performs an initial backup before enabling the timer. Do not report
backup setup complete after a container merely starts.

```bash
bun src/cli.ts backup postgres -f server.local.json --apply
bun src/cli.ts restore postgres -f server.local.json --id BACKUP_ID --database recovery_check --apply
bun src/cli.ts get monitor -f server.local.json
```

Restore accepts only IDs returned by backup, within the configured prefix. It
checks the archive checksum before creating a **new** database, and restores in
one transaction. Never reuse the live database name. Check application rows,
constraints, sequences and a representative app query in the restored database
before switching application configuration. Restore executes SQL from a trusted
backup: an untrusted bucket/archive is not a safe input. An interrupted failed
restore may leave an empty new database; inspect it instead of dropping it by
name automatically. These are single-database logical backups, not cluster roles,
WAL/PITR or volume snapshots. Large restores may need a separate capacity plan.

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
bun src/cli.ts resize disk database -f server.local.json --size-gb 100 --apply
```

It checks the actual attached provider volume, grows it, waits for the guest to
observe the size, then grows the filesystem. It never shrinks or formats during
resize. Update the original Terraform size afterwards to avoid configuration
drift. A timeout after provider resize is partial success; inspect and rerun the
same size to finish filesystem growth, not a second create. Terraform protects
data disks against destruction; VM retirement needs explicit state/data handling
when those disks exist.
