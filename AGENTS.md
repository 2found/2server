# AGENTS.md

**2server** is a 2found tool in [2found/2server](https://github.com/2found/2server),
shipped as the `@2server/cli` package: a Bun
CLI that deploys apps, domains and named extension templates on operator-owned
infrastructure. It has no resident control plane. Run all commands from this
repository's root, even when it is checked out inside another project.
Deployment targets belong to consuming repositories, not this product.

Read [BRANDING.md](BRANDING.md) before naming commands, products or user-facing
concepts, or writing README, docs or marketing copy. Use `2srv` in new command
examples; keep `2server` as a compatibility alias and preserve existing state,
schema, package and resource identities.
Every product website, landing page and docs site uses **2ui** (`@tofound/ui`)
components and design tokens, as specified in [BRANDING.md](BRANDING.md).

## Ownership and architecture

Read [CLI architecture](docs/ARCHITECT-CLI.md) before changing code, and
[extension authoring](docs/extensions.md) plus
[extension boundaries](docs/extension-boundaries.md) for extension work.

Use the module map in [CLI architecture](docs/ARCHITECT-CLI.md#module-layout)
to find the owning file. The shipped operating skill is `skills/2server/`;
Terraform provider roots live in `terraform/` and isolated checks in `tests/`.
The skill plugin and both marketplace catalogs follow [agent distribution](docs/agent-plugins.md).
Keep the Claude/Codex plugin identities and independent plugin versions aligned.

Within a module, `domain` is pure validation/types/rules, `application` coordinates
use cases, `infrastructure` owns effects/adapters, and `cli` validates arguments,
dispatches and presents results. Import the owning file directly. Runtime domain
imports stay in domain; references to composed `Config` must be type-only.
`shared` must not load features. Application code must not import CLI adapters.
Do not add empty layers or an interface around every concrete helper.

## Hard constraints

- **Extension behavior belongs to the extension.** Keep its declaration,
  provider/service schema, validation, lifecycle, commands and supporting files
  under `src/modules/extensions/infrastructure/templates/NAME/`. Use a YAML-only
  Service recipe when sufficient, native hooks for specialized VM behavior, and
  `ExternalRuntime`/`Extension.source` for workloads outside the VM. Core
  dispatches through capabilities; never add a switch on extension/template/
  provider engine names to source dispatch, VM deployment or unrelated modules.
  An external runtime's `runtimeEngine` is metadata, not a dispatch condition.
- **Composition is explicit.** Register shipped native hooks and external
  adapters in `extensions/application/registry.ts`. Extension-specific commands
  belong in the definition's `commands` map and sibling `cli.ts`, under
  `app NAME ...`; do not add them to core help or grammar. YAML and VM state
  must never select executable modules by arbitrary filesystem path or URL.
  Cross-extension capabilities use the contract/registry, not sibling-template
  implementation imports. New capabilities must serve a concrete use case.
- **Preserve compatibility deliberately.** Existing aliases, legacy manifest
  keys, state paths and Terraform variable names may remain as documented
  compatibility contracts. Keep legacy behavior in template-owned adapters,
  with explicit composition and regression coverage. Do not extend frozen
  compatibility grammar to onboard a new extension or silently rename existing
  containers, data paths, credentials, backup prefixes or ownership labels.
- **Instance identity is mandatory.** Use bound config and `instanceName`,
  `instanceRoot`, `instanceSecret`, `extensionProject` and `extensionRoot`.
  Never select an instance by guessing a singleton. Two instances must have
  distinct data, secrets, containers and applicable backup destinations.
  Named apps must not fall back to global secrets.
- **Source owns desired configuration; the VM owns secrets and applied state.**
  Source App files use `provider: vm` references for VM secrets. Connected
  commands have no local `.env` fallback. External workloads may explicitly
  read credentials through a read-only VM session; that session must not
  publish workload state, acquire mutation locks or create VM revisions.
- **Never commit or print credentials.** No real `.env`, tokens, database URLs,
  webhook URLs, SSH keys, control backups, Terraform state or live manifests.
  Use placeholders in `.env.example` and `examples/`. Keep secret values out of
  process arguments, error bodies, logs and plan output. Private state and
  release files must retain restrictive permissions.
- **Every remote mutation requires `--apply`.** Validate scope, provider
  identity, ownership, secrets and known conflicts before effects. A plan may
  inspect providers/VMs and resolve images but must not apply DNS, change IAM,
  send notifications, run migrations or publish control state. Initialization
  must not overwrite operator files. Preserve foreign resources and user data.
- **Keep lifecycle guarantees.** Retain locking, snapshot conflict detection,
  readiness checks, traffic rollback and stateful data protection. Do not
  bypass deletion protection, weaken TLS/auth, suppress health failures or
  report success from container startup alone. External resources must reject
  VM lifecycle operations. Retirement is explicit and scoped to owned resources.
- **One schema/default source.** Native definitions own their JSON Schema and
  defaults; generate `specs.generated.ts` with `bun run gen:extension-types`.
  External templates own their pure schema in `domain/spec.ts`. Do not duplicate
  schemas, defaults, image lists or command maps in core. Unknown fields,
  unsupported runtimes and unsafe declarations must fail closed.
- **Provider-aware SSH has one implementation.** Use structured SSH config and
  `shared/infrastructure/process.ts:sshArgs`; do not scatter GCP/AWS/direct SSH
  command strings through templates or scripts.

## Run and verify

Requires Bun >= 1.3 and Node >= 20. From this repository's root:

```sh
bun install --frozen-lockfile
bun src/cli.ts help
bun run check
node scripts/check-docs.mjs
```

For focused changes, run the relevant tests first; finish code changes with
`bun run check`. Include an adverse case for new behavior: missing credentials,
foreign ownership, duplicate instances, failed readiness, unsupported operation
or concurrent changes as applicable. A passing mocked test does not prove live
IAM, DNS propagation, delivery or disaster recovery. State which integration
tests were skipped and why when those limits matter.

Use [development checks](docs/development.md) for isolated Docker and Terraform
verification. Never point fixtures at production. When moving runtime files or
changing packaging, verify the packed file list and installed artifact using
[the release runbook](docs/release.md). Do not publish or push merely to finish
a local review: the repository's `main` push workflow can publish to npm.

## Operations and documentation

Use [the docs index](docs/README.md) to select the reference for the task.
Keep README focused on first deployment and command/skill discovery; docs own
full contracts. Do not add implementation journals or consuming-project QA logs
to the product root.

Read the [operator guide](docs/operator-guide.md),
[source contract](docs/source-config.md) and
[control recovery](docs/control-state.md) for the operation being changed.
Examples are templates, never authorized deployment targets. Keep public product
docs generic and repository-relative; real hostnames, account IDs, recipient
inboxes and consuming-app deployment evidence belong outside this repository.

Update architecture/extension contracts, operating docs, skill references and
the unreleased changelog when their supported behavior changes. Record review
findings with the extension, concrete coupling, resolution and any compatibility
exception. Report what changed, verification and remaining limits; distinguish
local code changes from live infrastructure changes.
