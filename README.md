# 2server.app

An operator CLI for a single Docker/Caddy VM. Supply SSH access and a manifest;
2server sets up the host, deploys immutable container images, and reconciles
Cloudflare DNS, origin certificates, TLS mode, routes and cache policies.
Use an existing VM or create one with the isolated GCP/AWS Terraform roots.

This first release is CLI/config based. It does not require a resident control
plane, database, Kubernetes cluster or public admin dashboard.

## Quick start

```bash
git clone https://github.com/lohi-ai/2server.git
cd 2server
bun install --frozen-lockfile
cp .env.example .env
chmod 600 .env
cp examples/server.json server.local.json
# Fill .env locally; configure SSH, domains, images and secret references.
bun src/cli.ts validate server.local.json
bun src/cli.ts plan server.local.json
```

Use `examples/existing-caddy.json` to attach domains to an existing Caddy with
stable web/API upstream imports. Replace the fictional project and domain values.
Keep private server manifests and provider state in your consuming repository
or an ignored operator directory. `/deployments/` is excluded from this public
repository, including `deployments/lohi/`.

`plan` reads Cloudflare and describes DNS/TLS/cache actions. It does not issue
certificates or modify the VM. `setup` needs key-based SSH, a trusted host key,
passwordless sudo, and Debian 12/13 or Ubuntu 22.04/24.04. Plain SSH and GCP IAP
are supported. An omitted `originIp` is discovered from GCP instance metadata
or the direct SSH host address; set it explicitly for a bastion/alias.
Authenticate and trust the host through your normal SSH/gcloud workflow first.

Existing-mode setup adopts a Compose-managed Caddy with one Compose config
file and a bind-mounted Caddyfile. It validates the added imports before a
one-time container recreation to attach `/opt/2server/edge`. Future domain
updates use reloads. Retain that durable mount and both imports in the source
repository that owns the existing edge configuration.

Adding a hostname may also require OAuth callbacks, app origin/cookie/CORS and
frontend build settings. Verify sign-in before retiring an old hostname.

## Cloudflare access and ownership

The default credential is a scoped bearer API token in `CLOUDFLARE_API_TOKEN`.
Keep local infrastructure credentials in this checkout's ignored `.env`, using
[.env.example](.env.example) as the template. Bun loads it automatically when
commands run from the 2server directory. Do not store these credentials in
unrelated app or QA configuration. CI can supply the same variables through
its secret store. Keep `.env` owner-readable/writable only (`chmod 600 .env`).
Use zone-level Zone Read, DNS Edit, Zone Settings Edit, Cache Rules/Cache Settings
Write, and SSL and Certificates Edit, limited to the managed zones.
A separate bearer token for certificate issuance can be selected through
`cloudflare.originTokenEnv`. A Global API Key or Origin CA service key is not
a bearer token; create a scoped API token instead. Tokens never go to the VM.
See [Origin CA API](https://developers.cloudflare.com/api/resources/origin_ca_certificates/methods/create/).

A zone must already be active under Cloudflare nameservers. The tool does not
purchase domains or change registrar delegation. Existing A records need
`"adoptDns": true` on their domain entry unless already marked with this
manifest's ownership comment. Conflicting A/AAAA/CNAME records are rejected.
TXT/MX and unrelated rules are retained. Zone-wide Full (strict) is displayed
in the plan; ensure all other origins in that zone support it before applying.

One manifest name owns one VM. Keep all its managed domains in the file.
Automatic hostname deletion is deliberately rejected; retire DNS/cache records
and adjust ownership state as a reviewed operation. Do not declare the same
host in the legacy Caddyfile and the managed manifest.

Apply order: inspect DNS/rules → check host ownership → issue/reuse certs →
reconcile cache rules → stage Caddy release → validate/reload → check origin →
set Full (strict) and publish proxied DNS → verify public HTTPS. Invalid configs restore the old
symlink. Failed origin probes restore the previous release. Provider failures
abort with a nonzero exit; external API operations are not globally atomic.
Rerun the plan after an interrupted operation: completed DNS changes are
idempotent, and each record is checked again before publication.

Certificates are generated locally, checked for host coverage/key match/expiry,
and transferred over SSH stdin. Operator state is private under
`~/.local/state/2server/<name>/`; VM state is under `/opt/2server/`.
Back up operator state encrypted, keep the same operator state in scheduled CI,
and rerun `domains --apply` weekly. It reissues a certificate with fewer than
30 days remaining. Losing state can issue extra certificates; deleting local
state does not revoke a live certificate. Private keys never enter Terraform.

For a 15-year Cloudflare Origin CA certificate covering a zone apex and its
first-level subdomains, add this to the domain entry:

```json
"certificate": { "scope": "zone", "validityDays": 5475 }
```

The default remains an exact-host certificate valid for 365 days. Supported
validities are 365, 730, 1095 and 5475 days. A change to wider coverage or longer
validity issues a new pair; matching private state is reused on later runs.
Cloudflare serves its browser-trusted edge certificate publicly and uses this
Origin CA certificate to validate Caddy. See the [Origin CA create API](https://developers.cloudflare.com/api/resources/origin_ca_certificates/methods/create/).

Account-owned tokens use `/accounts/<account-id>/tokens/verify`, not the user
verification endpoint. Account-level permissions do not grant zone-level DNS,
settings or cache access: include each managed zone in the token's zone policy.

For an account-wide integration, create/edit the token under **Manage account →
Account API tokens**, selecting **Entire <account name> account** as its resource
scope when 2server should manage domains throughout that account. A narrower
scope must include each managed zone explicitly. Grant the zone permissions
listed above and include all managed zones (including monitoring's zone).
You do not need every account permission or token-administration access to deploy.
See [Cloudflare account-token setup](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/).

Missing or blank credentials cause a nonzero CLI exit with the exact variable
and `.env` setup location. HTTP 401/403 errors identify the operation and relevant
permission, and remind you to check account/zone resource scope and token expiry.
An exported shell variable takes precedence over `.env`; update or unset a stale
export before retrying. The CLI does not alter token policies automatically.

## New server and applications

```bash
# Existing SSH VM:
cp examples/server.json server.local.json
# Replace the example address, host, domains, digest, memory budget and secrets.
bun src/cli.ts setup server.local.json --apply
bun src/cli.ts deploy server.local.json --apply
bun src/cli.ts extensions server.local.json --apply
bun src/cli.ts domains server.local.json --apply
bun src/cli.ts status server.local.json
bun src/cli.ts verify server.local.json
bun src/cli.ts rollback server.local.json --apply
```

Apps require an immutable `repository@sha256:…` image, internal port, readiness
path, memory limit and CPU limit. Registry login must already work for root on
the VM; use the cloud registry's short-lived credential helper where possible.
HTTP services pass an internal readiness probe before Caddy switches. The
previous container remains available for rollback, and runs for 70 seconds to
outlive Caddy's 60-second drain. Capacity must allow both versions during that
window. Container logs and process counts are bounded; ports are not published.

For a background worker use `"kind":"worker"`. Its image must define a Docker
HEALTHCHECK. The old worker stops before its replacement starts, and starts
again if readiness fails. There is a brief processing pause; 2server makes no
exactly-once queue-delivery guarantee. Use a new app name when changing between
a service and worker. The `port` field is unused for workers.

`rollback` restores parked containers in reverse manifest order, using the
previous version's recorded readiness contract. It does not reverse database
migrations or data writes. Stateful services use separate extension lifecycles and persistent storage;
app rollback never changes their data. Run backward-compatible migrations through your app's existing
migration process before deployment.

Secret references accept environment variables, GCP Secret Manager versions,
or AWS Secrets Manager SecretString values. Only single-line env-file values
are accepted. The operator resolves these using its cloud identity; the VM does
not get a project-wide secret-reader role. App env files are root-only, and the
Docker administrator can necessarily inspect container environments. Do not
put secrets in the manifest's ordinary `env` map.

To build, push and deploy one app from an existing Dockerfile:

```bash
scripts/release.sh server.local.json app ghcr.io/your-org/app:release ../app
```

The script deploys the digest returned by Buildx and prints it for the manifest.
It does not guess an application's build args. The [CI example](examples/ci/deploy.yml)
uses a dedicated trusted runner with persistent private state, pinned actions,
serialized releases and weekly domain/certificate reconciliation. Configure its
SSH/Cloudflare secrets and production environment before enabling it.

## Provisioning

```bash
bun src/cli.ts provision gcp /absolute/path/server.tfvars
bun src/cli.ts provision gcp /absolute/path/server.tfvars --apply
# Or: provision aws …
```

The first command runs a Terraform plan. The second creates a fresh plan and
applies it. Each absolute tfvars path identifies a separate private local state
under `~/.local/state/2server/terraform/<provider>/`. Keep that path stable and
back up state; moving it without state migration would plan another VM. Do not
use these roots to take over an existing VM; use SSH mode, or perform an explicit
Terraform import/state migration. Keep existing deployment state in its owning
repository; these roots are only for new VMs.

Older releases could save applied state in `terraform/<provider>/terraform.tfstate`
instead of the private state directory. Provisioning refuses a nonempty state
there. Verify its resource IDs against the intended target before moving it to
the private path named in the error. Preserve a private backup; never overwrite
another state or retry creation of resources that already exist.

GCP inputs: `project`, optional region/zone/name/machine type/disk size. It creates
a dedicated VPC, static IP, Debian VM, unprivileged service account and IAP-only
SSH ingress; OS Login and Shielded VM are enabled. The operator needs API-enable,
compute, IAM, OS Login and IAP permissions. AWS inputs: region, verified Debian
or Ubuntu amd64 `ami_id`, `ssh_public_key` and restricted `ssh_cidrs`; it creates
a VPC, route, EIP and encrypted gp3 VM with IMDSv2 required. Neither root grants
workload access to every secret. Deletion protection is enabled.

Web ingress defaults to the [Cloudflare IPv4 ranges](https://www.cloudflare.com/ips-v4/),
with `web_cidrs` available for an explicit override. The host bootstrap preserves
existing firewalls; adopting an existing host does not silently replace them.
Provisioning cost depends on the selected region, VM, disk and public address;
inspect the Terraform plan before applying. No paid resources are created by tests.

## Cache and optional extensions

`cache: "app"` bypasses Cloudflare caching for that host, including authenticated
and static requests. `images` permits anonymous GET/HEAD under `/i/`; `audio`
permits anonymous GET/HEAD under `/a/`. Both preserve the origin's cache TTL and
`no-store` directives, cookies/Authorization bypass caching, and every other path
bypasses. Query strings stay in cache keys, so query-signed resources remain safe.
Rules are appended individually; the manifest's policy takes precedence for its
hosts without deleting others. See [Cloudflare rule updates](https://developers.cloudflare.com/ruleset-engine/rulesets-api/update-rule/).

A generic domain pointing at an existing image/audio service needs only the
matching preset and upstream. Optional `extensions.imageProxy` installs signed
imgproxy on `/i`, with HTTPS source prefixes, private-network source blocking,
resolution/concurrency/memory limits, and secret key/salt environment references.
It uses standard imgproxy signed URL syntax; Existing unsigned/custom
image proxies retain their existing container and URL contract.

`extensions.monitoring: true` installs Prometheus (7 days / 1 GB retention), node
exporter and host-down, disk and memory alerts. Total configured memory ceiling
is 448 MB. Add `alertWebhookEnv` to enable a 64 MB Alertmanager with a standard
Alertmanager webhook receiver URL read from that environment variable. Without
it, alerts are visible in Prometheus but are not delivered externally. The UI
binds to loopback and the private Docker network. `extensions --apply` also
creates proxied Cloudflare DNS, an Origin CA certificate, a Caddy route and a
cache-bypass policy at `https://monitor.<zone>`. The zone is inferred when the
manifest has exactly one domain zone. Existing application routes are retained;
you do not need to run `domains` separately for monitoring. The stack must pass
readiness before DNS is published. Public verification requires anonymous 401
and authenticated 200 responses.

Access uses HTTP Basic authentication over HTTPS (bcrypt in Caddy). The default
user is `admin`; a generated password is saved with mode 0600 at
`~/.local/state/2server/<name>/monitoring-credentials.json` and reused on later
runs. The CLI prints its location, never its value. Keep this state available
for `verify`, scheduled domain renewal and redeployment. For a custom hostname,
multiple zones, or CI-managed credentials, use:

```json
"extensions": {
  "monitoring": {
    "zone": "example.com",
    "hostname": "metrics.example.com",
    "username": "admin",
    "passwordEnv": "MONITORING_PASSWORD"
  }
}
```

Supply a 16–72 byte password through that environment variable on deployment,
domain renewal and verification. For local operation, store `MONITORING_PASSWORD`
in `2server/.env` and keep `passwordEnv` set in the manifest; this uses that file
instead of the generated credential fallback. The username remains a manifest
setting. A pre-existing unowned A record requires
`adoptDns: true`; conflicting record types still fail. Normal `plan`, `domains`
and `verify` include the generated monitoring host. Install extensions before
full domain publication on a new VM. Setting monitoring to false does not
uninstall its containers or retire its DNS; use the skill's retirement procedure.
Docker logs and journald are bounded. A monitor on the same VM cannot notify when the entire VM
is lost: keep an external uptime check (the existing GCP check remains).

Jaeger is optional future tracing, not required for host health. Its embedded
[Badger backend](https://www.jaegertracing.io/docs/2.dev/storage/badger/) fits modest
single-node trace workloads but needs app instrumentation and adds storage/CPU.
Prometheus retention is bounded, not a strict total-disk quota: WAL/head storage
needs additional headroom. [Prometheus storage documentation](https://prometheus.io/docs/prometheus/latest/storage/).

## Verification

```bash
bun run check
DOCKER_TESTS=1 bun run check # Caddy routing/recovery and Prometheus startup/security
terraform -chdir=terraform/gcp init -backend=false
terraform -chdir=terraform/gcp validate
terraform -chdir=terraform/aws init -backend=false
terraform -chdir=terraform/aws validate
terraform fmt -check -recursive terraform
```

Docker runtime tests need Docker, Compose, `jq` and `flock`; macOS also needs GNU `gmv`.
Cloudflare interactions use HTTP mocks; no live DNS, billing, SSH, cloud VM or
OAuth change is performed by these tests. Before a production rollout, verify
public HTTPS/sign-in and actual image/audio MISS→HIT plus range/error cases.
Fresh-VM bootstrap, live provider permissions and DNS propagation require a staging rollout.

## Agent skill

The [2server skill](skills/2server/SKILL.md) covers VM lifecycle, provider-specific
SSH, Cloudflare domains, application deployment/CI and extension retirement.
Install it by linking `skills/2server` into your agent’s skill directory; invoke
`$2server`. The helper imports the product code, so retain this checkout.
Declare each server's connection in the manifest's `ssh` field. To display the
resolved, safely quoted connectivity-check command without executing it:

```bash
bun skills/2server/scripts/ssh-command.ts server.local.json
```

## Resource CLI

Use `bun src/cli.ts` directly, or run `bun link` in this checkout to install the
`2server` command. Resource commands support both `get app` and `app get` syntax.
The original manifest-oriented commands remain compatible. Use one full manifest
per VM; all resource commands take `-f server.local.json`.

| Resource | Operations | Meaning |
| --- | --- | --- |
| `app` (`service`) | get, describe, create, update, delete, reload, rollback, logs/get-log, scale | Desired app spec and healthy blue/green generations |
| `pod` (`workload`, `instance`) | get, describe, create, update, delete, reload, logs/get-log | A managed Docker container; operations reconcile its owning app |
| `domain` | get, describe, create, update, delete, reload | Cloudflare DNS/cache, certificates and Caddy routes |
| `vm` | get, describe, start, stop, reload, logs; create/update/delete/scale with provider + tfvars | Provider lifecycle; Terraform for resource CRUD |
| `extension` | get, describe, create, update, delete, reload, logs/get-log | postgres, redis, nats, monitoring, image-proxy |
| `disk` | get, describe, create, resize | Initialize an empty attached disk or grow an existing filesystem |
| `monitor` | get, describe | Host memory/load/filesystems, container usage and last backup result |
| `postgres` | backup, restore | Single-database logical backups and recovery |
| `backup-storage` | get, describe, create, update | Derived GCS bucket policy and isolated Terraform provisioning |

```bash
2server get app -f server.local.json
2server get pod -f server.local.json
2server create app api -f server.local.json --spec api.json --apply
2server update app api -f server.local.json --spec api.json --apply
2server scale app api -f server.local.json --replicas 3 --apply
2server get-log app api -f server.local.json --tail 200
2server reload app api -f server.local.json --apply
2server rollback app api -f server.local.json --apply
2server get monitor -f server.local.json
```

Create/update specs are complete JSON resource objects using `src/config.ts`;
app/domain specs include a matching `name`. Successful create/update/scale/delete
operations atomically update the local manifest with mode 0600. Concurrent edits
are rejected rather than overwritten. Omit `--apply` to validate and describe
intent without changing the VM. A dry run does not resolve secrets or guarantee
remote readiness. Read commands do not require `--apply`. `get app/domain/extension`
shows desired configuration; `get pod`, `get vm`, `get disk NAME` and `get monitor`
inspect observed state. App env values are omitted. Logs are bounded to 100 lines
per container by default (`--tail 1..10000`).

`replicas` defaults to 1 and accepts 0..32. Each service replica must pass its
readiness probe before Caddy receives the complete upstream list. Zero replicas
serve 503 and preserve the app contract. Scale/reload needs capacity for both
generations. Worker replicas must support concurrent consumers; a worker rollout
stops the previous generation first. Rollback uses the saved replica count,
image and readiness contract, and the resource command updates the manifest.

This is not a Kubernetes scheduler. `create pod APP` adds one replica;
`update pod CONTAINER` and `reload pod CONTAINER` replace the owning app generation;
`delete pod CONTAINER` scales the owner down by one, replacing its generation so
Caddy cannot retain a deleted upstream. Only active, declared app pods can be
mutated. Legacy unlabelled containers appear through the original `status`
command; redeploy an app through 2server to manage its pods by ownership labels.

Retire or reroute domains before deleting an app or image proxy. Domain deletion
checks ownership, removes DNS and only its cache rules, waits 300 seconds for DNS
drain, then removes its Caddy site atomically. A failure may leave partial provider
changes: inspect and retry the same deletion while retaining the manifest entry.
Certificates and private releases remain available for recovery. Monitoring
removal retires its generated domain too. Removing a JSON entry by hand is not
an uninstall operation.

Domain creation/update can publish DNS before public verification sees it. If
verification fails, inspect DNS and origin health, allow resolver caches to expire,
then retry the same command. It reuses the owned DNS, certificate and cache rule,
and saves the manifest only after successful verification. Retain every other
managed domain in that manifest during recovery.

```bash
2server create domain reader -f server.local.json --spec domain.json --apply
2server delete domain reader -f server.local.json --apply
2server delete app api -f server.local.json --apply
2server stop vm -f server.local.json --apply
2server start vm -f server.local.json --apply
2server create vm gcp -f /absolute/private/server.tfvars --apply
2server update vm gcp -f /absolute/private/server.tfvars --apply
2server delete vm gcp -f /absolute/private/server.tfvars  # review destroy plan
```

AWS start/stop/get needs `vm: {"kind":"aws","region":"ap-southeast-1",
"instanceId":"i-…"}` as well as the separate `ssh` object. Terraform now outputs
that identity. Direct SSH alone cannot prove provider power state.
`reload vm` performs a graceful stop/start. `get-log vm` reads bounded current-boot
journal entries. `scale vm gcp|aws -f original.tfvars` applies the updated machine
type through Terraform; stop the VM first when the provider requires it.
VM deletion destroys the isolated Terraform root, not just its manifest entry.
Default cloud deletion protection prevents it. For an authorized retirement,
first apply `allow_destroy = true` using the original tfvars/state, then review
the destroy plan. Separate data disks retain Terraform `prevent_destroy`; a root
with those disks requires a deliberate data/state retention procedure before
it can be destroyed. Never discard state or remove protection merely to make a
plan succeed.

## PostgreSQL, Redis and NATS

See [the stateful manifest](examples/stateful.json). Extensions create separate
Compose projects, bounded CPU/memory/logs, private root-only configuration and
persistent data paths. No database or broker port is published on the host.
Apps on the edge Docker network connect to `two-<manifest>-postgres:5432`,
`two-<manifest>-redis:6379`, or `two-<manifest>-nats:4222` with credentials from
secret references. Use SSH tunnelling or a temporary network-attached client for
operator access; these extensions do not publish Cloudflare HTTP domains.
Compose service names use the same prefix, keeping generic `postgres`, `redis`
and `nats` DNS aliases available to existing services on the shared network.
Upgrading an older extension recreates its owned container with the new service
name while preserving its data directory.

PostgreSQL defaults to **18.6**, the current stable release verified against the
[upstream version table](https://www.postgresql.org/support/versioning/). Major
versions are pinned to 18; upgrading a major requires a separate migration.
The [official image](https://hub.docker.com/_/postgres) uses `/var/lib/postgresql`
for its persistent mount on version 18. Host connections use SCRAM authentication.
The configured database/user/password initialize a fresh cluster; changing those
fields does not migrate an existing database or rotate its role password.

Redis uses authenticated standalone Redis 8.2, AOF with `appendfsync everysec`,
and `noeviction`. `maxmemoryMb` must leave at least 25% of container RAM for
process/AOF overhead. Sentinel is not included: this single-VM product cannot
provide host-level HA. NATS uses authenticated Core messaging by default; set
`jetstream: true` for file-backed persistence with explicit memory/storage limits.
Its monitoring endpoint binds to loopback inside its container. JetStream remains
single-node; Core messages are transient. See [NATS configuration](https://docs.nats.io/reference/config/).

```bash
2server create extension postgres -f server.local.json --spec postgres.json --apply
2server create extension redis -f server.local.json --spec redis.json --apply
2server create extension nats -f server.local.json --spec nats.json --apply
2server reload extension redis -f server.local.json --apply
2server delete extension postgres -f server.local.json --apply
```

Secrets (`passwordEnv` / `tokenEnv`) belong in the ignored product `.env` or CI
secret environment, require at least 20 single-line characters, and never enter
Compose command arguments. Service removal retains data. Reload/update may
restart a stateful service; clients need reconnection handling. Data paths cannot
be changed silently, and nonempty unowned data directories are rejected.

### Automatic PostgreSQL backups and restore

For managed GCS backups, add this policy to the server manifest. Its top-level
`name` is the server identity; it can differ from `ssh.instance` on an adopted VM.

```json
{
  "name": "reader",
  "backupStorage": {
    "kind": "gcs",
    "storageClass": "STANDARD",
    "schedule": "*-*-* 00/12:00:00 UTC",
    "retentionDays": 7
  }
}
```

The bucket is `<gcp-project>-<vm-region>-<server-name>-2server-backup`.
The project comes from `ssh.project`; the region is derived from `ssh.zone`, so
storage stays in the VM's region. `get backup-storage` shows the resolved policy.
Creation/update plans a separate Terraform root containing only the bucket and
object create/read grants for the VM's actual service account. It supports an
existing VM without importing or changing that VM's Terraform state.

```bash
2server get backup-storage -f server.local.json
2server create backup-storage -f server.local.json          # inspect Terraform plan
2server create backup-storage -f server.local.json --apply
2server update backup-storage -f server.local.json --apply  # apply a policy edit
```

Defaults are Standard, every **12 hours UTC** and **7 days** of retention. Change
`schedule` (systemd calendar, e.g. `*-*-* 00:00:00 UTC` for once daily) and `retentionDays`
independently. The timer allows up to five minutes of randomized delay. Objects
become eligible for asynchronous GCS lifecycle deletion at the configured age;
soft delete is disabled on this dedicated bucket, so deletion is final. Terraform
protects the bucket itself from destruction. Standard has no minimum storage
duration or retrieval fee and is the cheapest class for this seven-day full-backup
policy in Singapore. Other classes remain configurable, but compare their total
bill including early deletion: Nearline, Coldline and Archive have [minimum
storage durations of 30, 90 and 365 days](https://cloud.google.com/storage/pricing).
Changing the bucket's default class affects new uploads; existing objects keep
their class unless explicitly rewritten.

After changing the schedule, run `reload extension postgres -f server.local.json
--apply` to install the new timer. Apply retention changes with `update
backup-storage -f server.local.json --apply`.

Example `postgres.json` inheriting that policy:

```json
{
  "database": "app",
  "username": "app",
  "passwordEnv": "POSTGRES_PASSWORD",
  "memoryMb": 512,
  "backup": {}
}
```

With `backup: {}`, PostgreSQL deployment provisions the configured storage and
uses `gs://<derived-bucket>/postgres`. A per-extension `backup.schedule` overrides
the server schedule. Configuring storage alone does not install a database or
enable a backup timer: PostgreSQL deployment performs the first verified backup.

For an external bucket, set `backup.destination` explicitly. For S3 use
`s3://your-bucket/postgres` and add `"region":"ap-southeast-1"`. External buckets
must already exist. Transfers run in a bounded rclone
container using VM identity (GCP metadata or EC2 instance role), not operator
credentials or static keys. Terraform's optional `backup_bucket` input grants
object create/read access on GCP, or scoped S3 read/write access on AWS. For an
adopted VM, grant those permissions to its existing identity. S3 buckets using
customer-managed KMS keys also require the corresponding KMS permissions.
GCS transfers use bucket IAM without object ACLs, including buckets with uniform
bucket-level access enabled.

Deployment completes an initial backup before enabling a persistent systemd
timer. Each run creates a custom-format `pg_dump`, validates its archive table,
uploads it with a unique timestamp/UUID, then uploads its SHA-256 completion file.
Temporary local files are removed; keep enough free VM disk for the dump/restore.
External-bucket lifecycle, retention, versioning and encryption policies remain
under the bucket owner's control. Managed buckets expire backups using the
configured GCS lifecycle policy; the backup script itself never deletes objects. A failed upload
never records a successful backup. Inspect `get monitor` and the backup service
journal; this release does not send backup-failure alerts automatically.

```bash
2server backup postgres -f server.local.json --apply
# Use the printed timestamp/UUID, without the .dump suffix:
2server restore postgres -f server.local.json --id BACKUP_ID --database restored_app --apply
```

Restore downloads from the configured prefix, checks the checksum and archive
before creating a **new** database, and uses `pg_restore --single-transaction
--exit-on-error --no-owner --no-acl`. An existing database is never overwritten.
Verify rows, constraints, sequences and app queries before switching clients.
These are single-database backups, not global roles, WAL/PITR or full VM recovery.
Only restore trusted archives; SQL in a backup runs with database privileges.

### Separate persistent disks

Both Terraform roots accept `data_disks`, e.g. GCP
`data_disks = { database = { size_gb = 30 } }`, or AWS
`data_disks = { database = { size_gb = 30, device = "/dev/sdf" } }`.
Copy the resulting `data_disks` values into the manifest's `disks` array.
AWS device verification uses EBS NVMe serial IDs on Nitro instances.

```bash
2server get disk database -f server.local.json
2server create disk database -f server.local.json --apply
2server resize disk database -f server.local.json --size-gb 100 --apply
```

`create disk` initializes an **empty, already attached, non-boot** provider disk
as whole-disk ext4 and persists its UUID mount in fstab. It rejects existing
filesystems, partitions and mount contents. New cloud disks are provisioned by
Terraform. Set PostgreSQL `"disk":"database"` and
`"dataPath":"/mnt/database/postgres"` to require that mount before startup.

`resize disk` validates provider attachment and device identity, refuses
shrinking, grows the cloud volume, waits for the guest to see it, then grows
ext4/XFS. It never reformats. If provider growth succeeds but guest growth times
out, retry the same size after inspection. Update the original Terraform disk
size to match. Root disks, partitioned layouts, LVM and encrypted device stacks
need a separate adapter and are rejected by these commands.

### Development verification

```bash
bun run check
DOCKER_TESTS=1 bun test tests/runtime.test.ts tests/stateful-runtime.test.ts
# Terraform >= 1.7 is required for mock-provider tests (1.9.8 verified):
TERRAFORM_BIN=terraform scripts/test-terraform.sh
```

Docker tests use isolated local resources and delete only their own volumes.
The PostgreSQL integration exercises real dump/restore with a local substitute
for cloud object transfers. Terraform tests use mocked providers in temporary
roots; they create no cloud resources. Live bucket IAM and provider disk resizing
still need a staging check for the target account, VM and storage configuration.
