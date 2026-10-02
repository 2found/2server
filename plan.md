# Resource CLI and stateful extensions

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
