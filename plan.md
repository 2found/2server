# Resource CLI and stateful extensions

## PostgreSQL hardening and PITR

Goal: ship least-privilege database roles, DB/backup alerts and scheduled restore
verification, plus pgBackRest WAL/PITR on the existing single VM. Research an easy
read-replica workflow; do not provision another VM or deploy HA.

Approach: reuse stateful Compose deployment, versioned private bundles, existing
systemd timers, resource CLI and node-exporter. Add focused PostgreSQL role,
pgBackRest and health modules. Keep logical dump recovery available explicitly.
Physical recovery always targets isolated storage/container; no in-place restore.
pgBackRest owns dependency-aware expiry; GCS age rules must exclude its repository.
The user confirmed 2server has no existing cluster: focus on fresh initialization,
with a guard against unrecognized existing data. Validate real PostgreSQL and
pgBackRest, including failed auth/DDL, missing WAL and restore isolation.

Work units:
- [x] Secure fresh-cluster admin/migration/application roles and data-layout guard
- [x] pgBackRest image/config, WAL archiving, backup/expiry and isolated PITR CLI
- [x] DB/backup metrics, alerts and scheduled isolated restore checks
- [x] Storage IAM/lifecycle compatibility and config/CLI validation
- [x] Real runtime/failure tests, docs, skill and read-replica research

Deviations: native TaskCreate is unavailable; this plan tracks verifiable units.
No production PostgreSQL extension is configured on Lohi, so validate on isolated
local resources and do not deploy a new empty production database.
pgBackRest integration uses a real POSIX repository with Docker volumes; GCS/S3
identity and object API behavior are not runtime-tested in this change. Terraform
mock plans validate repository IAM scope and lifecycle exclusions. No cloud
resources or production service configurations are changed.

### Hardening verification

- TypeScript and 52 default tests passed; six integration tests stay opt-in.
- Real PostgreSQL 18.6 / pgBackRest 2.59.2 passed least-privilege app/migration
  access, incorrect-password rejection, full/differential backup, WAL replay to
  an exact timestamp, isolated read-only recovery, existing-target refusal,
  weekly-drill cleanup, missing-WAL failure and primary data preservation.
- Failure injection verified backup/drill failure metrics and DB-down collection.
  It exposed missing Bash ERR inheritance in backup functions; `set -E` fixes it.
- Real PostgreSQL logical dump/restore, Redis and NATS integration passed.
- Real Prometheus passed generated-rule startup, seven alert firing scenarios,
  and disabled lifecycle/admin write boundaries. Monitoring reload recreates
  containers so changed bind-mounted rules are actually loaded.
- Seven Terraform mock-provider tests passed, including physical-repository IAM
  and exclusion from age-based GCS deletion. Skill validation passed.
- Documentation and skill cover fresh installations; read-replica research uses
  existing VM targets and explicitly marks proposed CLI commands as unavailable.

## Goal
Add Docker/kubectl-style resource operations to the single-VM product, plus
PostgreSQL backup/restore, provider disk growth, persistent Redis, and NATS.

## Approach
Reuse config validation, provider SSH, secret resolution, uploads, edge locks,
Cloudflare ownership, blue/green app health checks and Terraform roots. Add a
resource command dispatcher without breaking the original CLI. Manifest edits
are atomic and happen only after successful operations. All mutations retain
the --apply dry-run boundary. Stateful extensions have separate Compose projects,
private configuration, bounded resources and explicit removal retaining data.
Use existing GCS/S3 buckets and VM identity for backups; never distribute cloud
keys to containers. Restore into a new database, never overwrite a live database.
Use attached provider disks and grow ext4/XFS without formatting existing data.

## Work units
- [x] Resource contract, parsing and app replica lifecycle
- [x] Domain retirement, VM lifecycle, basic monitoring and disk operations
- [x] PostgreSQL/Redis/NATS deployment and backup/restore
- [x] Failure tests and real Docker integration
- [x] CLI documentation, examples and skill updates
- [x] Live GCP services, backup/restore, disk growth and app/domain lifecycle
- [x] Remove temporary resources and verify original production services

## Deviations
- **Task tracking** — No plan or ticket was supplied and TaskCreate is unavailable
  in this environment. This plan records verifiable work units and their status.
- **Redis mode** — The request permits simple Redis or Sentinel. Use authenticated
  single-node Redis with AOF; a single VM cannot provide host-level Sentinel HA.

- **Provider verification** — The follow-up authorized live testing. Use isolated
  containers, a temporary attached disk and a private temporary GCS bucket on the
  existing server; preserve production workloads and the canonical manifest.
- **Live permission fixes** — Linux bind mounts start root-owned with mode 0700;
  initialize PostgreSQL/Redis mount ownership explicitly before dropping root.
  Set uploaded files and cached certificate keys to 0600; suppress macOS archive
  metadata in deployment bundles.
- **GCS uniform access** — Real uploads rejected legacy object ACLs; configure
  rclone for bucket IAM and verify backup/restore using the VM identity.
- **Domain retries** — Public verification can fail after publication. Preflight
  retries against the proposed host set, retaining the retirement guard. Omit
  a redundant Cloudflare move-to-bottom when a rule is already last (error 20011).
- **Shared network aliases** — Compose also advertises the service key as DNS.
  Namespace it with the manifest, and migrate only the owned old container while
  preserving its volume; otherwise a new extension can collide with legacy apps.
- **Terraform test compatibility** — System Terraform is 1.6. Mock-provider tests
  need 1.7+, so `scripts/test-terraform.sh` runs isolated copies and accepts
  `TERRAFORM_BIN`; production roots retain 1.6 compatibility.

## Verification
- TypeScript check and 45 non-Docker tests passed. Follow-up tests cover Linux
  data-directory permissions, GCS uniform access, cache-rule retries and private
  certificate-file modes.
- Four real Docker integration cases passed: Caddy routing/rollback, existing
  Caddy adoption, Prometheus readiness/auth boundaries, and PostgreSQL/Redis/NATS.
- Stateful integration proved password rejection, persistence after restart,
  NATS Core and JetStream, real PostgreSQL dump/restore, existing-target refusal,
  and checksum rejection before database creation. Object storage was substituted
  with a local transport; no production bucket was accessed.
- GCP/AWS Terraform validate passed. Four mock-provider plan tests passed with
  isolated Terraform 1.9.8; the system Terraform 1.6 remains unchanged.
- Skill validation, example manifest validation, CLI help and diff whitespace
  checks passed. The implementation was committed and pushed before live tests.

## Live verification and remaining limits
Live GCP backup/restore, authentication failures, checksum rejection, Redis AOF,
NATS Core/JetStream persistence and ext4 disk growth passed on isolated resources.
Live HTTPS app tests passed: two replicas, logs, update, rollback, unhealthy
candidate rejection with the live route/manifest preserved, and scale 0→1.
The temporary hostname was verified through public DNS with normal TLS checks
because the local resolver cached a negative response. Domain creation retries
reused the published resources successfully. Domain/app/extension retirement,
temporary disk/bucket/IAM cleanup and test-certificate revocation passed. A second
live NATS check proved namespaced DNS aliases and authenticated pub/sub across
reload; the temporary extension was removed afterward.

Final host comparison detected a concurrent application rollout and an existing
analytics service with an ingestion backlog failing readiness. Its container and
broker identity were unchanged, with no restart or OOM. Do not claim every
production container stayed healthy; retain the private baseline/diff for follow-up.
AWS runtime and production VM stop/reboot/destroy were not exercised by this
smoke test.
Redis is standalone; all extensions are single-VM.
VM destruction keeps provider protection enabled by default, refuses a protected
destroy before applying any resources, and cannot destroy protected data disks.

## Managed backup storage follow-up

- [x] Derive `<project>-<region>-<server-name>-2server-backup` from the manifest's
  stable `name`, GCP project and VM zone; use ARCHIVE by default.
- [x] Configure backup frequency and retention independently: a six-hour UTC
  systemd calendar and 365-day GCS object expiry by default.
- [x] Add get/create/update backup-storage commands and isolated storage Terraform;
  grant only object create/read to the actual VM identity.
- [x] Let PostgreSQL inherit managed storage with `backup: {}`; preserve explicit
  GCS/S3 destinations and per-extension schedule overrides.
- [x] Update documentation, manifest example and operating skill.
- [x] Create the permanent Lohi bucket, verify live settings, and prove repeat
  planning returns no changes.
- [x] Fix saved-plan apply writing state to the provider root instead of its
  isolated path. Recover the verified bucket/IAM state privately and refuse
  stranded legacy state before another provisioning attempt.

Verification: TypeScript and 49 default tests passed (five opt-in integrations
skipped). The separate real Terraform regression passed create, no-op reapply,
in-place update and destroy using only its built-in local provider. Six cloud
mock plan tests passed on Terraform 1.9.8; the live bucket plan passed on 1.6.5.
The live bucket has regional Archive storage, 365-day Delete lifecycle, disabled
soft deletion, uniform bucket access and enforced public access prevention.
The six-hour calendar validated with the VM's systemd. Storage is provisioned;
scheduled database backups are not active on Lohi because its manifest has no
PostgreSQL extension. Backing up its existing Cloud SQL database needs an explicit
database target, rather than silently installing a different database.

### Seven-day retention revision

Changed the manifest schema, Terraform default, example, documentation and skill
to seven days, retaining the six-hour schedule and explicitly selected Archive
class. Applied the same lifecycle change to Lohi's existing bucket in place.
Updated existing default-policy assertions; TypeScript, 49 default tests and six
Terraform mock tests passed. Archive still bills its 365-day minimum when an
object is deleted early; documentation calls out Standard for short retention.

### Storage class cost revision

The user selected the cheapest class for the seven-day policy. Switched schema,
Terraform, example and skill defaults to Standard, and updated Lohi's bucket
default for future uploads. Standard avoids the minimum-duration charges that
make Nearline, Coldline and Archive more expensive for repeated seven-day full
backups in Singapore. Existing object classes are not rewritten implicitly.
TypeScript, 49 default tests and six Terraform mock tests passed after the class
change; the live update changed only the bucket's default storage class.

### Twelve-hour backup frequency

Selected 12 hours from the user's 12/24-hour options. Updated the default calendar,
example, skill, documentation and Lohi manifest to twice daily; once-daily remains
configurable as `*-*-* 00:00:00 UTC`. Standard storage and seven-day retention stay
configured. Lohi still has no PostgreSQL extension, so this saves the desired
schedule without claiming a Cloud SQL backup timer is active.
TypeScript and 49 default tests passed; both 12-hour and 24-hour calendars were
validated read-only with systemd on the Lohi VM.
