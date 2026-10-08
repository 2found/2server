# CLI architecture — 2server

Applies to the `@2server/cli` package in this independent repository. Source paths
and development commands are relative to the repository root; documentation
links are relative to their containing file. Read [AGENTS.md](../AGENTS.md)
for contributor constraints and the [operator guide](operator-guide.md) for
supported workflows. Infrastructure targets belong to consuming repositories.

## Stack and ownership

| Layer | Implementation / owner |
| --- | --- |
| Installed executable | `2srv` and `2server` share `bin/2server.cjs`, forwarding to Bun |
| CLI runtime | Bun >= 1.3, TypeScript; Node >= 20 for the launcher/package tooling |
| Validation | Zod feature schemas, composed config, extension-owned definitions |
| Desired configuration | Source App/Domain/Zone files in the consuming repository |
| Applied configuration and secrets | VM control snapshots for VM-managed workloads |
| External workload state | Registered template's provider, through `Extension.source` |
| Infrastructure adapters | SSH/process helpers, Docker/Compose, Caddy, Cloudflare, Terraform |
| Verification | Bun tests/typecheck, generated-type checks, isolated integration and package checks |

2server is a stateless CLI with no resident control plane, HTTP backend or web
frontend. Local connection/session files support a command; they are not a second
authority for VM configuration or a substitute for Terraform state. Do not add
a daemon, API/UI framework or background reconciler as part of an ordinary CLI
feature. New provider/template behavior enters through the existing contracts.

## Module layout

2server is organized by feature. Each module uses the layers it needs; there
are no empty layers, service classes, dependency-injection container or repository
interfaces to mirror concrete functions.

```text
src/
  cli.ts                         # stable Bun/npm executable, error reporting
  cli/
    main.ts                      # command composition and legacy entry points
    resources.ts                 # resource routing and local operation lock
  modules/
    apps/                        # native/Compose workloads and pods
    config/                      # composed server validation and manifest files
    control/                     # VM snapshots, sessions, locks and recovery
    domains/                     # DNS, certificates, Caddy and HTTPS verification
    extensions/                  # catalog, bindings and template lifecycles
    server/                      # bootstrap, VMs, disks and backup storage
    source/                      # desired App/Domain/Zone documents and init templates
    zones/                       # shared Cloudflare zone rate-limit and cache policy
  shared/
    domain/                      # validation primitives shared by features
    cli/                         # argument grammar and output helpers
    infrastructure/              # process/SSH, YAML, private session state
```

## Layers inside a module

| Layer | Responsibility | Examples |
| --- | --- | --- |
| `domain/` | Pure schemas, types and rules; no filesystem, SSH, environment or network access | App schema/replica identity, domain schema, snapshot merge, secret-reference policy |
| `application/` | Use cases and coordination of concrete adapters and other modules | Deploy/rollback, domain reconciliation, connected session, extension deployment |
| `infrastructure/` | External systems, persistence, provider commands and runtime representations | Docker/Compose scripts, Cloudflare client, certificate files, Terraform, VM locks |
| `cli/` | Command validation, presentation and dispatch into use cases | App commands, source-file commands, per-module resource handlers |

Import the owning file directly. Runtime dependencies of `domain/` stay in
`domain/` (plus Zod and pure standard-library operations). Domain types may refer
to the inferred `Config` type using **type-only imports**; importing its runtime
schema would load the extension catalog and break this boundary. `shared/` never
loads a feature module at runtime. Application code does not import CLI adapters.
The architecture tests enforce these boundaries, including static dynamic imports.

Application functions call concrete infrastructure functions directly. Use the
existing small operation objects or function parameters where tests substitute
external effects; do not add an interface for every function. Extension hook
contracts remain because they represent actual interchangeable runtimes.
Adapters can compose concrete helpers where needed: extension runtime hooks call
lifecycle/environment services, and manifest readers use the composed config
validator. This is a practical separation of responsibilities, not a rule that
every dependency needs an abstract port.

`config/application/config.ts` assembles feature schemas and catalog-dependent
validation. Leaf app, domain, server, service and source-document schemas live
with their modules. `config/infrastructure/` owns reading and atomic saving of
manifest files; a domain rule never opens a manifest.

## Extension templates

Follow [AGENTS.md](../AGENTS.md) and the
[extension boundaries](extension-boundaries.md). Template behavior enters
core only through explicit registry composition and the documented contracts.
Frozen compatibility CLI adapters have their own composition point; do not use
them to add new extension commands.

Definitions and their native adapters remain together under
`modules/extensions/infrastructure/templates/<name>/`. A service recipe can still
be added with just YAML. Native hooks, optional extension CLI commands and their
helpers stay beside that definition. The catalog reads this directory; the
registry assembles it with the allowlisted hooks. Generated spec types belong in
`modules/extensions/domain/specs.generated.ts`.

Run `bun run gen:extension-types` after editing a native definition. The generator,
registry, dynamic command loader and npm package all use the same template
location. See [the extension contract](extensions.md).

External runtimes use `Extension.source`. Their pure schema and provider behavior
live beside their template, with explicit registration of adapters. Generic source
commands handle flags, optional read-only credential sessions and presentation;
they do not branch on provider/template/`runtimeEngine` names. The VM engine skips
external workloads and rejects their targeted VM lifecycle operations. New runtime
registration must not require changing core dispatch.

## Command composition and routing

```text
installed 2srv (2server alias) → Node launcher → Bun src/cli.ts
  → cli/main.ts: public help and command composition
  → owning app/source/control/resource CLI handler
  → parse arguments and validate desired configuration
  → application use case / registered extension capability
  → infrastructure adapter: inspect or explicitly apply
  → verified result, state publication where applicable, CLI output
```

`src/cli.ts` is the stable entry point and final error boundary; it reports a
safe error message and sets a nonzero exit code on failure. `src/cli/main.ts`
owns dispatch order and compatibility entry points. Feature CLI handlers validate
their command grammar, call the owning use case and present results. Helpers in
`src/shared/cli/` own shared connection/resource parsing; do not duplicate those
rules in each module.

Validate unknown/duplicate flags, required values and incompatible options before
effects. Keep supported command syntax, defaults and help aligned with actual
handlers. Do not silently ignore an unsupported option or broaden a compatibility
alias to introduce new behavior. New extension verbs live in the template's
`commands` map and sibling `cli.ts`, discovered under `app NAME help`, not in core
grammar/help. YAML or remote state must never choose an arbitrary executable
module/path/URL.

CLI adapters may coordinate input/output for an operation, but policy, validation
and lifecycle belong to their owning modules. Preserve documented compatibility
paths; do not introduce forwarding source files solely to retain old internal
imports. Public command compatibility and internal module paths are distinct.

## Config, identity and credentials

Source documents own desired configuration; the VM owns secrets and applied
snapshots. Feature schemas stay with their domains, while
`src/modules/config/application/config.ts` composes them. Source parsing and
source-to-runtime conversion use the owning module and registered capabilities,
not independent CLI copies of schemas/defaults. See [Source configuration](source-config.md).

Native definitions own JSON Schema/defaults, with generated types in
`specs.generated.ts`; run `bun run gen:extension-types` after changes. External
templates own their pure schema in `domain/spec.ts`. Initialization must use
exclusive creation and preserve an existing operator file. Invalid/unknown
fields, unsupported runtime operations and unsafe declarations fail closed.

Bind every template to its named instance using the existing instance helpers:
`instanceName`, `instanceRoot`, `instanceSecret`, `extensionProject` and
`extensionRoot`. Multiple instances have distinct data, containers, secret scopes
and applicable backup destinations. Never guess a singleton or let a named app
fall back to global secrets.

Connected commands read VM credentials without a local `.env` fallback. Source
secret references use `provider: vm`; secret-setting commands accept a private
file, never secret values in argv. External templates may use an explicitly
read-only VM credential session; provider-side mutation does not authorize VM
locks, revisions or external workload publication into VM state.

Keep credentials out of plan output, process arguments, errors and logs. Process
failures must not dump captured stdout/stderr. Use restrictive modes for private
connections, sessions, release files and backups. Provider-aware SSH uses
`src/shared/infrastructure/process.ts:sshArgs`, preserving host-key checking and
structured GCP/direct SSH settings. See [Control state](control-state.md).

## Plan, apply and lifecycle

Every remote mutation needs `--apply`. Classify the actual operation, not the
flag alone: a read command must not create VM revisions or operation history.
Use the existing session/mutation classification and resource scope rather than
adding a private write path in a command.

Plans can inspect a VM/provider and resolve or pull image layers. They cannot
apply DNS/IAM, send notifications, run migrations or publish control state.
Offline validation proves schema/intent, not remote credentials, capacity or
readiness. Clearly distinguish validation, planned work and completed effects.

VM mutations retain resource locks, snapshot identity/conflict checks and scoped
state publication. Preserve concurrent changes and reject a stale or changed
identity rather than overwriting it. Lifecycle paths validate provider identity,
ownership and required secrets before effects. Foreign resources and stateful
data remain protected. Follow [Locking](locking.md) and
[Control recovery](control-state.md).

HTTP app releases resolve immutable image identity, run declared pre-deploy work,
wait for readiness, then switch traffic. Preserve rollback and public verification;
container startup alone is not success. Stateful updates/recovery follow their
own lifecycle and do not inherit stateless blue/green assumptions. Traffic
rollback does not reverse a database migration. Provider/domain failure after
rollout can leave a partial result; report the completed and pending stages so
the operator can inspect before retrying. Do not hide failure or retry destructive
effects blindly. See [Reliability](reliability.md) and
[Extension contracts](extensions.md).

External workloads manage their state through the registered provider adapter;
they reject unsupported VM operations. Retirement is explicit and scoped to owned
resources. Terraform/provider lifecycle uses the original manifest and durable
Terraform backend, not a temporary connected-command session.

## Adding or changing a command

1. Decide ownership: core resource/source command, feature command or template
   capability. Prefer an existing capability/recipe when it already expresses
   the operation.
2. Add pure schema/rules in the owning domain and behavior in its application /
   infrastructure layers. Register template hooks/capabilities explicitly.
3. Add the thin CLI adapter with strict flags, help, operation identity and
   plan/apply behavior. Reuse shared parsing, SSH, sessions and locking.
4. Verify failure behavior as well as success: invalid flags/config, missing
   credentials, foreign ownership, duplicate instances, failed readiness,
   snapshot conflict or unsupported external operations as applicable.
5. Update generated types when needed, operator docs, skill references and the
   unreleased changelog. Check installed packaging when runtime files/assets move.

## Verification

From the 2server directory:

```sh
bun run check
node scripts/check-docs.mjs
npm pack --dry-run --json > /tmp/2server-pack.json
node scripts/check-package.mjs /tmp/2server-pack.json
```

The default suite covers schemas, dry runs, failure/rollback cases, fake-process
transactions and concurrent snapshot writes, plus architecture boundaries.
Docker and Terraform integration suites are opt-in; see [development checks](development.md). Packaging
checks cover every source file, including YAML assets and dynamic extension
commands, not only the CLI executable.

For documentation-only edits, check local links and references; code changes
finish with `bun run check`. `tests/architecture.test.ts` checks module/template
dependency boundaries, while command tests verify grammar and effect routing.
Mocked success does not prove live IAM, DNS propagation or recovery. Name skipped
integration checks when those limits matter. Never target production from fixtures.

For runtime/packaging changes, follow [Release](release.md), including packed-file
and installed-artifact checks. `bun run release:check` verifies the package
without publishing. A documentation or local implementation request does not
authorize push/publish; the repository's `main` push workflow can release to npm.

## Native source deployment capability

`Extension.sourceDeployment` is a registered native capability, separate from
external `source`. Its owning template validates offline inputs, produces a safe
read-only plan/private artifact, applies exact reviewed facts, and optionally
verifies its public API after shared domains/TLS. `bindInstance` binds every
connected callback. Source CLI dispatches by capability presence, transports
private artifact text, and retains normal control locking/snapshot publication.
Only `applied` advances traffic; `initialized` may publish management installation
without authored source or domains. Pending/rejected outcomes fail the command.

[Soot](soot.md) owns its C1/C3 wire codec, receipt/staging, host supervisor, restart
and guarded restore beneath its template subtree. Registry is the sole native
composition point; no core template-name or runtime-engine branch selects it.
