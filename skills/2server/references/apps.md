# Apps, release scripts and CI

## Connected deployment

After `connect`, omit `-f` from resource commands; state comes from the VM.
Use `deploy app NAME --image repository@sha256:... --apply` to change an image,
or `scripts/release.sh --connected app image:tag context` to build/push/deploy.
Both persist the digest. See [control state](control-state.md) for new machines,
secret updates and backups. Examples below using `-f` are legacy/bootstrap mode.

## Add an app

Read `src/config.ts:appSchema`, the service's build/migration runbook, and its
Dockerfile. Add one stable app name, immutable image digest, port, readiness
path, memory/CPU budget, non-secret env and secret references to the server
manifest. Workers use `kind: "worker"` and need an actual Docker HEALTHCHECK;
services need an HTTP readiness endpoint. Changing service/worker kind requires
a new app name. Resolve capacity for overlapping blue/green service containers.

Keep every managed domain in this manifest. Add/adjust imports and routes
using the domain reference. Deploy the service before publishing its domain:

```bash
bun src/cli.ts validate server.local.json
bun src/cli.ts deploy server.local.json --apply
bun src/cli.ts domains server.local.json --apply
bun src/cli.ts verify server.local.json
```

`deploy` operates on every app in the supplied file. Prefer `reload app NAME -f
server.local.json --apply` for one app. `create app` / `update app` take a complete
`--spec app.json` and update the canonical manifest only after successful deploy.
`scale app NAME --replicas N` persists the desired count (0..32); every service
replica passes readiness before Caddy switches. Zero serves 503. Workers stop the
old generation first and need queue semantics safe for the selected concurrency.
`get pod` shows live managed containers; a pod is a Docker instance, not Kubernetes.
Pod create adds a replica; update/reload replaces the app generation; delete
scales down its owner. There is no resident scheduler to recreate arbitrary pods.

`scripts/release.sh`
already does this for build/push/deploy:

```bash
scripts/release.sh server.local.json app registry.example/app:release ../app ../app/Dockerfile
```

Read this script before wrapping it: it pushes an image, resolves its digest,
deploys only the selected app and persists the digest in the canonical
manifest. Registry login must work on the build host and for root on the VM.
Do not run it for a build-only request. Thin per-app wrappers should call this
script with repository-relative paths and an explicit manifest; use the shared
SSH adapter rather than embedding gcloud/ssh in each wrapper.

The generic deploy does **not** run database migrations or supply frontend
build arguments. Preserve the service's migration/preflight sequence and build
contract when migrating an existing deploy script. In this repository, DB DDL
must follow AGENTS.md; do not replace a legacy script until its required steps
are covered. Build secrets use the builder's secret mechanism, never image
layers or tracked env files.

After deploying check readiness, the public app path and an appropriate failure
case (such as unauthenticated access rejection). `rollback ... --apply` switches
the app to its stored previous color; `rollback app NAME -f server.local.json
--apply` also restores the manifest to that saved replica/image contract. It cannot roll back DB schema or Cloudflare DNS.

## Add or remove CI

Start with `examples/ci/deploy.yml`; it is an example, not an installed workflow.
Replace the manifest path, environment, registry/auth and app secret references.
Use an explicit environment/server concurrency group with cancel-in-progress
false. Configure SSH from the same manifest: verified known_hosts and private
key for direct SSH, authenticated gcloud/IAP for GCP. Inspect existing CI auth
before selecting an identity method; avoid adding long-lived cloud keys when
workload identity is already available.

Connected CI fetches certificates and monitoring credentials from the VM and
saves updates there; it needs only SSH access (plus GCP auth for IAP). Legacy
local-manifest CI must retain private operator state. Do not upload state as
a public artifact. If monitoring uses `passwordEnv`, provide it to domain
renewal and verification steps too. First-time provisioning/extensions are
separate explicit operations; the weekly domains job expects them already up.
Scheduled domain renewal must not deploy apps unless requested.

Remove only the app's workflow/job, triggers, wrapper and exclusively used CI
secret references. Keep shared certificate renewal, registry credentials and
other apps' workflows. Creating files does not activate hosted CI or create
remote secrets; report what remains to configure without exposing secret values.

## Remove an app

Stop the app's CI and retire or reassign its routes first. Then use:

```bash
bun src/cli.ts delete app NAME -f server.local.json --apply
```

The CLI checks declared and published routes, takes the app/edge locks, validates
Caddy and removes owned generations. It retains release metadata and env files.
Remove only the app's exclusive CI job/wrapper and unused secret references.

Check remaining app routes, absence of the removed containers/import and that
CI will not recreate it. Never use broad Docker prune or delete databases,
volumes, registry images or shared secrets as an implicit part of app removal.

## Availability checks

Read `docs/reliability.md` for single-VM availability work. Set two or more service
replicas only after budgeting both blue/green generations and extensions. Current
app deploys render continuous Caddy health checks; rollback uses the saved health
path. Use a cheap 2xx readiness endpoint, without redirects. `stopTimeoutSeconds`
(default 60) and `drainSeconds` (70) are configurable. Images must handle SIGTERM;
workers need durable redelivery and safe concurrency. Docker restarts exited
processes, not unhealthy ones, and does not recreate deleted containers. Do not
claim host-level HA or automatically restart apps on dependency readiness failure.


## Adopt Compose without resetting app state

Use `adopt app NAME --spec compose-app.json --apply` for a healthy existing
blue/green pair. Read README's adoption contract and `src/compose-apps.ts` first.
Never substitute a stateless native spec for an app with per-colour volumes or
consumer names. Adoption freezes resolved environment/commands/volume names into
VM-owned private state and leaves the routed container running. `sourceFiles`
are read only during adoption and stripped from the saved manifest.

Retire the old deployment path or hand its rollout phase to `2server deploy app`;
never let two independent scripts keep switching the same upstream. Keep app DB
migrations before rollout, mark `compose.migrationRequired`, and pass
`--migrations-applied` only after they actually succeed. Same-image reload needs no
schema work. Probe the live app and verify volumes/durables/env are preserved.
Fixed Compose pairs reject scaling; pre-adoption parked containers are not an
automatic certified rollback. Deletion of legacy Caddy routes remains explicit.
