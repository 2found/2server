# Easy read replicas — design research

Status: proposed, not implemented. No replica or extra VM is provisioned by this
change. Start with asynchronous physical streaming replication for PostgreSQL 18,
using a supplied VM. It gives an explicit read endpoint without the coordination
and automatic promotion required by HA.

## Placement and cost

| Placement | Useful for | Limits |
| --- | --- | --- |
| Existing different VM with spare capacity | Read offload and an independent database process | Uses its RAM/disk/network; asynchronous data can lag |
| Same VM, separate container and volume | Testing replication or separating read workloads | Duplicates storage/cache, competes for IO, no host-failure protection |
| Newly provisioned VM | More independent read capacity | Additional VM cost; explicitly deferred |

Same-VM replicas do not add hardware capacity. For a small server, tune the primary
and query workload before spending its remaining resources on a second copy.
A read replica is not a backup: erroneous writes/deletes replicate too.

## Proposed operator flow

Keep one target manifest per VM and an explicit source-manifest reference.
The following CLI is a **proposal**, not supported commands today:

```text
2server create replica reader --source primary.json -f existing-reader-vm.json --apply
2server get replica reader -f existing-reader-vm.json
2server reseed replica reader -f existing-reader-vm.json --apply
2server delete replica reader -f existing-reader-vm.json --apply
```

Creation should preflight both identities, disk/RAM headroom, compatible major
versions and private connectivity. Store source cluster identity and owned role,
slot, endpoint and volume names so a retry cannot silently attach to another DB.
Require an explicit existing target; never provision a VM as a side effect.

Bootstrap with `pg_basebackup -R -X stream` into an empty private volume. It writes
standby connection state; use a dedicated replication slot and reserve sender
capacity for both backup and WAL streaming. For large clusters, pgBackRest
standby restore from the existing repository is an alternative seed path, with
streaming catching up afterward. [PostgreSQL pg_basebackup](https://www.postgresql.org/docs/current/app-pgbasebackup.html),
[pgBackRest restore options](https://pgbackrest.org/command.html#command-restore).

Use a unique `LOGIN REPLICATION` role per replica, without superuser or database
ownership, and a private password file. Inter-VM transport needs private routing,
TLS with `verify-full`, and exact peer CIDRs in `pg_hba.conf`. The current extension
has no remote PostgreSQL TLS endpoint: implementing that is a prerequisite, not
something the new PITR code already supplies. Publish neither the DB nor
replication port through Cloudflare HTTP proxy. App reads use a separate
least-privilege login and an explicit read-only endpoint.

Bound retained WAL with `max_slot_wal_keep_size`, monitor slot bytes/free disk and
replay lag, and expose “needs reseed” if the replica falls behind retained WAL.
An unlimited slot can fill the primary disk. Start with `hot_standby_feedback`
off; allowing it requires monitoring primary bloat and long replica queries.
Avoid synchronous replication for this read-offload mode. [PostgreSQL replication
settings](https://www.postgresql.org/docs/current/runtime-config-replication.html).

A replica is ready only after `pg_is_in_recovery()` is true, receiver/replay are
healthy, lag is below the configured bound, and a write is rejected. Route only
staleness-tolerant reads to it; read-after-write paths stay on the primary. There
is no transparent SQL splitting or automatic promotion in this proposal.

Removal should stop the owned receiver, revoke its dedicated credential/HBA rule
and remove its inactive owned slot on the source, retaining data by default.
Partial source/target failure needs an explicit pending-cleanup state and bounded
retry. Reseeding requires a new volume; replacing/removing existing data is a
separate confirmed operation.

## Acceptance evidence for a later implementation

- Re-running create preserves identity/data and does not duplicate slots or roles.
- Committed source writes replay; standby writes fail; lag is visible.
- Restart/network interruption reconnects; a failed replica leaves primary writes working.
- Exceeding the WAL cap reports reseed required without unbounded primary disk growth.
- Wrong credentials/certificates/peer addresses fail before exposing an endpoint.
- Cleanup removes only owned inactive slots; source failure leaves actionable state.
- Bootstrap/reseed never overwrites the primary or an existing target volume.

Physical streaming is the default recommendation because it copies the full
cluster and schema changes. Logical replication is a separate use case for
selected tables or heterogeneous versions, with additional schema/DDL management.
See [PostgreSQL standby operation](https://www.postgresql.org/docs/current/warm-standby.html).
