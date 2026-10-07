# Source configuration and VM state

Use one reviewed YAML or JSON document per application or shared extension.
The schema version is `2server.app/v1`. Unknown fields and unsupported versions
fail validation. One App file contains its complete desired configuration.
Environment variables in YAML are literal;
there is no shell interpolation or automatic local `.env` substitution.

```text
api/2server/deploy.yaml
web/2server/deploy.yaml
platform/redis.yaml
platform/postgres.yaml
platform/nats.yaml
platform/monitoring.yaml
.2server/connection.yaml    # gitignored; private per operator
```

```bash
2server validate -f api/2server/deploy.yaml
2server plan -f api/2server/deploy.yaml
2server deploy -f api/2server/deploy.yaml --apply
2server deploy -f api/2server/deploy.yaml --image registry/api:latest --apply
2server get -f api/2server/deploy.yaml
2server rollback -f api/2server/deploy.yaml --apply
2server delete -f platform/redis.yaml --apply
```

`apply` and `deploy` reconcile one file. Without `--apply`, they validate and
show a plan. App and Domain plans inspect Cloudflare DNS ownership, conflicts,
TLS and cache policy before rollout; they do not issue certificates or test write
permissions. Plans contact the VM and may pull registry image layers to resolve
a tag; they do not change workloads. `--image` is optional and overrides only
that execution. The source file is never rewritten by deployment.

`--connection FILE` is optional. Discovery searches upwards from the current
working directory for the nearest `.2server/connection.yaml`; legacy
`connection.json` is supported. Connection files use the existing SSH object
(`kind: ssh` or `kind: gcp`). A relative SSH identity path resolves relative to
its connection file. `connect --ssh user@host` writes a private, ignored YAML
connection. Different users can connect to the same fixed root-owned VM state.

Generate an editable App with its domain using `2server init app NAME -o app/2server/deploy.yaml`.
New VMs use the [bootstrap quick start](../README.md#quick-start).

## App document

```yaml
apiVersion: 2server.app/v1
kind: App
metadata:
  name: api
spec:
  image: registry.example.com/api:latest
  port: 8080
  healthPath: /readyz
  memoryMb: 512
  cpus: 1
  replicas: 1
  stopTimeoutSeconds: 60
  drainSeconds: 70
  env:
    NODE_ENV: production
  secrets:
    DATABASE_URL:
      provider: vm
      key: DATABASE_URL
```

The spec uses `src/modules/apps/domain/schema.ts:appSchema`, with a tag or digest allowed for image.
Defaults: service kind, one replica, `/healthz`, 60-second stop timeout,
70-second drain, empty env/secrets. Port, memory, CPU and image are required.
Workers require a healthCheck or Docker image HEALTHCHECK and use the existing worker strategy.
Services use CLI-managed blue-green; database extensions do not.

A file replaces the app's desired spec, rather than merging the VM's old spec.
Removing a public env or secret reference removes that runtime override on the
next deployment. Image-defined ENV defaults still apply. Secret *values* remain
on the VM independently, so a different source checkout can reference them.
Missing required fields or missing declared secret values fail deployment.

Optional top-level `requires` contains `{kind: App|Extension, name: ...}` entries;
missing dependencies fail rather than being silently installed. Optional
`domains` contains complete domain specs and is reconciled after the app is
healthy. Separate `kind: Domain` files are also supported. Domains are independent
resources: removing an entry does not delete DNS; explicitly delete its Domain
file to retire it. Domain failure after a healthy app rollout is reported as a
partial operation; the successful app state is retained.

### One manifest, generated runtime

This follows the [Kubernetes Deployment](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)
boundary: source declares the desired workload; the controller owns concrete
instances and their current/previous state. It is a 2server schema, not a Kubernetes
API or scheduler. Do not author Compose or Caddy files for an App.

The CLI generates restart policy, init, log rotation, resource limits, network
attachment and container isolation. `healthPath` is the HTTP readiness path used
before switching traffic and by Caddy. `progressDeadlineSeconds` (default 240,
maximum 3600) bounds candidate readiness. Adopted Compose apps require 20 seconds
of sustained readiness and another 20-second observation before commit.

Optional `healthCheck` declares a Docker exec health check:

```yaml
spec:
  healthCheck:
    command: [wget, --spider, -q, http://localhost:8080/readyz]
    intervalSeconds: 30
    timeoutSeconds: 5
    startPeriodSeconds: 60
    failureThreshold: 3
  volumeMounts:
    - name: data
      mountPath: /data
  instanceEnv:
    INGEST_DURABLE: 'app-consumer-${generation}'
```

Keep [readiness and liveness](https://kubernetes.io/docs/concepts/workloads/pods/probes/)
semantics separate: Docker health status alone does not restart an unhealthy
container. `labels: {autoheal: "true"}` opts into an **already installed** autoheal
service; 2server does not install one implicitly. Workers can supply `healthCheck`
or use an image HEALTHCHECK. `command` overrides image CMD, not ENTRYPOINT.
Omitting command/healthCheck removes the source override; image defaults apply.

`volumeMounts` declares a logical per-instance persistent volume, with optional
`readOnly`. There are no host binds. Instances use separate volumes; these are
not replicated storage. New volumes have server/app ownership labels. During
adoption, mounts bind by mount path to the VM's existing physical volumes; their
names are saved only on the VM. Missing adopted volumes fail instead of silently
creating empty data. Removing a mount never deletes its volume. Concurrent
writable generations cannot share the same physical volume.

`instanceEnv` is explicit public instance configuration; only `${generation}`
is substituted (`blue` or `green`). Ordinary `env` remains literal. These keys
cannot overlap env or secrets. Replica instances of the same generation share
this value, so use it for a consumer group, not a per-replica unique identifier.
Do not rename a stateful consumer or volume claim without reviewing its data
migration. Arbitrary `labels` are supported; CLI/Compose ownership labels are
reserved.

Existing adopted apps retain VM-owned project/container names and Caddy paths.
The new single-file form reads these identities from the latest VM snapshot and
replaces only the candidate service. All desired settings come from the current
source file; old public env, command, probes and mounts are not merged back.
The active generation stays unchanged for rollback. Different source versions
can use the same VM secrets and bindings with no local state synchronization.

Legacy `spec.compose` plus `runtimeFile` input remains readable for older
checkouts. Paths resolve relative to that manifest. New manifests should omit
both; do not export VM runtime templates (they can contain secret values).
Changing ownership bindings still requires explicit adoption/migration.

## Secrets

App files must use `provider: vm` references. The namespace is the app name,
including named template Apps. Template secrets are declared in the top-level
`secrets` map, matching its `passwordEnv`/`tokenEnv` etc. Server/provider credentials
and legacy singleton Extension files use the server namespace. Neither list nor
configuration export prints values.

```bash
# Private dotenv file; never commit it. Values are parsed, never sourced.
2server secret set --app api --env-file /private/api.env --apply
2server secret list --app api
2server secret delete --app api --key UNUSED_SECRET --apply

# Server/provider and legacy singleton extension credentials
2server secret set --env-file /private/platform.env --apply
2server secret list
```

`set` upserts supplied keys and retains others. `delete` refuses a key referenced
by the deployed configuration. Changing a value does not restart an app; deploy
its file to use the new value. Values cannot be passed as CLI arguments. Secrets
are stored root-only on the VM and included in encrypted `server backup` output.
The existing `server env` command remains supported; `--app NAME` selects the app
namespace. Local environment values never substitute for missing VM secrets.

## Apps from templates

Cloudflare email forwarding uses the `email-routing` template with an account,
zone and forwarding routes. It is managed directly in Cloudflare and creates no
VM installation; an optional `--connection` reads only its VM-owned API token.
See [email configuration](email-routing.md) for its source file and Free-plan limits.

```bash
2server init app cache --template redis -o platform/cache.yaml
2server secret set --app cache --env-file /private/cache.env --apply
2server deploy -f platform/cache.yaml --apply
2server app cache logs
2server app cache help
```

The source contract is `kind: App`, a user-chosen `metadata.name`, and `template`:

```yaml
apiVersion: 2server.app/v1
kind: App
metadata: {name: orders-db}
template: postgres
spec:
  passwordEnv: POSTGRES_PASSWORD
  adminPasswordEnv: POSTGRES_ADMIN_PASSWORD
  migrationPasswordEnv: POSTGRES_MIGRATION_PASSWORD
secrets:
  POSTGRES_PASSWORD: {provider: vm, key: POSTGRES_PASSWORD}
  POSTGRES_ADMIN_PASSWORD: {provider: vm, key: POSTGRES_ADMIN_PASSWORD}
  POSTGRES_MIGRATION_PASSWORD: {provider: vm, key: POSTGRES_MIGRATION_PASSWORD}
```

The template supplies its validated defaults and lifecycle. `spec` is the
selected template's schema. Values use `secret set --app orders-db`; the same
key names in another app are independent. `*Env` fields map to the top-level
secret references; references may use a different VM key. No local/global secret
fallback exists for a named template app. Optional `domains` works as for image
Apps, after a healthy rollout. Monitoring also contributes its own protected domain.

The VM records a template installation only after successful deploy. Generic
`app NAME get|deploy|logs|restart|delete` works for both image and template apps.
`app NAME help` adds only that installed template's commands. PostgreSQL supplies
backup/recovery; monitoring supplies `webhooks [test RECEIVER [--apply]]`.
Edit receiver definitions/references in the monitoring App file, then deploy it.

Data paths default to `/opt/2server/data/NAME`, and release state, container
names, secrets, timers and recovery targets use the instance name. Multiple apps
can use one template. Data path/disk/database/user changes and template switching
are refused for an installed instance; migrate explicitly. Deletion retains data.
Stateful apps do not use blue/green or traffic rollback; use their restore commands.

Legacy `kind: Extension` and `kind: Service` remain readable. Existing singleton
extensions keep their runtime names and global secret references; the new app
workflow does not silently adopt or move them. A one-off `Service` remains
available through advanced compatibility commands; prefer App templates for reuse.

## Images, concurrency and history

Every tag (including `latest`) is pulled from the registry on the VM for every
plan/apply, then pinned to the returned digest. Registry errors stop deployment;
there is no cached-tag fallback. Unchanged content-addressed layers can be reused.
Once resolved, that exact digest is used throughout the transaction. Extension
images preserve their tag alongside the digest for major-version checks.

Build scripts should pass the digest of their own build, not a shared latest tag.
Build/push stays in those scripts; declare VM-side migration tasks in `spec.preDeploy`. For adopted apps
marked `migrationRequired`, configure `preDeploy`; legacy apps without it require `--migrations-applied` after
migration succeeds. This is an assertion, not a command that runs migrations.
Rollback restores a saved generation; it does not undo database migrations.

Each CLI session fetches the VM revision. Independent image-app applies reserve
only their app and physical bindings, then merge their changes into the latest
snapshot at commit. A source app's domain phase takes its own reservation after
the healthy rollout is saved. Shared infrastructure operations remain exclusive.
Reads and all plans, including tag resolution, skip operation locks and create no
control revisions or history. Per-app and short edge kernel locks protect runtime
changes. See [locking boundaries](locking.md). Separate plan and apply commands
recompute against current state; a prior plan is not an approval token.

Up to 20 recent successful file mutations retain their source document and
resolved app config/digest in private VM control state and encrypted backups.
The CLI does not require matching Git checkouts or sync local state. An older
checkout can intentionally deploy older config; it cannot silently overwrite a
concurrent transaction. Only one generation serves a given app at a time.

## Pre-deploy tasks

Declare a migration program shipped inside the app image:

```yaml
spec:
  preDeploy:
    command: [bun, run, scripts/migrate-schema.ts]
    timeoutSeconds: 300
```

The CLI runs this once for every applied deployment (including the same image),
using the resolved candidate image and candidate environment/secrets on the VM,
under the app lock before starting the candidate or stopping current workers.
This is an argv array, not shell text; use an explicit shell only when needed.
The one-shot container uses the edge network and app resource limits, with no
app data volumes, host mounts, published ports or Docker socket. Use it for
external database migrations; per-instance database initialization belongs to
that instance. A nonzero exit/timeout aborts rollout and removes the task
container. Logs stay private beside the VM release's app.env as pre-deploy.log.
Migrations must be idempotent and compatible with the still-serving old app.
Traffic rollback does not undo database changes and does not rerun preDeploy.

Optional `preDeploy.secrets` uses the same secret-reference map as `spec.secrets`.
It overrides candidate environment keys only for the one-shot task. For example,
set `preDeploy.secrets.DATABASE_URL: {provider: vm, key: MIGRATION_DATABASE_URL}`
while `spec.secrets.DATABASE_URL` references the app's DML-only credential. The
CLI writes task overrides to a separate root-only `pre-deploy.env`; those values
are not injected into the running application or its Compose environment.
Source plans reject missing task secrets before rollout. Secret deletion refuses
keys still referenced by either the app or its pre-deploy task.
Scaling to zero skips the task; other applied releases rerun it.

Build scripts should build/push and call `2server deploy -f FILE --apply`.
With preDeploy configured, remove local migration/secret-fetch commands and
`--migrations-applied`. That flag remains a legacy acknowledgement for apps
without a configured hook; it never bypasses a configured preDeploy task.

### Restricted capabilities

App containers drop all Linux capabilities by default. `capabilities:
[NET_BIND_SERVICE]` explicitly restores only low-port binding; other additions
(such as SYS_ADMIN) are rejected. Caddy images with a file capability on the
binary need this even when configured to listen on port 8080: otherwise Linux
can reject exec with `Operation not permitted`. This applies to native/Compose
containers and preDeploy tasks, with no-new-privileges retained.

## Cloudflare zone policy

Rate-limit and Cache Rules capacity are shared by a Cloudflare zone. Declare one `kind: Zone`
source file for it, separate from App and hostname-specific Domain files:

```yaml
apiVersion: 2server.app/v1
kind: Zone
metadata:
  name: example-com
spec:
  zone: example.com
  rateLimit:
    scope: zone
    rules:
      - name: image-submit
        paths: [{value: /photo-api/jobs, match: exact}]
        requests: 5
        period: 10
        mitigationSeconds: 10
        excludeVerifiedBots: true
        enabled: true
```

```sh
2server validate -f platform/cloudflare-zone.yaml
2server plan -f platform/cloudflare-zone.yaml
2server apply -f platform/cloudflare-zone.yaml --apply
2server get -f platform/cloudflare-zone.yaml
```

`apply` / `deploy` operate on the resource kind in the file. A Zone apply only
calls Cloudflare and records its policy in VM config under
`cloudflare.zones[zone]`; it never pulls an image or restarts an app. No separate
`protect` command is needed. An App deployment does not modify zone policy.
Plans are read-only. Zone applies hold the server operation lock to serialize
shared provider policy updates. Use one source of truth for each zone; rule
ownership uses server + zone + rule name, independent of application names.

The connected server's `cloudflare.tokenEnv` needs Zone Read and Zone WAF Edit
for the managed zone. Import credentials privately with the normal server secret
workflow. The CLI never prints tokens/provider error bodies, buys an upgrade or
replaces a foreign rule to make space. Existing rules, including disabled rules,
consume the shared capacity. Free supports one rule with a 10-second counting
window and a 10-second block. Free cannot match hostname; `scope: zone` explicitly
matches the declared paths across **all proxied hosts**. On Pro or higher use
`scope: hosts` and `hosts: [api.example.com]` to narrow the scope.

### Custom WAF rules

`spec.wafRules` manages rules in the `http_request_firewall_custom` phase
(the "Custom rules" list in the dashboard). Rules are host-scoped by design —
there is no zone-wide form:

```yaml
spec:
  zone: example.com
  wafRules:
    - name: seo-tool-denylist
      hosts: [example.com, www.example.com]
      action: block                  # or managed_challenge
      userAgents: [ahrefsbot, semrushbot]   # lower(http.user_agent) contains …
      excludeVerifiedBots: true      # adds "and not cf.client.bot"
      exceptPaths: [/robots.txt, /ads.txt]  # exact-path exemptions
      enabled: true
```

- `userAgents` are case-insensitive substrings of `lower(http.user_agent)`.
  UA strings are attacker-controlled: keep verified-search-engine tokens
  (googlebot, bingbot) paired with `excludeVerifiedBots: true` so the rule
  catches impersonators, not the real crawler that needs to read robots.txt.
- Custom-rule quota: Free 5, Pro 20, Business 100, Enterprise 1000; existing
  foreign rules count. Ownership is `2server:<server>:zone:<zone>:waf:<name>`.
- Token needs Zone Read + Zone WAF Edit (same permission as rate limits).

Change paths, requests, periods or `enabled` and apply the Zone file. The first
version uses IP counting and block actions. Supported periods and rule ceilings
are checked against the reported plan; Enterprise contract-specific entitlements
remain subject to provider validation. Updates target one owned rule at a time
and reread capacity before each write. Provider changes are not transactional;
a partial failure can leave some rules applied, so inspect and rerun the plan.

Omitted rules are retained. Set `enabled: false` to disable an owned rule;
explicit retirement in Cloudflare frees its slot. `rules: []` inspects capacity
without adding rules. Zone delete/rollback is refused rather than implicitly
removing live protection. Renaming the zone points to a different resource and
does not retire policies in the original zone.

**Turnstile belongs to the application.** 2server does not create widgets,
configure challenges, generate keys or validate tokens. Each app owns its
frontend/native integration, backend Siteverify checks and widget lifecycle.
Apps may reference their already-provisioned keys through ordinary `spec.secrets`,
just like any other application secret. There is no `spec.protection` on App.
Per-user permissions and exact spending quotas also remain backend concerns.

### Optional Cache Rules

`spec.cacheRules` is optional and independent of `spec.rateLimit`. A cache-only
Zone needs no rate-limit block. Rules require explicit `hosts` inside `spec.zone`
and at least one path matcher: `{exact: /path}` or
`{prefix: /path/, suffix: /image}` (suffix optional). Hosts are ORed; paths are
ORed; prefix and suffix on the same entry are ANDed. No raw expressions or regex.

```yaml
apiVersion: 2server.app/v1
kind: Zone
metadata:
  name: example-com
spec:
  zone: example.com
  cacheRules:
    - name: public-template-images
      hosts: [photos.example.com]
      paths:
        - prefix: /local-api/templates/
          suffix: /image
        - exact: /assets/logo-v1.png
      mode: respect-origin
      cookies: allow
      bypassCookies: [__Host-admin]
      enabled: true
```

- `mode: respect-origin` (default) makes matching GET/HEAD requests eligible for
  caching and respects origin edge/browser TTL headers. It does not force-cache
  `private` / `no-store` responses or supply a TTL. The app must send public
  cache headers, for example `public, max-age=0, s-maxage=300`.
- `mode: bypass` disables cache for matching hosts/paths, for all methods and
  regardless of cookies or authorization.
- `cookies: bypass` (default) excludes requests with any Cookie header from this
  eligibility rule. Use `allow` only for assets identical for every viewer.
  `bypassCookies` excludes requests containing any listed cookie name. These
  exclusions skip this rule; they do not undo another rule that enables caching.
  Retain `Domain.cache: app` as the bypass baseline, or declare an explicit
  `mode: bypass` rule last for sensitive paths.
- Requests with an Authorization header are always excluded from eligibility.
  Full query strings remain in the default cache key, including `?v=2`. Do not
  configure another rule to ignore them if the app uses versioned URLs.
- `enabled` defaults to true. Names must be unique and stable. Omitting a rule
  retains it; `enabled: false` disables it without freeing a quota slot.

Use the same `validate`, `plan`, `apply -f FILE --apply` and `get` commands above.
The token needs Zone Read and Cache Rules / Cache Settings Edit for cache rules;
WAF Edit is only needed when also configuring rate limits. Preflight checks both
requested policies before any provider write. Cache Rules have a separate quota:
Free 10, Pro 25, Business 50, Enterprise 300 (custom contracts remain subject to
provider validation). Existing manual and disabled rules count too.

Zone rules run after Domain cache presets, in source list order; later matching
settings win. Redeploying a Domain keeps its presets before Zone overrides.
Only named owned rules are patched/created, preserving foreign rules. Review the
read-only plan when mixing policies or changing order. Rules omitted from this
file remain earlier in the ruleset; use one Zone file as the source of truth.
`Domain.cache: app | images | audio` remains supported for existing deployments.
A Zone apply changes Cloudflare and VM policy metadata without deploying the app.
For newly changed response headers, deploy the app separately. A cached image
can remain public until its TTL expires even after origin visibility changes;
use a bounded TTL or explicitly purge it in Cloudflare when immediate removal
is required.

References: [Cache Rules limits](https://developers.cloudflare.com/cache/how-to/cache-rules/),
[Cache settings](https://developers.cloudflare.com/cache/how-to/cache-rules/settings/).

Reference: [Cloudflare rate-limit availability](https://developers.cloudflare.com/waf/rate-limiting-rules/).
