# Extension authoring

An extension is a single optional block of the server manifest — one instance
per VM — plus its install/remove lifecycle. Every extension is declared in one
file under `src/extensions/` and registered in `src/extensions/index.ts`. The
registry is the only list: engines, CLI dispatch, source-document parsing and
manifest validation all derive their behavior from it. Adding an extension
never edits `resources.ts`, `documents.ts`, `templates.ts`, `file-command.ts`,
`stateful.ts` or `deploy-extensions.ts`.

## Layout

```
src/extensions/
  types.ts            Extension + StatefulHooks contract — read this first
  index.ts            extensionRegistry: the single ordered list
  redis.ts            small extensions are one file
  nats.ts
  image-proxy.ts
  postgres/           larger extensions get a directory
    index.ts          the declaration (schema + hooks)
    init.ts, backups.ts, pgbackrest.ts, health.ts   per-extension helpers
  monitoring/
    index.ts          the declaration
    settings.ts, runtime-health.ts, webhooks.ts     per-extension helpers
```

Helpers used only by one extension live inside its directory. Shared engines
(`stateful.ts`, `deploy-extensions.ts`, `edge.ts`, `domains.ts`) stay at
`src/` and must not grow per-extension branches — express differences through
hooks.

## Generic service extensions

Most extensions do not need a declaration at all. A plain single-container
workload — a crawler, a scheduler, a small sidecar API — is a **service
extension**: a `kind: Service` document (or `extensions.services.<name>` in the
manifest) stored under an arbitrary instance name.

```bash
2server init service crawler -o platform/crawler.yaml
# edit image (tag is pinned to a digest at apply), env, secrets, healthCheck
2server secret set --app crawler --env-file /private/crawler.env --apply
2server apply -f platform/crawler.yaml --apply
```

```yaml
apiVersion: 2server.app/v1
kind: Service
metadata:
  name: crawler
requires:            # optional ordering: apply api first, etc.
  - { kind: App, name: api }
spec:
  image: ghcr.io/example/crawler:latest
  env: { TARGET: https://api.internal }
  secrets:           # same provider map as apps; provider:vm values live in
    TOKEN: { provider: vm, key: TOKEN }   # the service's --app namespace
  healthCheck: { command: ["wget", "-qO-", "http://127.0.0.1:8080/healthz"] }
  dataPath: /opt/2server/data/crawler    # optional; mounted at /data, immutable
```

Service extensions reuse the shared engine (`src/stateful.ts`): per-extension
`flock`, ownership checks, versioned release bundles at
`/opt/2server/extensions/<name>/`, `compose up -d --wait` with rollback,
`no-new-privileges`, `pids_limit` and bounded logging. Containers join the
edge network — other apps reach them as `two-<server>-<name>:<port>` and a
Domain document may route to them. `dataPath` changes are refused; deleting
the extension stops the container and retains the data directory. Manage it
with `get|logs|delete extension <name>` like any declared extension.

`2server init extension NAME` stays for the five declared extensions; `init
service NAME` is for arbitrary ones. If a service gains lifecycle needs that
the generic spec cannot express — credential bootstrapping, DNS publication,
host setup — it graduates to a full declaration below.

## The declaration

```ts
export const mySchema = z.object({ ... }).strict().optional();

export const myExtension: Extension = {
  name: "myext",            // manifest key: config.extensions.myext
  cliName: "my-ext",        // init/Extension-document name (kebab-case;
                            // omit when identical to name)
  schema: mySchema,         // falsy output = disabled; carry full desired state
  template: {...},          // `init extension` skeleton; secrets via *Env fields
  scoped: (c) => ({ myext: c.extensions.myext }),
  deploy: async (c) => {...},     // stateless extensions
  remove: async (c) => {...},     // stop service; never delete data volumes
  ...
};
```

### Field reference (see `types.ts` for the full contract)

- **`name` / `cliName`** — `name` is the camelCase manifest key; `cliName`
  is the kebab-case name in `2server init extension NAME` and Extension
  documents (`image-proxy` → `imageProxy`). The registry enforces both.
- **`schema`** — strict zod schema for `config.extensions[name]`. Use the
  primitives in `src/schema.ts` (`name`, `hostname`, `envKey`, `path`,
  `image`, `backupCalendar`). Reference secrets only via `*Env` envKey
  fields — secret values never enter the manifest. Mount the field in
  `configSchema.extensions` (one line, next to the other registry entries).
- **`template`** — bare spec emitted by `init extension`; parsed through
  `schema` so defaults appear in the generated file.
- **`scoped`** — the extensions keys a single-extension deploy needs. Always
  include companion keys your deploy reads (monitoring keeps
  `alertWebhookEnv`/`webhooks`); omit siblings so they are never redeployed.
- **`deploy` / `remove`** — for non-stateful extensions. `deploy` runs after
  `preflightEdge`; if the extension publishes `domains`, DNS/TLS/route
  reconciliation runs after deploy through the same orchestrator.
  `remove` receives the config already normalized by `withExtensionDomains`
  and must only stop the service — data volumes and rollback material stay.
- **`stateful`** — extensions with persistent data on a dedicated volume do
  not implement `deploy`/`remove`; they declare `StatefulHooks` and the shared
  engine (`src/stateful.ts`) owns preflight, release bundles, compose
  up --wait, pointer switch, rollback and removal. Required spec fields:
  `image`, `memoryMb`, `cpus`, `dataPath`.
- **`validate(c, ctx)`** — cross-field checks inside `configSchema`'s
  `superRefine`; runs even when the extension is disabled if the check is
  unconditional (see monitoring's webhook uniqueness).
- **`domains(c)`** — domains the extension owns; merged into `config.domains`
  by `withExtensionDomains` and reconciled (DNS, cert, auth route, cache
  bypass) by `deployExtensions` after the stack is ready. Pair with
  **`auth(c, state)`** for authenticated routes.
- **`dataPaths(c)`** — host data directories; config validation rejects
  overlap between extensions.
- **`immutable`** — spec fields that may never change once configured
  (guards implicit data migration through source-file apply).
- **`acceptsWebhooks`** — the Extension document may carry `webhooks`
  (alerting receivers). Monitoring only.
- **`logTarget`** — container name for `logs extension NAME`; defaults to
  `two-<server>-<name>`.

## Wiring checklist for a new extension

1. `src/extensions/my-ext.ts` (or `my-ext/index.ts`): `export const
   myExtExtension: Extension` with the fields above.
2. `src/extensions/index.ts`: append to `extensionRegistry`. Order is deploy
   order — data services first, observers/consumers after.
3. `src/config.ts`: add `myExt: mySchema` to the `extensions` object.
4. `bun run check`. The CLI (`init extension`, `create|update|reload|delete|
   logs extension`, `extensions --apply`, Extension source documents) works
   without further edits.

Domain-publishing extensions also inherit `deployExtensions` ordering:
provider/DNS validation → edge preflight → deploy → authenticated origin
probe → DNS/TLS publication. Never publish DNS before readiness.

## Rules the engines already enforce — do not weaken

- Secrets resolve on the operator machine via `*Env` references; never put
  values in the manifest, compose files as plaintext literals, or logs.
- `deploy`/`remove` shell runs under `set -Eeuo pipefail` behind the
  per-extension `flock` and the `/opt/2server/edge/owner` ownership check.
- No published host ports; services join the shared edge network only.
- Compose services get `no-new-privileges`, `cap_drop` where viable,
  `pids_limit`, bounded json-file logging and health checks.
- Versioned release bundles under `/opt/2server/<ext>/releases/`; activation
  is a pointer flip with rollback to the previous bundle.
- Removal stops the service and updates the manifest; data, secrets and
  history volumes are retained for recovery.
