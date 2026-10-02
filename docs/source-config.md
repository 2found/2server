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
show a plan. Plans contact the VM and may pull registry image layers to resolve
a tag; they do not change workloads. `--image` is optional and overrides only
that execution. The source file is never rewritten by deployment.

`--connection FILE` is optional. Discovery searches upwards from the current
working directory for the nearest `.2server/connection.yaml`; legacy
`connection.json` is supported. Connection files use the existing SSH object
(`kind: ssh` or `kind: gcp`). A relative SSH identity path resolves relative to
its connection file. `connect --ssh user@host` writes a private, ignored YAML
connection. Different users can connect to the same fixed root-owned VM state.

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

The spec uses `src/config.ts:appSchema`, with a tag or digest allowed for image.
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

App files must use `provider: vm` references. The namespace is the app name.
Server/extension secrets use the server namespace and are explicitly declared
in the Extension file's `secrets` map, matching its `passwordEnv`/`tokenEnv` etc.
Neither list nor configuration export prints values.

```bash
# Private dotenv file; never commit it. Values are parsed, never sourced.
2server secret set --app api --env-file /private/api.env --apply
2server secret list --app api
2server secret delete --app api --key UNUSED_SECRET --apply

# Shared extension/provider credentials
2server secret set --env-file /private/platform.env --apply
2server secret list
```

`set` upserts supplied keys and retains others. `delete` refuses a key referenced
by the deployed configuration. Changing a value does not restart an app; deploy
its file to use the new value. Values cannot be passed as CLI arguments. Secrets
are stored root-only on the VM and included in encrypted `server backup` output.
The existing `server env` command remains supported; `--app NAME` selects the app
namespace. Local environment values never substitute for missing VM secrets.

## Extensions

```bash
2server init extension redis -o platform/redis.yaml
# Edit the generated file and set its declared secrets.
2server apply -f platform/redis.yaml --apply
```

Templates exist for postgres, redis, nats, monitoring and image-proxy. Init refuses
to overwrite a file and never connects to the VM. Templates are copied to source;
future CLI releases do not replace them. Declared extensions have one fixed
instance name per VM. `image-proxy` maps to the internal `imageProxy` extension.
Monitoring declares its stack images and optional top-level `webhooks` references;
its existing workflow configures DNS and TLS as well as containers. PostgreSQL
backup requires an explicit destination or the VM's backup-storage configuration;
edit the template before applying it. Data-path/disk identity and backup-storage
credentials remain VM infrastructure concerns. Deletion retains database volumes. Changes to an existing extension's dataPath,
disk, database or username require an explicit data migration and are refused by apply.

Extension renderers still enforce their documented safety defaults (isolation,
health probes and single-instance stateful update strategy). They are versioned
with the CLI, not downloaded templates. Pin CLI versions in CI when reproducibility
of generated service configuration is required.

### Service extensions

An arbitrary single-container workload is a `kind: Service` document — one
file per instance name, generated by `2server init service NAME -o FILE` and
applied like an extension. Its spec is `serviceSchema`
(`src/extensions/service.ts`): image (tag pinned to digest at apply), env,
secrets (same provider map as apps; `provider: vm` uses the service name's
`--app` secret namespace), optional command, port, healthCheck and an
immutable `dataPath` mounted at `/data`. Services share the stateful engine's
release/rollback/lock mechanics, join the edge network
(`two-<server>-<name>:<port>`), and are managed through
`get|logs|delete extension NAME`. Instance names must not collide with
declared extension names.

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

Each CLI session fetches VM revision, acquires a shared operator lock, and rejects
revision changes before reconciliation. The lock is released after state save.
Per-app and edge locks protect runtime changes. Separate plan and apply commands
recompute against current state; a prior plan is not an approval token.

Up to 20 recent successful file operations retain their source document and
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
