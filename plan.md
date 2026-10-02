# Discord alert webhooks

Goal: named Discord notification targets with config and CLI CRUD/test. Keep
secrets in ignored .env; use Alertmanager's native Discord integration.
Approach: reuse manifest validation, locking/atomic save, monitoring deployment
and its rollback. Add src/webhooks.ts for secret validation, receiver rendering
and explicit local delivery test. CRUD applies only to an installed monitoring
stack (no DNS/other extension reapply); config can be prepared before install.

- [x] Schema and native Discord receivers, preserve legacy generic webhook
- [x] CLI create/get/update/delete/test and last-receiver removal
- [x] Error/redaction/dry-run/CRUD tests; real Alertmanager Discord delivery fixture
- [x] Documentation, .env.example and operator skill

## Deviations
Native TaskCreate unavailable; track work here. The user subsequently authorized
applying the reliability changes to Lohi and supplied a Discord incoming webhook.
The URL is stored only in ignored `2server/.env` (0600); deployment state is private.

## Verification and live integration

- `bun run check`: 62 passed, 10 opt-in tests skipped; TypeScript passed.
- Real Alertmanager native Discord fixture: firing and resolved embeds confirmed.
- CLI live test confirmed by Discord message ID; VM Alertmanager also reports
  successful Discord notifications with zero delivery failures.
- Monitoring at `monitor.lohi2.com`: anonymous/wrong credentials return 401;
  correct credentials return 200. All three internal scrape targets are up.
- Live preflight found private release directory mode 0700 prevented default-user
  promtool validation. Run its read-only validator as root, retaining private
  directory permissions; runtime Prometheus remains unprivileged.
- Existing legacy Compose apps are observed through explicit container names and
  Caddy upstream files; blue/green changes are followed without adopting ownership.
- Optional node collectors report zero when hardware/filesystems are absent.
  Limit failure alerts to required core collectors; real promtool tests verify
  missing optional fibrechannel does not alert while failed filesystem does.
- Lohi Redis cache semantics retained; Redis/NATS exact images and existing
  volumes preserved. JetStream snapshot taken before recreation, then sync_always
  and bounded storage/client settings verified. No PostgreSQL or Cloud SQL mutation.
- Lohi stateless production app rollout uses the running image and environment,
  PID 1 init, 60s stop, 70s drain, and continuously checked Caddy upstreams.
  No application build or database migration runs.
- Existing AgentRay prod readiness reports replay backlog; dev reports stream
  mismatch. Those APIs are observed/alerted, not rolled or marked healthy.
- Legacy Caddy reload rollback and seed/cert safeguards: 3 tests pass, run from
  the 2server working directory. Skill validator passes.


---

# Single-VM runtime reliability

Goal: harden Redis, Caddy, NATS, monitoring and app deployments without adding
VMs. This provides process recovery and replica routing, not host-level HA.
Approach: reuse Compose, blue/green scripts, Docker restart policies, systemd
collectors and Prometheus textfiles. Add one shared runtime collector that reads
active on-host app metadata (scoped manifests must not erase other app coverage).
Readiness controls routing/alerts, not automatic restarts of dependency outages.
Use real Docker failure tests; no production deployment is requested this turn.

- [x] Redis authenticated persistence health, memory headroom and stop grace
- [x] NATS explicit durability and bounded client settings, crash recovery test
- [x] Caddy continuous app health/failover, app process init and graceful stop
- [x] Runtime metrics/alerts and monitoring component readiness
- [x] Failure tests, docs and skill instructions

## Deviations
Native TaskCreate is unavailable; track verification in this plan. Existing
monitoring uses stable bind paths; validate configs before restart and preserve
old files/Compose on failure. No new VM, Sentinel/quorum or automatic promotion.


## Verification

- `bun run check`: typecheck and 58 default tests pass; nine integration tests
  remain opt-in. App rollout rejects redirects and retains the old generation.
- Real Docker suite: 12 tests passed across stateful/runtime/reliability files.
  Redis wrong-password readiness fails; Redis and JetStream retain synced data
  across SIGKILL/start. Real collector reads broker metrics correctly.
- Caddy excludes/re-admits unhealthy replicas, retries dead connections and does
  not replay POST side effects. Prior Caddy routing/adoption/rollback tests pass.
- Real monitoring stack: all three scrape targets up, exporter off edge network;
  promtool evaluates DB and runtime failure alerts. Invalid config and failed
  update/first install test rollback/cleanup paths.
- Skill validation and `git diff --check` pass. No cloud resource, production
  app, VM or DNS changed; no load/capacity or external receiver test is claimed.

Review found and fixed a Caddy integration-test startup race, and aligned CLI
readiness with Caddy's 2xx-only contract. HTTP app metrics use Linux bridge IPv4;
IPv6-only networks and very large serial probe sets remain documented limits.
Redis/NATS off-VM backups and application-specific SIGTERM/reconnect/load tests
are follow-ups; single-host services cannot claim host-level HA.

---

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

## Stateless CLI and VM-owned operator configuration

Goal: an operator on machine B can deploy using only VM access; optionally keep
that connection in the consuming project's ignored `.2server/` directory.

Approach: reuse structured SSH, existing secret references, bundle upload and
resource commands. Publish an atomic private VM control snapshot containing the
complete manifest, referenced environment secrets and certificate/monitoring
state. Each connected command fetches the current snapshot into an ephemeral
private workspace, serializes operations with a VM lock, then persists successful
config and generated state. Keep SSH keys/provider login and Terraform state out
of snapshots. Add age-encrypted portable configuration backup/recovery. Reuse
app deployment for digest updates rather than introducing another rollout path.

- [x] Atomic VM control snapshots, stateless connection flags, secret isolation
- [x] Ignored `.2server/connection.json` convenience and automatic discovery
- [x] Real two-operator/failure tests and encrypted backup/restore round trip
- [x] Deploy/release CLI, documentation and skill migration guidance
- [x] Publish Lohi configuration and verify a clean-session read from the VM

Deviations: connection-only local config is explicitly requested by the user;
it is optional and never caches the authoritative manifest or secrets. Native
TaskCreate remains unavailable. VM destruction/reprovisioning and database data
recovery need independent Terraform and data backups, not the VM control snapshot.


Security follow-up: shared control state is root-owned at a fixed path, independent
of SSH username. Refuse symlinked, foreign-owned or group/world-writable control
paths. Different operator usernames are exercised through the actual CLI in a
shell-backed VM fixture. Root/sudo and Docker-socket holders remain trusted
administrators; ordinary app containers receive no control-state mount/API.

Verification: TypeScript, 72 tests and 537 assertions pass; 10 pre-existing opt-in
runtime/provider tests stay skipped. Real age round trip includes wrong-key and
populated-target refusal. The default test command now scopes to `./tests` so
ignored operator source archives cannot accidentally execute foreign test suites.
Live Lohi publication saved three referenced secrets and three portable state
files without rolling apps or changing DNS. Root modes are 0700/0600; the host
nobody user and node-exporter nobody user cannot read the secrets. Existing
autoheal has a Docker socket and is explicitly root-equivalent trusted infra.

Live migration complete: project `.2server/connection.json` and `.gitignore` are
installed. With local dotenv loading disabled, Cloudflare plan reports all managed
DNS records unchanged and authenticated public HTTPS verification passes. Encrypted
`.2server/lohi.age` decrypts to the exact SHA-256 of the VM snapshot. Recipients are
the existing passphrase-protected SSH key and a separate private recovery identity
outside the checkout. No applications were rolled, new VMs/users provisioned, or
DNS records changed. Legacy Lohi apps remain owned by their existing Compose
scripts; publishing does not populate the manifest's empty apps list.

After validating backup decryption against the VM hash, removed the three migrated
secret assignments from the old local `2server/.env`; unrelated non-secret metadata
was retained. Auto-discovery also works from inside the product submodule. Backup
and config export create an ignored private `.2server/` even without prior connect.

## npm distribution and Compose app adoption

Goal: publish @2server/cli, then manage existing Lohi Compose applications through
the same VM-owned stateless CLI without losing per-generation data or deployment
contracts. Reuse existing SSH, control snapshots, edge/app locks and readiness.

- [ ] Package allowlist, npm wrapper, installed-package smoke test and publication
- [ ] Compose adoption and deploy/rollback/status/log operations with private state
- [ ] Preservation and failure tests; migration-aware legacy wrapper handoff
- [ ] Adopt current Lohi apps, verify health/rollout, refresh encrypted backup

Adoption keeps Compose as the runtime adapter and copies resolved templates into
root-owned portable control state; no source-home dependency remains. It must not
restart existing containers merely to register them. Retain original projects,
container names, per-colour volumes/durables, env, entrypoints and readiness.
Scale beyond the declared pair is rejected explicitly. Existing application
migration scripts must remain in their build/release path.

Publication currently blocked by npm whoami HTTP 401 for ~/.npmrc. No npm token
was found in AgentRay/.env or the local QA env; user was asked to refresh login.
Continue preparing/testing the artifact and the independently authorized adoption.

## File-driven desired configuration

Implement `-f` YAML/JSON App/Extension/Domain documents; reuse VM control sessions,
resource reconciliers and rollback. Repo files are authoritative, with optional
image override; VM retains independent secrets/history/locks. Resolve tags on
registry via the target VM, then deploy immutable digests. Export Lohi public
runtime templates with explicit VM secret references. Update wrappers, templates,
skill and tests. No production workload rollout is needed for this source change.

- [x] File schema, CLI routing and extension templates
- [x] YAML connection, revision conflict check, independent VM app secrets
- [x] Authoritative app runtime and tag resolution
- [x] Lohi config files, wrappers, documentation and verification

Validation: typecheck and file/control/rollout tests; read-only Lohi API plan.
Generated public configs contain only credential references. No workload rollout
or npm publication for this source change. Starter platform files are not
automatic adoption of existing Redis/NATS/database containers.

Continuation review: corrected public `image-proxy` dependency lookup and allow
inspection/retirement when a dependency is absent. Regression suite: 7 passed,
0 failed (`tests/documents.test.ts`); TypeScript and `git diff --check` passed.
The same Orca runtime is reachable again, but this shell has no
`ORCA_TERMINAL_HANDLE`; worker-report verification remains unconfirmed. No
Dispatch or worker completion was fabricated. Changes remain uncommitted.

Final continuation verification: `bun run check` passed (86 passed, 11 skipped,
0 failed); deploy-wrapper Python harness passed. Packed 66 files, audited the
package for private deployment files and credential patterns, installed the local
0.2.0 tarball, and validated the API and monitoring source files through the
installed CLI. No public npm publish or production rollout was performed.

## Single App manifest (2026-10-02)

Follow the Kubernetes desired-spec/controller boundary without introducing a
Kubernetes dependency. App source declares image, resources, probes, env/secret
references, migration and logical instance volumes; 2server renders containers
and Caddy. Existing VM ownership and physical volume bindings survive different
source checkouts. Keep legacy runtimeFile input readable for older checkouts.

- [x] Add typed workload settings and VM-only binding/rendering
- [x] Migrate nine Lohi app/environment manifests; remove companion runtime files
- [x] Verify repeated apply, rollback and failure paths; generated Docker contracts
- [x] Update examples, docs and installed skill/CLI; validate source and VM plans

No production rollout, npm publication or push requested for this change.

Single-manifest verification: full CLI check 100 passed / 12 optional integrations
skipped / 0 failed; explicit Docker workload suite 5 passed (real containers,
health, literal secret dollars, isolated persistent volumes). After bounding
native probes, targeted app/workload suite 16 passed / 1 optional Docker skip.
Release-wrapper harness 2 passed. Installed local package and validated all nine
source App files. Read-only API and AgentRay plans against Lohi preserved runtime
bindings; AgentRay resolved both existing DuckDB volumes. Installed skill links
to this checkout and now documents the one-file workflow. No production rollout,
public npm publish, commit or push performed for this change.

Live single-file rollout completed 2026-10-02: all eight production services plus
Translate Web dev redeployed; AgentRay API/Web were last in this rollout. Fixed
Caddy executable file-capability failure with explicit NET_BIND_SERVICE support
(source schema, Compose/native/hook renderers, rejection tests and Docker proof).
Updated the stale TTS manifest digest to its migration-capable image. Isolated
release CLI passed typecheck and 50 targeted tests; Docker workload suite passed
7 tests. Used an isolated tested CLI while the unrelated extension refactor was
in progress. All nine live image/env/runtime audits passed; 35 secret references
verified in the encrypted control backup. AgentRay retained its existing DuckDB
volumes and caught up its parked JetStream consumer before cutover. A subsequent
independent Translate API release was allowed to finish, reverified, and included
in the refreshed backup. Evidence: consuming repo .2server/rollout-single-file/.

Observed limitations: litrans-dev.lohi2.com has no DNS (dev VM readiness passes).
Public sampling captured two transient Caddy upstream-health timeout episodes
(5 non-200 samples); cause not fully established. Last verification showed all
production endpoints healthy, with >29 minutes since the last sampled failure.
No commits, pushes, or public npm publication for this deployment test.
