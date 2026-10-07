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

`2srv adopt app NAME --spec compose-app.json --apply` registers an existing
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

On an already published VM, save its private SSH connection in your application repo:

```sh
2srv connect --ssh ubuntu@vm.example --identity ~/.ssh/server_key
# GCP IAP: use --connection FILE with structured GCP SSH settings.
2srv app
```

Commands discover the nearest ignored `.2server/connection.yaml` and load current
config/secrets from the VM. Explicit `--ssh` / `--connection` also work. Independent
image-app deployments can overlap; shared infrastructure operations remain exclusive.
See [locking](locking.md) for resource reservations and snapshot conflict handling.

Use [control state and recovery](control-state.md) for first publication from a
legacy manifest, VM secret updates, encrypted backups, lock inspection and recovery
on a replacement VM. Terraform state and database/volume backups remain separate.

## Cloudflare access and ownership

The default credential is a scoped bearer API token in `CLOUDFLARE_API_TOKEN`.
Follow [Create a Cloudflare token](cloudflare-tokens.md) for the dashboard steps
and complete feature-specific Account/Zone permission and resource tables.
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

For an account-owned integration, create/edit the token under **Manage account →
Account API tokens**. Scope Account permissions to the target account and Zone
permissions to every managed zone, including monitoring's zone. Select
**Entire <account name> account** only when account-wide access is intended;
check the summary rather than assuming account selection grants zone access.
Email Routing and Workers/D1 need their own Account permissions in addition to
their Zone permissions. Ordinary VM domain deployment needs neither every
account permission nor token-administration access.
See [Cloudflare account-token setup](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/).

Missing or blank credentials cause a nonzero CLI exit with the exact variable
and setup instructions. After bootstrap, use `server env --env-file FILE --apply`
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
app rollback never changes their data. Use backward-compatible `spec.preDeploy`
migrations for source Apps; retain an existing external migration workflow only
for legacy adopted Apps.

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
2srv provision gcp /absolute/path/server.tfvars --output server.local.json
2srv provision gcp /absolute/path/server.tfvars --output server.local.json --apply
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

Domain presets keep authenticated responses private: `app` bypasses caching;
`images` permits anonymous GET/HEAD under `/i/`; `audio` permits them under `/a/`.
Origin TTL and `no-store` are respected, cookies/Authorization bypass caching,
query strings remain in cache keys, and other paths bypass. Rules preserve foreign
entries. Shared rate limits, WAF and optional Cache Rules use a `kind: Zone` file;
see [zone policy](source-config.md#cloudflare-zone-policy).

Use named template Apps for new installations:

```sh
2srv init app metrics --template monitoring -o platform/metrics.yaml
# Edit the zone/hostname and prepare declared secrets before deployment.
2srv plan -f platform/metrics.yaml
2srv deploy -f platform/metrics.yaml --apply
2srv app metrics help
```

Monitoring waits for component readiness before publishing its authenticated
Cloudflare domain. Anonymous and wrong-password requests must fail; authenticated
requests must succeed. Credentials are private VM state; the CLI reports locations,
never passwords. Declare `passwordEnv` to supply your own secret and reapply after
rotation. Installed Apps and sidecars are discovered each minute without reloading
monitoring. Outbound alerts require an enabled receiver; whole-VM outages require
an external monitor with notifications. See [reliability](reliability.md).

The `image-proxy` template runs signed imgproxy with HTTPS source restrictions and
private-network blocking. It does not replace existing proxy URL contracts.
Removing a template from a manifest does not uninstall it. Use scoped retirement;
see [template operations](../skills/2server/references/extensions.md).
Legacy `extensions.monitoring` and `extensions.imageProxy` remain supported.

## Single-VM availability

See [the reliability runbook](reliability.md) for continuous Caddy health
checks, app drain/stop settings, Redis/NATS durability, runtime alerts, failure
recovery and capacity. Two service replicas can survive one app process failure
while the VM remains available. Defaults do not silently increase replica count.
This is not host-level HA; stateful services and monitoring still share one VM.

## Advanced and legacy operations

Use `bun src/cli.ts` directly, or run `bun link` in this checkout to install the
`2srv` command (with `2server` as an alias). Use `app NAME OPERATION` for everyday app work. `help legacy` lists older
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
2srv get app -f server.local.json
2srv get pod -f server.local.json
2srv create app api -f server.local.json --spec api.json --apply
2srv update app api -f server.local.json --spec api.json --apply
2srv scale app api -f server.local.json --replicas 3 --apply
2srv get-log app api -f server.local.json --tail 200
2srv reload app api -f server.local.json --apply
2srv rollback app api -f server.local.json --apply
2srv get monitor -f server.local.json
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
2srv create domain reader -f server.local.json --spec domain.json --apply
2srv delete domain reader -f server.local.json --apply
2srv delete app api -f server.local.json --apply
2srv stop vm -f server.local.json --apply
2srv start vm -f server.local.json --apply
2srv create vm gcp -f /absolute/private/server.tfvars --apply
2srv update vm gcp -f /absolute/private/server.tfvars --apply
2srv delete vm gcp -f /absolute/private/server.tfvars  # review destroy plan
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

For new services, use named App templates and [instance bindings](source-config.md#apps-from-templates).
Each instance has private configuration, isolated persistent paths and resource
limits; database/broker ports are not published. Use the selected App's output
bindings rather than guessing singleton DNS names. Legacy whole-server settings
remain documented in the [stateful example](../examples/stateful.json).

- PostgreSQL separates application, migration and admin credentials. Major version
  changes require a migration; unknown existing data directories are refused.
  Follow [PostgreSQL operations](postgres.md) for configuration, roles and recovery.
- Redis uses authenticated standalone mode with AOF and no eviction. Leave memory
  for rewrite/process overhead; [reliability](reliability.md#redis) covers durability.
- NATS Core is transient; JetStream provides file-backed persistence when explicitly
  configured. Apps own stream limits, acknowledgements and safe redelivery.
  See [reliability](reliability.md#nats).

Secret values are app-scoped VM state; native `*Env` fields reference the App's
secret map. Removal retains data. Updates may restart a stateful service, so
clients must reconnect. Data paths and role identities do not change implicitly.
Legacy `create/reload/delete extension` commands remain compatibility operations;
use `2srv help legacy` to discover them.

### Automatic PostgreSQL backups and restore

Backups are opt-in. Configure the selected PostgreSQL App's `backup` spec and
follow [the recovery runbook](postgres.md#backup-configuration) for pgBackRest,
WAL retention, permissions and isolated restore drills. Storage alone does not
back up a database or Cloud SQL.

Managed GCS storage uses a separate bucket-only Terraform root and the VM's actual
service account; it does not adopt the VM's compute resources. Example server policy:

```json
{
  "backupStorage": {
    "kind": "gcs",
    "storageClass": "STANDARD",
    "schedule": "*-*-* 00/12:00:00 UTC",
    "retentionDays": 7
  }
}
```

The derived bucket is `<ssh.project>-<region-from-ssh.zone>-<server-name>-2server-backup`.
The server name may differ from `ssh.instance`. Inspect and apply the storage policy:

```sh
2srv get backup-storage -f server.local.json
2srv create backup-storage -f server.local.json
2srv create backup-storage -f server.local.json --apply
2srv update backup-storage -f server.local.json --apply
```

Defaults are Standard, 12-hour scheduling and a seven-day recovery window. The
timer has up to five minutes of randomized delay. GCS lifecycle expiry covers
logical dumps only; pgBackRest owns physical backup/WAL expiry and may retain
older base files needed for the recovery window. Independent age deletion must
exclude a physical repository. Bucket destruction is protected; dump soft delete
is disabled. Changing the default storage class affects only new objects.

After changing policy, update storage and redeploy the PostgreSQL App to refresh
its timer/pgBackRest settings. Use `2srv app orders-db help` for installed backup
and restore commands. A physical restore creates an isolated read-only target,
never overwrites the live cluster and never switches apps. Backup health and a
successful restore drill are separate from container readiness.

Read replicas and automatic failover are not shipped; see [roadmap](roadmap.md#read-replicas).

### Separate persistent disks

Both Terraform roots accept `data_disks`, e.g. GCP
`data_disks = { database = { size_gb = 30 } }`, or AWS
`data_disks = { database = { size_gb = 30, device = "/dev/sdf" } }`.
Copy the resulting `data_disks` values into the manifest's `disks` array.
AWS device verification uses EBS NVMe serial IDs on Nitro instances.

```bash
2srv get disk database -f server.local.json
2srv create disk database -f server.local.json --apply
2srv resize disk database -f server.local.json --size-gb 100 --apply
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

Configure the selected monitoring App's `webhooks` with a named Discord receiver
and a `urlEnv` reference to its app-scoped VM secret. Native Alertmanager sends
firing/resolved notifications; without an enabled receiver, alerts stay local.

```sh
2srv app metrics help
2srv app metrics webhooks
# A notification test sends a real message and requires explicit apply.
2srv app metrics webhooks test discord --apply
```

Edit receiver configuration in the App file and redeploy; the named template
provides receiver listing and testing. Keep endpoint values in private
secret files, not argv or source. Legacy whole-server `extensions.webhooks` and
verb-first webhook commands remain supported. Follow [monitoring operations](../skills/2server/references/extensions.md#monitoring-and-images)
for receiver setup, failure diagnosis, retirement and observing existing Compose apps.
