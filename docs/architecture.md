# Source architecture

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
    source/                      # desired App/Domain documents and init templates
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

Definitions and their native adapters remain together under
`modules/extensions/infrastructure/templates/<name>/`. A service recipe can still
be added with just YAML. Native hooks, optional extension CLI commands and their
helpers stay beside that definition. The catalog reads this directory; the
registry assembles it with the allowlisted hooks. Generated spec types belong in
`modules/extensions/domain/specs.generated.ts`.

Run `bun run gen:extension-types` after editing a native definition. The generator,
registry, dynamic command loader and npm package all use the same template
location. See [the extension contract](extensions.md).

## Finding the old files

| Previous file | Current owner |
| --- | --- |
| `src/config.ts` | `modules/config/application/config.ts`; app/server/domain schemas live in their modules; file reading in `modules/config/infrastructure/file.ts` |
| `src/apps.ts` | `modules/apps/application/{deploy,environment}.ts`, `domain/replicas.ts`, `infrastructure/runtime.ts` |
| `src/compose-apps.ts` | `modules/apps/infrastructure/compose.ts` |
| `src/control.ts` | `modules/control/cli/command.ts`, `application/{session,snapshot,operations}.ts`, `domain/secrets.ts`, `infrastructure/{files,connection,portable-state}.ts` |
| `src/resources.ts` | `cli/resources.ts`, `modules/*/cli/resource.ts`, `shared/cli/resource-request.ts` |
| `src/documents.ts`, `src/file-command.ts` | `modules/source/{domain,application,cli}/` |
| `src/domains.ts`, `src/edge.ts` | `modules/domains/application/reconcile.ts`, `infrastructure/edge.ts` |
| `src/stateful.ts`, `src/deploy-extensions.ts` | `modules/extensions/application/{stateful,deploy}.ts` |
| `src/process.ts` | `shared/infrastructure/process.ts` |

The public executable remains `bun src/cli.ts` / `2server`. Command names,
manifest formats and paths stored on the VM remain unchanged. Old internal source
paths have no compatibility forwarding files; imports and shipped developer
references use the owning module.

## Verification

From the 2server directory:

```sh
bun run check
npm pack --dry-run --json > /tmp/2server-pack.json
node scripts/check-package.mjs /tmp/2server-pack.json
```

The default suite covers schemas, dry runs, failure/rollback cases, fake-process
transactions and concurrent snapshot writes, plus architecture boundaries.
Docker and Terraform integration suites are opt-in; see [development checks](development.md). Packaging
checks cover every source file, including YAML assets and dynamic extension
commands, not only the CLI executable.

### Lohi smoke verification (2026-10-03)

The refactored CLI was checked against the connected `lohi-app` VM:

- `get app`: lists the nine Compose apps and five installed templates.
- `get pod`: lists all 24 containers after the inspection fix (15 running, nine stopped).
- `server lock`: reads the existing operation lock without modifying it.
- `app monitoring webhooks`: loads the template command and lists receiver metadata.
- `app postgres help`: discovers the installed PostgreSQL commands.
- `deploy app api` without `--apply`: prints the dry-run instruction.
- `app redis backup`: rejects a command not installed for that template.

Live `get pod` exposed an existing Docker inspection bug: a container without a
healthcheck has no `State.Health` key. Direct Go-template access aborted the
entire list at `agentray-web`. The inspection now uses optional map lookup and
reports `health: "none"`. A real-Docker regression covers absent and healthy
healthchecks, absent generations and rejection of foreign Compose ownership;
it failed before the fix and passed after it. These checks read or plan against
Lohi; they do not roll its workloads or change its configuration.
