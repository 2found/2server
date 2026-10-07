# Source-driven deployment

Read `docs/source-config.md` for the supported schema and CLI contract.

- Locate the app's reviewed `2server/*.yaml`, or a shared `platform/*.yaml`.
  Deploy with `deploy -f FILE` or `apply -f FILE`; do not reconstruct a desired
  App spec by merging old VM configuration. Paths inside files are relative to
  the file. Unknown fields fail. Keep secrets out of env/runtime templates.
- Connection is optional: nearest `.2server/connection.yaml` (legacy JSON is
  supported), or explicit `--connection` / `--ssh`. Show which VM/file is selected.
- Source documents declare secret references. If missing, explain which namespace
  and key to set with `secret set [--app NAME] --env-file PRIVATE_FILE --apply`.
  Never ask for values in chat, print them, or fall back to machine-local dotenv.
  `secret list` shows names only. Deletion is explicit and refuses deployed refs.
- Builds belong to the app release script; prefer spec.preDeploy for VM-side migrations. Pass the build's own
  digest as an optional image override. For migration-required apps, only pass
  `--migrations-applied` after migration succeeds. Without a configured preDeploy hook, the CLI does not perform it.
- `init app NAME -o app/2server/deploy.yaml` creates an App with a domain.
  Edit its image/port/hostname and remove domains if it is private. App/Domain
  plans inspect Cloudflare before rollout; apply still rechecks current state.
- `init app NAME --template TEMPLATE -o platform/NAME.yaml` creates a named App,
  then validate/plan/apply it. It does not install or provision anything by itself.
  `secret set --app NAME` supplies its values; `app NAME help` lists installed
  template commands. Default templates are not evidence that existing Redis/NATS/Postgres resources
  are adopted. Existing data paths and ownership must be checked before applying.
- Tags are registry-resolved every time; no registry failure fallback. A plan may
  pull layers but never switches traffic. Apply recomputes against current VM
  revision and takes the operator lock. Do not delete a held lock to force a run.
- Use one App manifest; no companion Compose/runtime file. The CLI generates
  container/Caddy configuration. Declare healthCheck, logical volumeMounts and
  optional instanceEnv in spec. Only instanceEnv substitutes `${generation}`;
  public env stays literal. Physical volume bindings and runtime identities stay
  on the VM. Preserve them when switching source versions. Existing legacy
  runtimeFile input is compatibility-only; never export its resolved secrets.
- Use `rollback -f FILE --apply` for a saved app generation. Stateful extensions
  use restore/update, and deletion preserves data. Removing a file does nothing
  remotely. Removing domains from an App file does not retire DNS.

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

Use `preDeploy.secrets` to override credentials only for the one-shot task, e.g.
`DATABASE_URL: {provider: vm, key: MIGRATION_DATABASE_URL}`. Keep the runtime
`spec.secrets.DATABASE_URL` on a DML-only login. Task credentials are written to
a separate private env file and are not passed to the application container.
Scaling to zero skips the task; other applied releases rerun it.

Build scripts should build/push and call `2srv deploy -f FILE --apply`.
With preDeploy configured, remove local migration/secret-fetch commands and
`--migrations-applied`. That flag remains a legacy acknowledgement for apps
without a configured hook; it never bypasses a configured preDeploy task.

For Caddy-based app images, check the executable's file capabilities. Declare
`spec.capabilities: [NET_BIND_SERVICE]` when required; do not remove cap-drop ALL,
no-new-privileges or use privileged mode to make the candidate start.

## Cloudflare zone policy

Shared rate limits and optional Cache Rules use `kind: Zone`, with `spec.zone`,
optional `spec.rateLimit` and optional `spec.cacheRules`.
Read `docs/source-config.md#cloudflare-zone-policy` for the schema and plan limits.
Use the normal `plan -f FILE` and `apply -f FILE --apply` commands; Zone applies
update Cloudflare and VM zone metadata without image pulls/app rollouts. Free
supports one rule per zone and no host predicate; `scope: zone` is explicit.
Preserve foreign rules and stop on capacity conflicts. Turnstile widget lifecycle,
frontend/native integration and backend verification belong to each application;
2server only stores any ordinary app secrets that the application references.

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

Use the same `validate`, `plan`, `apply -f FILE --apply` and `get` commands below.
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

```sh
2srv validate -f platform/cloudflare-zone.yaml
2srv plan -f platform/cloudflare-zone.yaml
2srv apply -f platform/cloudflare-zone.yaml --apply
2srv get -f platform/cloudflare-zone.yaml
```
