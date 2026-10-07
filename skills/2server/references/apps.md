# Apps, release scripts and CI

## Connected deployment

Use `deploy -f app/2server/deploy.yaml` with optional `--image` override.
Read [source configuration](source-config.md) first. The remainder documents
legacy/bootstrap and adoption operations, not the default source workflow.

## Add an app

Use `init app NAME -o app/2server/deploy.yaml`, then edit the image, readiness,
port, resources and domain. Put values in `secret set --app NAME --env-file
PRIVATE_FILE --apply`, references in spec.secrets. Run `plan -f FILE`, then
`deploy -f FILE --apply`; the latter waits for readiness before domain setup.
Read the service's Dockerfile and build/migration contract first. Budget capacity
for both blue/green generations. Workers require healthCheck or image HEALTHCHECK
and queue semantics safe for stop/start and the selected concurrency.

The build/push/deploy helper takes a source file:

```bash
<product-root>/scripts/release.sh app/2server/deploy.yaml registry.example/app:release ./app ./app/Dockerfile
```

It builds/pushes and passes Buildx's digest to `deploy -f FILE --image ... --apply`.
Applied state is saved on the VM; source is never rewritten. Registry login must
work on the builder and for root on the VM. Do not run it for a build-only request.
Preserve app build arguments in a thin app-owned wrapper. For VM-side migrations,
use `spec.preDeploy` as described in [source configuration](source-config.md#pre-deploy-tasks).
Never put build secrets in image layers or tracked env files.

Legacy whole-server `deploy server.local.json --apply` deploys every app; use
`deploy app NAME --image DIGEST --apply` for a selected connected app. `scale app
NAME --replicas N` persists 0..32 instances; zero serves 503. `get pod` shows
managed Docker instances, not a resident scheduler. Stateful extensions use
separate restore/update lifecycles.

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
separate operations. The sample CI is dispatch-only; schedule `domains --apply`
weekly separately once the dependencies are up.
Scheduled domain renewal must not deploy apps unless requested.

Remove only the app's workflow/job, triggers, wrapper and exclusively used CI
secret references. Keep shared certificate renewal, registry credentials and
other apps' workflows. Creating files does not activate hosted CI or create
remote secrets; report what remains to configure without exposing secret values.

## Remove an app

Stop the app's CI and retire or reassign its routes first. Then use:

```bash
2srv delete app NAME -f server.local.json --apply
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
blue/green pair. Read `docs/operator-guide.md#adopt-an-existing-compose-app` and `src/modules/apps/infrastructure/compose.ts` first.
Never substitute a stateless native spec for an app with per-colour volumes or
consumer names. Adoption freezes resolved environment/commands/volume names into
VM-owned private state and leaves the routed container running. `sourceFiles`
are read only during adoption and stripped from the saved manifest.

Retire the old deployment path or hand its rollout phase to `2srv deploy app`;
never let two independent scripts keep switching the same upstream. Keep app DB
migrations before rollout, mark `compose.migrationRequired`, and pass
`--migrations-applied` only after they actually succeed. Same-image reload needs no
schema work. Probe the live app and verify volumes/durables/env are preserved.
Fixed Compose pairs reject scaling; pre-adoption parked containers are not an
automatic certified rollback. Deletion of legacy Caddy routes remains explicit.

For migration hooks, use the maintained [pre-deploy reference](source-config.md#pre-deploy-tasks).
