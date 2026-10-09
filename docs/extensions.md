# Extension authoring

An extension has one definition in `src/modules/extensions/infrastructure/templates/*/extension.yaml`. The CLI
loads this catalog at startup; schemas, templates, names and published outputs
come from those definitions. Adding a single-container recipe requires no edit
to the registry, config schema, CLI dispatcher or deployment engine.

Definitions ship with the CLI package. They are not per-server source documents
and cannot load arbitrary code from a URL. `kind: App` with `template: NAME`
selects a definition and gives its instance a user-chosen app name. `kind: Service` remains available
for a one-off container without creating a catalog recipe.

The standalone `meilisearch` template supplies shared platform search with
private credentials and persistent data. See [its operator runbook](meilisearch.md);
it does not install Soot or create data pools.

## A YAML-only container recipe

```yaml
# src/modules/extensions/infrastructure/templates/thumbnailer/extension.yaml
apiVersion: 2server.app/v1
kind: ExtensionDefinition
metadata:
  name: thumbnailer
runtime:
  engine: service
  defaults:
    image: registry.example.com/thumbnailer:1.0
    port: 8080
    memoryMb: 256
    cpus: 0.5
    env:
      MODE: safe
    healthCheck:
      command: [wget, -qO-, http://localhost:8080/healthz]
outputs:
  endpoint:
    type: endpoint
    protocol: http
    port: 8080
```

Then generate the server configuration:

```bash
2srv init app thumbnails --template thumbnailer -o platform/thumbnails.yaml
2srv deploy -f platform/thumbnails.yaml --apply
```

`runtime.defaults` uses the existing strict Service spec: `image`, `memoryMb`,
`cpus`, `env`, `secrets`, `bindings`, `command`, `port`, `healthCheck` and optional
`dataPath` mounted at `/data`. The instance overrides recipe defaults; `env` and
`secrets` maps merge by key. A recipe adds no installed commands until a named app is deployed successfully.
Resource limits, private release files, ownership checks, per-extension locking,
Compose dollar escaping, rollback and data retention use `src/modules/extensions/application/stateful.ts`.

Declare credentials using `secrets: {TOKEN: {provider: vm, key: TOKEN}}` and
import them with `2srv secret set --app thumbnails --env-file PRIVATE --apply`.
These use the app instance name as the secret namespace. Never put
secret values in defaults, templates or source documents.

Recipes deliberately use the Service vocabulary rather than a new expression
language. There are no evaluated template strings, arbitrary install scripts,
custom input-schema DSL or embedded TypeScript in YAML. A lifecycle needing
bootstrap, special validation, backups, multiple containers or DNS/auth uses a
native hook.

## Worker apps

A definition with `runtime.engine: worker` deploys a Cloudflare Worker instead of
a VM container. `url-shortener` is the shipped example: account, Worker name,
hostname, zone and D1 database come from the App spec, while the script and its
`schema.sql` live beside the definition.

```yaml
apiVersion: 2server.app/v1
kind: App
metadata: {name: go}
template: url-shortener
spec:
  accountId: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  worker: soot-go
  hostname: go.example.com
  zone: example.com
  database: soot-go-links
```

```bash
2srv init app go --template url-shortener -o platform/go.yaml
2srv deploy -f platform/go.yaml --apply
```

`plan` and `deploy` for a worker app open no VM session. Both resolve the active
zone, verify it belongs to `spec.accountId`, and list D1 before any mutation.
Apply creates the database if absent, runs a supplied `schema.sql`, uploads the
script and attaches the custom hostname. `--apply` is required for the mutation.
Use the [Workers/D1 token permissions](cloudflare-tokens.md#workers-and-d1):
Account D1 and Workers rights plus Zone Read and Workers Routes Write. A plan
does not test upload or other write rights.
`delete` and `rollback` are refused — the Worker, its D1 database and its hostname
are retired explicitly in Cloudflare. A worker app has no VM container, so
`app NAME logs|deploy|restart` do not apply to it, and the VM extension engine
skips it during `2srv extensions`.

Because the deploy path never connects to the VM, a worker app is not written to
the VM manifest. Its declared commands — `url-shortener`'s `customers` registers a
customer Ed25519 public key in D1 — dispatch through `app NAME <command>`, which
reads the instance from `extensionApps`; add that entry before relying on them.

Worker definitions use the external runtime hook described below. They publish
no outputs or VM domains and declare no VM containers. The YAML definition, the
optional `cli.ts`, strict spec validation and the `init`/`plan`/`deploy` vocabulary
are shared with container recipes.

## Email Routing apps

The `email-routing` template uses `runtime.engine: email-routing` to manage
Cloudflare Email Routing directly. It shares `init app`, validation and
`plan`/`deploy -f FILE --apply` with other templates, but creates no VM workload,
Worker or database and publishes no container outputs. Its strict spec declares
the account, zone and exact forwarding routes. See the
[email runbook](email-routing.md) for permissions, destination verification,
DNS ownership checks, the Free-plan limits and retirement behavior.

## External runtime contract

An extension outside the VM implements `ExternalRuntime` from
`src/modules/extensions/domain/types.ts`. Keep its pure spec in the template's
`domain/spec.ts`, provider operations in sibling adapters, and its source hook
in `source.ts`. Register the adapter once in
`src/modules/extensions/application/registry.ts`, alongside the native hook
allowlist. `runtime.engine` selects that registered adapter; unregistered names
are rejected. YAML cannot provide an executable path or load remote code.

The adapter supplies its schema, supported source operations, document
validation, init/plan messages and `run` function. Core merges and validates
defaults, checks `--apply`, prints results and dispatches through `Extension.source`.
It does not branch on provider engine names. Adding another external runtime
requires its template and registration, without edits to source dispatch or VM
deployment logic.

`source.connection: optional` permits an explicitly selected read-only VM
session for credentials; `run` receives that session's config and selects its
own credential reference. Core does not pass `--apply` into this session,
publish external workload state or write a VM revision. `connection: none`
rejects connection flags. The VM deploy engine skips external workloads;
targeted VM deploy, logs, restart and delete reject them before effects.
Provider retirement remains explicit until the adapter supports it.

These are shipped native adapters, not separately installed packages. They
share the extension contract and existing infrastructure helpers with 2server;
the registry remains the deliberate composition point.

## Connecting apps and extensions

App and Service specs accept `bindings`. Each maps an environment variable to
one installed app output:

```yaml
apiVersion: 2server.app/v1
kind: App
metadata:
  name: api
spec:
  image: registry.example.com/api:1.0
  port: 8080
  memoryMb: 512
  cpus: 1
  bindings:
    DATABASE_URL: {app: orders-db, output: appUrl}
    REDIS_URL: {app: cache, output: url}
    NATS_URL: {app: events, output: endpoint}
    NATS_TOKEN: {app: events, output: token}
    IMGPROXY_URL: {app: images, output: endpoint}
```

Bindings use instance names, not template names. Legacy `extension:` binding
syntax remains accepted. A generic
Service with `port` automatically publishes an HTTP `endpoint`; catalog recipes
publish exactly the outputs in their definition.

| Builtin | Output | Value |
| --- | --- | --- |
| postgres | appUrl | PostgreSQL URL using the application role and its secret |
| redis | url | Authenticated Redis URL |
| nats | endpoint, token | NATS URL and separate authentication token |
| image-proxy | endpoint | Internal imgproxy HTTP base URL |
| monitoring | endpoint | Internal Prometheus HTTP base URL |

2server resolves names and credentials at deployment. Connection URL credentials
are percent-encoded. Secret values enter only the private runtime bundle, never
the source config, desired manifest or deployment-history spec. No output CLI
prints resolved credentials. Named template `*Env` references resolve through the app-scoped top-level
`secrets` mapping. Legacy singleton references retain server-level VM secrets.

A binding also declares a dependency:

- Config validation rejects missing extensions, unknown outputs, cycles and
  overlapping `env`, `secrets`, `bindings` or app `instanceEnv` keys.
- Full extension deployment orders bound providers before consumers. `order`
  in a definition is only the baseline order for independent extensions.
- App and single-extension deploy require the bound providers to be running and
  Docker-healthy before starting the consumer. They do not auto-install or
  restart providers. A provider without a health check fails closed. Stopping
  a native app with replicas zero does not require healthy dependencies.
- Delete refuses an extension with bindings from any configured app or service,
  even in dry-run. The references persist on the VM, so this works without the
  original checkout. Remove the consumer binding and apply it before deletion.
- Changing provider settings or rotating its secret does not redeploy consumers.
  Reapply consumers to refresh their runtime environment. Readiness is checked
  at rollout time; applications remain responsible for reconnecting at runtime.

Existing `requires` is still an apply-time existence check; bindings need no
additional `requires` entry. This change does not turn `requires` into a stored
readiness dependency or reverse-delete guard.

For old imgproxy installs, reapply the extension to install its Docker health
check before using a binding. Container name, project and private paths remain
unchanged. Generic Services used as providers also need `healthCheck` (or a
working health check in their image).

## Optional extension CLI

Keep domain-specific commands beside the template in `src/modules/extensions/infrastructure/templates/NAME/cli.ts`:

```yaml
commands:
  backup: {description: Create a backup, usage: '[--apply]'}
  backups: {description: Inspect backup inventory, readOnly: true}
```

Export `async run(config, command, args)` from that module. The generic app
router checks installed state and the definition's command map before importing
it. No core switch/registry/help edit is needed to add a command. Core operations
(`get`, `deploy`, `logs`, `restart`, `delete`, `rollback`, `scale`, `help`) cannot
be shadowed. The handler validates its own options, rejects unknown/duplicate
flags, and defaults mutations to intent unless `--apply` is present. Declare
read-only operations accurately. Connected mutations hold the VM control lock;
local execution also uses the operator lock.

Use `app NAME help` to discover commands for that app. Removing an installation
removes its commands. Files created by init alone do not activate them. App names
select instances; handlers must use the bound config, never choose a global DB.
PostgreSQL's CLI owns backup/inventory/restore/drill/recovery cleanup. Monitoring's
CLI owns receiver inspection/testing; receiver configuration stays in source.

Named native hooks use `instanceName`, `instanceRoot`, `instanceSecret`,
`extensionProject` and `extensionRoot(name, config)` for runtime identity.
Never hardcode a singleton container, timer, data path, secret namespace or
backup prefix in new code. `bindInstance` adapts the existing hooks without
moving legacy installations. Secret resolution must never fall back to global
values for a named app. Backup destinations must be exclusive per database.

## Native hooks

The five existing extensions each have a YAML definition referencing a native
implementation. This PostgreSQL excerpt omits the schema and service declaration;
the complete definition is in `src/modules/extensions/infrastructure/templates/postgres/extension.yaml`:

```yaml
apiVersion: 2server.app/v1
kind: ExtensionDefinition
metadata: {name: postgres}
order: 10
hook: postgres
template:
  passwordEnv: POSTGRES_PASSWORD
  adminPasswordEnv: POSTGRES_ADMIN_PASSWORD
  migrationPasswordEnv: POSTGRES_MIGRATION_PASSWORD
outputs:
  appUrl:
    type: connection
    protocol: postgresql
    port: 5432
    usernameField: username
    passwordEnvField: passwordEnv
    databaseField: database
```

The complete valid definitions live in `src/modules/extensions/infrastructure/templates/`. PostgreSQL keeps initialization, role separation, pgBackRest and restore
checks in `postgres/hooks.ts` and its helpers. Its input schema/defaults and static
container configuration are declared in `postgres/extension.yaml`. Monitoring retains its multi-container lifecycle,
metrics, alert rules, authenticated domain and webhook configuration. Imgproxy
retains its existing runtime identity and native installer; no implicit migration
creates a second container. Redis/NATS retain their durability and host setup.

A definition chooses exactly one `hook` or `runtime`. `template` supplies the
bare spec for `init app NAME --template TEMPLATE`; it is parsed through the YAML JSON Schema, then
the hook's optional cross-field validator. Native
hook names are explicitly allowlisted in `src/modules/extensions/application/registry.ts`. Adding a new
native hook requires registering its implementation there; adding a service
recipe requires only the YAML file. TypeScript spec types are generated from YAML with `bun run gen:extension-types`;
`bun run check` rejects stale generated types. There is no handwritten TypeScript
copy of builtin schemas or defaults.

`metadata.key` is a compatibility alias for old manifest keys, currently
`image-proxy` → `imageProxy`. Native hooks must retain their extension name;
preserve existing manifest keys when editing builtin definitions.
Duplicate/reserved names and alias collisions are rejected at startup.

Outputs use structured descriptors:

- `endpoint`: protocol (`http`, `https`, `redis`, `nats`, `postgresql`, `tcp`),
  port, and optional container suffix. Default host: `two-<server>-<extension>`.
- `connection`: endpoint fields plus `passwordEnvField`, optional
  `usernameField` and `databaseField` referencing native spec fields, or a literal
  `username` (Redis uses its `default` ACL user).
- `secret`: `envField` referencing a native spec's `*Env` field.

Connection/secret outputs are resolved only in memory for a consumer. Do not
publish admin or migration credentials as application outputs. Recipe outputs
must match the container's actual protocol and listening port.

## Native extension contract

Each builtin is now colocated with its imperative hooks:

```text
src/modules/extensions/infrastructure/templates/
  redis/extension.yaml       # schema, defaults, container, settings, outputs
  redis/hooks.ts             # memory check, secret rendering, host sysctl
  nats/extension.yaml
  nats/hooks.ts              # JetStream condition and unit conversions
  postgres/extension.yaml
  postgres/hooks.ts          # bootstrap, backup, restore verification
  monitoring/extension.yaml  # images, stack, scrape config, host alert rules
  monitoring/hooks.ts        # receivers, metrics, DNS/auth, rollout
  image-proxy/extension.yaml
  image-proxy/hooks.ts        # input validation and existing runtime lifecycle
```

The catalog also accepts a standalone `src/modules/extensions/infrastructure/templates/NAME.yaml` for a recipe
without helper files. Builtin inputs use standard JSON Schema (`type`,
`properties`, `required`, `default`, bounds, patterns, enums and unions), compiled
by Zod. Cross-field validation stays in hooks. `service` provides the stateful
Compose fragment; `compose` and `settings` hold native stack/file configuration.
`immutable`, `dataPathField`, `container` and `acceptsWebhooks` are declarations.

Use structured references to copy a validated value, with an optional literal
prefix/suffix; there is no expression evaluator:

```yaml
service:
  volumes:
    - {$value: spec.dataPath, suffix: ':/data'}
  environment:
    POSTGRES_DB: {$value: spec.database}
```

Allowed reference roots are `spec`, `server` and `edge`. Missing values fail;
references cannot access process environment, inherited properties or code.
Sensitive values still resolve in hooks, never through YAML interpolation.
Keep new schema constructs within the converter/type generator's supported
subset; unsupported constructs fail checks. Run `bun run gen:extension-types`
after changing a native schema.

See `src/modules/extensions/domain/types.ts`. `ExtensionHooks` retains behavior only:

- `refineSpec`, `validate`: cross-field and cross-config validation.
- `stateful`: file rendering, preflight, host/release preparation, verification,
  post-install, after-deploy and teardown through the shared engine.
- `deploy` / `remove`: specialized native lifecycles such as monitoring.
- `domains` / `auth`: publish routes only after successful deployment, through
  edge/DNS/TLS reconciliation.
- `summary` / `diagnostics`: safe operator output using bound instance config.
- `backupStoragePermissions`: shared storage permission intent, without core
  inspecting a template-specific backup spec.
- `alertRules` / `controlState`: static metric groups and strict portable-state
  declarations, composed through the registry instead of sibling imports or
  core state-path literals.

Read the [extension boundaries](extension-boundaries.md) for instance binding,
portable-state guards, frozen compatibility contracts and enforcement tests.

The compiler derives data-path guards, immutable fields, log targets and receiver
support from YAML.

`scoped` is no longer needed. Single-extension deployment selects its execution
list explicitly and retains the full manifest for bindings and existing routes.

## Verification

```bash
bun run check
DOCKER_TESTS=1 bun test tests/template-apps.test.ts tests/bindings-runtime.test.ts
```

The template fixture runs two PostgreSQL app instances, checking separate credentials
and persisted data after restart. The binding fixture runs an isolated YAML consumer against authenticated Redis,
checks real URL encoding and Compose interpolation, then stops Redis and verifies
readiness rejection. It does not access production resources.

## Native reviewed source

A native hook may contribute `sourceDeployment` with offline `validate`, read-only
`plan`, reviewed `apply`, and optional post-domain `verify`. Inputs include the
source document/path and bound config; checked inventories stay outside serialized
Config. Plan returns artifact plus safe summary. Apply returns `initialized`,
`applied`, `pending` or `rejected` and an applied spec. Core transports private
`--plan-output`/`--plan-file` artifacts, binds instances and owns connected locking
and shared domain reconciliation. An initialization result publishes no traffic;
pending/rejected never count as source success. Templates own artifact schema,
review vocabulary and protocol enforcement. See [Soot](soot.md) for the concrete
C1/C3 use case. External runtimes retain their separate source-only contract.
