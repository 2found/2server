# Operator guide

Start with the [quick start](../README.md#quick-start). This reference covers
advanced operations and compatibility with whole-server manifests. For new
workloads, prefer named App files, including extension templates.

- [Adopt an existing Compose app](#adopt-an-existing-compose-app)
- [Work from any machine](#work-from-any-machine)
- [Cloudflare access and ownership](#cloudflare-access-and-ownership)
- [Applications](#applications)
- [Provisioning](#provisioning)
- [Cache and optional extensions](#cache-and-optional-extensions)
- [Single-VM availability](#single-vm-availability)
- [Advanced and legacy operations](#advanced-and-legacy-operations)
- [PostgreSQL, Redis and NATS](#postgresql-redis-and-nats)

## Adopt an existing Compose app

`2server adopt app NAME --spec compose-app.json --apply` registers an existing
blue/green Compose pair without recreating containers or changing its route.
The spec is an ordinary app spec with a `compose` object containing `project`,
`sourceFiles` (absolute VM paths, read only during adoption), `services` and
`containers` maps keyed by `blue`/`green`, `upstreamFile`, `upstreamName`, and
optionally `gateTimeoutSeconds` and `migrationRequired`.

The CLI captures the resolved Compose pair in root-only portable control state,
including env, named volumes and entrypoints. Future deploys use this snapshot,
not the original operator home. Existing networks/volumes remain external.
Active image identity comes from its registry digest. Adoption requires a healthy
routed instance and rejects host mounts, exposed ports, privileged services and
shared writable blue/green volumes. It does not adopt infrastructure sidecars.

Use `deploy app NAME --image repository@sha256:... --apply`, `reload app NAME`,
`rollback app NAME`, `get pod`, and `get-log app NAME`. Each rollout starts only
the inactive service, waits for readiness, switches Caddy and drains the prior
container. Rollback becomes available after the first successful CLI rollout;
pre-adoption parked containers are retained but not certified for rollback.
Compose pairs are fixed at one replica; use the native runtime for elastic
replicas. Route retirement/deletion remains an explicit operator action for
adopted legacy routes; the CLI does not infer ownership of undeclared Caddy sites.

Compose inputs use an allowlist of supported fields. Host namespaces, lifecycle
hooks, devices and unknown future fields are rejected. Each new candidate drops
all capabilities, sets `no-new-privileges`, and bounds PIDs/logs even when an
older adopted template omitted these options. Review compatibility before
adopting an existing app: a later rollout applies this restricted baseline.

Set `compose.migrationRequired: true` for apps whose schema migrations run in
their release workflow. New image deploys require `--migrations-applied` after
that workflow succeeds; same-image reloads need no migration. The CLI does not
invent schema changes. Preserve application build arguments and migration steps
in release wrappers. Refresh the encrypted server backup after adoption/deploy.
Restoring a Compose app also needs its original Caddy route files and named-volume
data; a control-state snapshot alone is not a full-server restore.

## Work from any machine

The VM can own the full manifest, referenced secrets and certificate/monitoring
state. Publish an existing setup once, then connect from any operator machine:

```bash
2server server publish -f server.local.json --env-file .env --apply
2server connect --ssh ubuntu@vm.example --identity ~/.ssh/server_key
# GCP IAP: use connect --connection connection.json (the structured ssh object).
2server get app
2server deploy app api --image registry.example/api@sha256:<digest> --apply
2server domains --apply
```

`connect` saves only SSH settings to the current project's ignored
`.2server/connection.yaml`. Commands discover it from the working directory upwards.
Explicit `--ssh` / `--connection` also work without any local profile. Every command
fetches the current config/secrets from the VM; successful mutations save them
back atomically. The CLI uses a private temporary workspace. Independent image-app deployments use separate resource locks; only shared
infrastructure operations take the server-wide lock. Snapshot commits merge
concurrent changes atomically. Reads and plans take no operation lock and do not
create revisions or history. See [locking boundaries](locking.md).
Cloud login/SSH identity still belongs to the operator; explicit cloud Secret
Manager references require that provider identity. Environment-based app secrets
are portable with the VM snapshot.

Use `server env --env-file secrets.env --apply` for referenced secret updates,
and `server backup --output .2server/server.age --recipient-file recipients.txt`
for an encrypted off-VM backup. See [configuration, machine switching and recovery](control-state.md)
for publication, CI, locks, security boundaries and replacement-VM recovery.
Terraform state and database/volume backups remain separate recovery assets.

For a stuck VM control lock, run `2server server lock` to inspect its `lockId`
and owner. After confirming the previous operation stopped, run
`2server server unlock --lock-id <lockId> --apply`. This archives only the
inspected lock with a break audit; it refuses a replacement lock and does not
cancel work already running.

## Cloudflare access and ownership

The default credential is a scoped bearer API token in `CLOUDFLARE_API_TOKEN`.
Before initial publication (or in legacy local mode), keep infrastructure credentials in this checkout's ignored `.env`, using
[.env.example](../.env.example) as the template. Bun loads it automatically when
commands run from the 2server directory. Do not store these credentials in
unrelated app or QA configuration. CI can supply the same variables through
its secret store. Keep `.env` owner-readable/writable only (`chmod 600 .env`).
Use zone-level Zone Read, DNS Edit, Zone Settings Edit, Cache Rules/Cache Settings
Write, and SSL and Certificates Edit, limited to the managed zones.
A separate bearer token for certificate issuance can be selected through
`cloudflare.originTokenEnv`. A Global API Key or Origin CA service key is not
a bearer token; create a scoped API token instead. Publishing VM-owned config stores referenced tokens in the root-only control directory.
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
With VM-owned config this portable state is fetched and saved per command;
legacy local mode still needs persistent private operator state. Back up the
configuration encrypted and rerun `domains --apply` weekly. It reissues a certificate with fewer than
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
and setup instructions. After bootstrap, use `secret set --env-file FILE --apply`
to update the VM credential; local `.env` is never a connected-mode fallback. HTTP 401/403 errors identify the operation and relevant
permission, and remind you to check account/zone resource scope and token expiry.
An exported shell variable takes precedence over `.env`; update or unset a stale
export before retrying. The CLI does not alter token policies automatically.

## Applications

Use [source App files](source-config.md); tags are resolved to immutable
digests on plan/deploy. The legacy whole-server flow (`setup`, `deploy`,
`extensions`, `domains`) remains available for existing operator manifests.

Legacy manifests require an immutable `repository@sha256:…` image, internal port, readiness
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

After setup, bridge-network workloads cannot reach the VM metadata HTTP API
unless their App declares `spec.labels.cloud-metadata: allow`. This grants access to the
VM's shared cloud identity, not an identity isolated to that app. Use it only
for trusted workloads with cloud API dependencies, with resource-scoped IAM.
The firewall matches the host veth and source address, so recycled IPs do not
inherit permission. It is installed before Docker starts at boot, refreshed
after rollouts and every five seconds. Cloud clients must tolerate the short
startup admission delay. Metadata DNS, host processes and host-network backup
jobs retain their existing access. Docker administrators remain root-equivalent.

Before setup on an existing server, declare metadata needs in its App files and
VM state. A root-only `/opt/2server/security/metadata-allow.json` array may name
existing unlabelled containers until their next rollout. Explicit `deny` labels
override this migration list. Setup preserves unrelated firewall rules.

To build, push and deploy one app from an existing Dockerfile:

```bash
scripts/release.sh api/2server/deploy.yaml ghcr.io/your-org/api:release ./api
```

The script deploys the digest returned by Buildx via the selected source App file;
the file itself is not rewritten.
It does not guess an application's build args. The [CI example](../examples/ci/deploy.yml)
uses a trusted runner with VM-owned state, pinned actions,
serialized releases and an explicit selected-file workflow. Schedule weekly
`domains --apply` renewal separately; the example has no renewal job. Configure its
SSH identity and production environment before enabling it; connected domain
commands load Cloudflare secrets from the VM.

## Provisioning

```bash
2server provision gcp /absolute/path/server.tfvars --output server.local.json
2server provision gcp /absolute/path/server.tfvars --output server.local.json --apply
# AWS: provision aws ... --output server.local.json --ssh-user ubuntu
# Choose the SSH user from the actual AMI; use a key agent or SSH config.
```

`--output` exports name, SSH, origin IP, provider identity and data disks from
the applied Terraform outputs into a mode-0600 bootstrap manifest. It never
overwrites a file and writes nothing during plan. Private key paths can be set
in the generated manifest before bootstrap. Without `--output`, provisioning
retains its existing behavior. Back up the printed Terraform state path.

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

GCP `workload_access` defaults to no permissions. It accepts individual secret
IDs, a bucket-to-object-role map, Artifact Registry repositories, Pub/Sub topics
and subscriptions, and optional `sign_blobs_as_self`. The latter grants Token
Creator on this service account only, never on the project. The reusable
`terraform/gcp/access` module can manage scoped grants for an existing VM without
adopting its compute resources. Migrating an existing identity requires granting
these permissions first, verifying workload access, then explicitly removing
old project-wide grants. Adding narrow grants alone does not revoke broad ones.

Web ingress defaults to the [Cloudflare IPv4 ranges](https://www.cloudflare.com/ips-v4/),
with `web_cidrs` available for an explicit non-world-open override. A targeted
deny rule prevents lower-priority permissive rules from reopening ingress.
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
exporter and scrape-target, CPU, disk and memory alerts. Total configured memory ceiling
is 448 MB. Add named [Discord webhooks](#discord-alerts) or `alertWebhookEnv`
(an Alertmanager-compatible HTTPS receiver secret reference) to enable a 64 MB
Alertmanager. Without an enabled receiver, alerts are visible in Prometheus but
are not delivered externally. The UI
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
is lost: configure an external uptime check with an alert policy and notification
channel; a check alone does not send alerts.

On connected VMs, the runtime collector automatically follows active apps and
all installed template containers, including image-proxy and monitoring
sidecars. Adding/removing an App updates coverage on the next one-minute
collection without reloading monitoring. Missing/unhealthy containers, app
readiness, restarts and OOM have default alerts; Redis/NATS/PostgreSQL contribute
service-specific metrics. CPU above 90% for ten minutes also alerts. See the
[monitoring coverage and limits](reliability.md#monitoring-and-operational-checks).

Jaeger is optional future tracing, not required for host health. Its embedded
[Badger backend](https://www.jaegertracing.io/docs/2.dev/storage/badger/) fits modest
single-node trace workloads but needs app instrumentation and adds storage/CPU.
Prometheus retention is bounded, not a strict total-disk quota: WAL/head storage
needs additional headroom. [Prometheus storage documentation](https://prometheus.io/docs/prometheus/latest/storage/).

## Single-VM availability

See [the reliability runbook](reliability.md) for continuous Caddy health
checks, app drain/stop settings, Redis/NATS durability, runtime alerts, failure
recovery and capacity. Two service replicas can survive one app process failure
while the VM remains available. Defaults do not silently increase replica count.
This is not host-level HA; stateful services and monitoring still share one VM.

## Advanced and legacy operations

Use `bun src/cli.ts` directly, or run `bun link` in this checkout to install the
`2server` command. Use `app NAME OPERATION` for everyday app work. `help legacy` lists older
resource/provider commands; verb-first forms such as `get app` remain compatible.
The original manifest-oriented commands remain compatible. Use one full manifest
per VM; resource commands use the discovered `.2server/connection.yaml`, an explicit
`--ssh` / `--connection`, or legacy `-f server.local.json`.

| Resource | Operations | Meaning |
| --- | --- | --- |
| `app` (`service`) | get, describe, create, update, delete, reload, rollback, logs/get-log, scale | Desired app spec and healthy blue/green generations |
| `pod` (`workload`, `instance`) | get, describe, create, update, delete, reload, logs/get-log | A managed Docker container; operations reconcile its owning app |
| `domain` | get, describe, create, update, delete, reload | Cloudflare DNS/cache, certificates and Caddy routes |
| `vm` | get, describe, start, stop, reload, logs; create/update/delete/scale with provider + tfvars | Provider lifecycle; Terraform for resource CRUD |
| `extension` | legacy create/update/get/delete | Prefer named template Apps above |
| `disk` | get, describe, create, resize | Initialize an empty attached disk or grow an existing filesystem |
| `monitor` | get, describe | Host memory/load/filesystems, container usage and last backup result |
| `webhook` | get, describe, create, update, delete, test | Named Discord alert targets; test sends one message |
| installed PostgreSQL app | `app NAME help` | Backup and isolated recovery commands supplied by PostgreSQL |
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

Create/update specs are complete JSON resource objects using `src/modules/config/application/config.ts`;
app/domain specs include a matching `name`. Successful create/update/scale/delete
operations atomically update the VM snapshot in connected mode, or the local
manifest with mode 0600 in legacy mode. Concurrent edits
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

See [the stateful manifest](../examples/stateful.json). Extensions create separate
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
Fresh clusters separate application DML, migration ownership and administration
with three distinct secrets. New installations create this layout automatically.
Unrecognized existing data directories are rejected. See the
[PostgreSQL runbook](postgres.md) for roles, monitoring and recovery.

Redis uses authenticated standalone Redis 8.2, AOF with `appendfsync everysec`,
and `noeviction`. `appendfsync` also accepts `always`. `maxmemoryMb` must leave
at least 50% of container RAM for process overhead and AOF rewrite. Sentinel is not included: this single-VM product cannot
provide host-level HA. NATS uses authenticated Core messaging by default; set
`jetstream: true` for file-backed persistence with explicit memory/storage limits.
JetStream defaults to `syncInterval: "always"` for explicit disk durability;
fsync throughput depends on the disk. Its monitoring endpoint binds to loopback
inside its container. JetStream remains
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
object access grants for the VM's actual service account. It supports an
existing VM without importing or changing that VM's Terraform state.

```bash
2server get backup-storage -f server.local.json
2server create backup-storage -f server.local.json          # inspect Terraform plan
2server create backup-storage -f server.local.json --apply
2server update backup-storage -f server.local.json --apply  # apply a policy edit
```

Defaults are Standard, every **12 hours UTC** and **7 days** of retention. Change
`schedule` (systemd calendar, e.g. `*-*-* 00:00:00 UTC` for once daily) and `retentionDays`
independently. The timer allows up to five minutes of randomized delay. Logical
dump objects
become eligible for asynchronous GCS lifecycle deletion at the configured age;
soft delete is disabled on this dedicated bucket, so deletion is final. Terraform
protects the bucket itself from destruction. Standard has no minimum storage
duration or retrieval fee and is the cheapest class for this seven-day full-backup
policy in Singapore; physical-backup costs also depend on WAL volume and the
retained base backups. Other classes remain configurable, but compare their total
bill including early deletion: Nearline, Coldline and Archive have [minimum
storage durations of 30, 90 and 365 days](https://cloud.google.com/storage/pricing).
Changing the bucket's default class affects new uploads; existing objects keep
their class unless explicitly rewritten.

After changing the schedule, run `reload extension postgres -f server.local.json
--apply` to install the new timer. Apply retention changes with `update
backup-storage -f server.local.json --apply`, then reload PostgreSQL to update
its pgBackRest retention configuration.

Example `postgres.json` inheriting that policy:

```json
{
  "database": "app",
  "username": "app",
  "passwordEnv": "POSTGRES_PASSWORD",
  "adminPasswordEnv": "POSTGRES_ADMIN_PASSWORD",
  "migrationPasswordEnv": "POSTGRES_MIGRATION_PASSWORD",
  "memoryMb": 512,
  "backup": {}
}
```

With `backup: {}`, deployment enables **pgBackRest** full/differential backups
and continuous WAL archiving, using `gs://<derived-bucket>/pgbackrest/<server-name>`.
It performs an initial backup and isolated restore drill. Default backups run
12-hourly, with a full backup when the last full is at least 24 hours old;
other runs are differential. Restore drills run weekly. The database container
builds a pinned pgBackRest package on the PostgreSQL 18 Bookworm image.

**Seven days is a recovery window, not an age limit on every physical file.**
pgBackRest retains the older base backup and WAL needed to recover that window.
Managed GCS age deletion applies only to the `postgres/` dump prefix;
pgBackRest owns expiry under its own prefix. Apply the storage policy update
before using an older bucket for PITR. Storage permissions add overwrite/delete
only within this server's pgBackRest repository. A missing backup configuration
still means no backup timer; storage configuration alone does not back up Cloud SQL.

For an existing external bucket, set `backup.destination` to an exclusive
`gs://bucket/pgbackrest/server` or `s3://bucket/pgbackrest/server` prefix; S3 also
requires `backup.region`. VM identity must have list/read/create/overwrite/delete
access to that repository, and its objects must be excluded from independent
age-deletion policies. See the [runbook](postgres.md) for credentials,
capacity, alerts, optional dump recovery and credential management.

```bash
2server get postgres -f server.local.json
2server app postgres backup -f server.local.json --apply
2server app postgres check-backup -f server.local.json --apply
2server app postgres restore -f server.local.json --recovery inspect \
  --target-time 2026-10-02T00:00:00Z --apply
2server app postgres recoveries -f server.local.json
2server app postgres remove-recovery --recovery inspect -f server.local.json --apply
```

Physical restore creates a separate volume and read-only instance with no TCP
listener; it never overwrites the live cluster or switches applications. Omitting
`--target-time` recovers to consistency at the end of the selected backup.
`backup.engine: "dump"` retains the former single-database logical backup path;
`app NAME restore --id BACKUP_ID --database NEW_DB` restores those archives.

Database, WAL, failed/overdue backup and restore-drill alerts feed the monitoring
extension. Reload existing monitoring to install the rules and metrics mount;
configure `alertWebhookEnv` for outbound notification delivery. These protections
remain **single-VM**, without automatic failover. The
[read-replica design](read-replicas.md) describes a future easy setup flow;
it is research, not a deployed feature.

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

### Discord alerts

Monitoring supports named Discord incoming webhooks. Store the URL in the
ignored `.env` as `DISCORD_WEBHOOK_URL` (mode 0600), and add:

```json
{"extensions":{"monitoring":true,"webhooks":[{"name":"discord","provider":"discord","urlEnv":"DISCORD_WEBHOOK_URL","enabled":true,"sendResolved":true}]}}
```

For installed monitoring, use `create|update webhook NAME -f server.local.json
--spec webhook.json --apply`, `get webhook`, `delete webhook NAME`, or
`test webhook NAME --apply`. The spec is one object from the array above.
All commands need `-f server.local.json`; mutations require `--apply`. Test sends
one message from your machine and returns Discord's message ID. Configuration
uses native Alertmanager Discord notifications for firing/resolved alerts.
See [the operator workflow](../skills/2server/references/extensions.md#monitoring-and-images)
for secret setup, failure handling, removal and observing existing Compose apps.
