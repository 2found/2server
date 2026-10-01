# Apps, release scripts and CI

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

`deploy` operates on every app in the supplied file. For one app, derive a
private temporary manifest selecting only that app while retaining all domains,
SSH and extensions; validate that exactly one name matched. Never publish the
temporary manifest as the server's full desired state. `scripts/release.sh`
already does this for build/push/deploy:

```bash
scripts/release.sh server.local.json app registry.example/app:release ../app ../app/Dockerfile
```

Read this script before wrapping it: it pushes an image, resolves its digest,
deploys only the selected app and prints the digest to record in the canonical
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
the app to its stored previous color; use a single-app temporary manifest if
that is the requested scope. It cannot roll back DB schema or Cloudflare DNS.

## Add or remove CI

Start with `examples/ci/deploy.yml`; it is an example, not an installed workflow.
Replace the manifest path, environment, registry/auth and app secret references.
Use an explicit environment/server concurrency group with cancel-in-progress
false. Configure SSH from the same manifest: verified known_hosts and private
key for direct SSH, authenticated gcloud/IAP for GCP. Inspect existing CI auth
before selecting an identity method; avoid adding long-lived cloud keys when
workload identity is already available.

A dedicated runner or encrypted restored state must retain certificates and
monitoring credentials at the same operator state path. Do not upload state as
a public artifact. If monitoring uses `passwordEnv`, provide it to domain
renewal and verification steps too. First-time provisioning/extensions are
separate explicit operations; the weekly domains job expects them already up.
Scheduled domain renewal must not deploy apps unless requested.

Remove only the app's workflow/job, triggers, wrapper and exclusively used CI
secret references. Keep shared certificate renewal, registry credentials and
other apps' workflows. Creating files does not activate hosted CI or create
remote secrets; report what remains to configure without exposing secret values.

## Remove an app

There is no app-remove command. First stop its CI deployment/reconciliation and
inventory routes, workers, databases and volumes. Retire or reassign its domain
routes using the domain reference; shared API paths may require a route edit
rather than deleting a hostname. Verify no live Caddy route imports the app.

Then, through the declared transport, take the app lock
`/var/lock/2server-app-<app>.lock`, followed by the edge lock when changing imports
(the same order as `src/apps.ts`). Remove only
`/opt/2server/edge/apps/<app>.caddy` after backing it up; validate/reload Caddy and
restore it on failure. Drain then stop/remove the exact owned blue/green
containers `two-<manifest>-<app>-blue` and `...-green`. Keep app state under
`/opt/2server/apps/<app>` for rollback unless data deletion was requested.
Remove the entry and its deploy wrapper/CI job from desired configuration.

Check remaining app routes, absence of the removed containers/import and that
CI will not recreate it. Never use broad Docker prune or delete databases,
volumes, registry images or shared secrets as an implicit part of app removal.
