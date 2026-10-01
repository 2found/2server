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
cp examples/server.json server.local.json
# Configure SSH, domains, app image digests and secret references.
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
migrations or data writes. Stateful databases and persistent application volumes
are outside this container lifecycle; use managed databases or independently
managed services. Run backward-compatible migrations through your app's existing
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
domain renewal and verification. A pre-existing unowned A record requires
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
