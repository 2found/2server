# Extension boundaries and audit

2server is an independent repository. Its [AGENTS.md](../AGENTS.md) defines
contributor rules; this document records the extension boundary and the audit
behind those rules. Product documentation, schemas and tests must work from a
standalone checkout. Consuming repositories own live manifests and operational
evidence.

## Ownership

Core owns argument handling, explicit composition, validation of shared
contracts, instance binding, resource ownership, locking, persistence and shared
deploy engines. Templates own service/provider semantics, custom validation,
commands, health/backup behavior and extension-specific state. See
[architecture](architecture.md) and [authoring](extensions.md).

A YAML-only Service recipe needs no core changes. Native hooks and external
runtime adapters need one registration in
`src/modules/extensions/application/registry.ts`. That composition is deliberate;
the source dispatcher and VM lifecycle must not gain an extension-name branch.
These extensions ship in the CLI package and share infrastructure helpers. They
are not independently installed or sandboxed plugins.

## Audit of shipped templates

| Template | Coupling found | Result |
| --- | --- | --- |
| `postgres` | Backup-storage inspected PostgreSQL specs for pgBackRest; monitoring imported its alerts; legacy backup/restore dispatch lived in generic resource handling | Permission intent, alert groups and diagnostics now come from capabilities; legacy behavior lives in `postgres/legacy.ts` |
| `monitoring` | Main CLI imported monitoring settings/credential paths; control snapshot/capture hardcoded its portable state; generic resource handler rendered its diagnostics | Summary and state declarations now belong to the template; legacy webhook/monitor handling lives in `monitoring/legacy.ts` |
| `redis` | No service-specific deployment branch outside registration; memory bounds, secret files and sysctl already lived in its native hook | Retained the existing hook, generated schema and shared stateful engine |
| `nats` | No service-specific deployment branch outside registration; JetStream bounds/config and readiness already lived in its native hook | Retained the existing hook, generated schema and shared stateful engine |
| `image-proxy` | No service-specific deployment branch outside registration; secret validation, source restrictions and removal checks already lived in its native hook | Retained template ownership and existing runtime identity |
| `url-shortener` | Source dispatcher previously knew Worker schema, script files and deploy function | Schema, adapters and source hook now live beside the template; core uses `Extension.source` |
| `email-routing` | Source dispatch, validation and VM guards previously branched on the email engine | Template owns schema, verification/DNS/rule/IAM behavior and source hook; core uses generic capabilities |

Monitoring no longer imports PostgreSQL implementation files. It receives static
alert groups through `extensionAlertRules()`. Each registered template contributes
one rule set for its metrics, preserving the existing `host`, `postgres`, `runtime`
groups and avoiding duplicates when several PostgreSQL instances are installed.

## Contribution contract

Optional fields in `ExtensionHooks`/`Extension` serve the existing shared use cases:

- `summary(config, state)`: safe operator messages; print references/paths, never
  credential values. Named monitoring instances report their own URL and path.
- `diagnostics(config)`: read-only shell fragments consumed by diagnostic output;
  use bound instance identity and normal shell quoting.
- `backupStoragePermissions(config)`: object-admin permission intent. PostgreSQL
  requests it for pgBackRest; dump backups do not request it. Core computes
  shared provisioning intent without inspecting a provider-specific spec.
- `alertRules`: static Prometheus groups supplied once per template, including
  groups needed for retained metrics from disabled or retired workloads.
- `controlState`: declared roots and a strict schema for portable paths. Control
  composes them with its own certificate/Compose/history allowlist. Roots and
  paths must be relative, bounded and free of traversal; undeclared files and
  symlinks remain refused. Deactivating an instance does not discard its saved
  credentials. State remains private and subject to snapshot size limits.

Configuration-dependent hooks are wrapped by `bindInstance`. Static catalog
contributions are collected once per template. Keep new capabilities tied to a
real shared use case; do not add a generic hook execution language.

## Frozen compatibility contracts

The following remain intentionally supported. They are not the onboarding path
for a new extension:

- `shared/cli/resource-request.ts` and `cli/resources.ts` retain existing grammar,
  aliases and routing for `postgres`, `monitor`, `webhook`, and `recovery`.
  `extensions/cli/legacy.ts` explicitly composes only template-owned legacy
  adapters. New commands use the YAML command map and `app NAME` loader.
- Legacy keys (`postgres`, `redis`, `nats`, `monitoring`, `imageProxy`,
  `alertWebhookEnv`, `webhooks`) and exported registry aliases keep old manifests
  working. Their presence is not permission to put new service logic in config.
- Monitoring's `monitoring-credentials.json` and
  `monitoring/NAME/credentials.json` paths remain unchanged. The template now
  declares both; capture and snapshot validation share the same policy.
- GCS backup Terraform input keeps the `pgbackrest_enabled` name and the legacy
  backup-storage result keeps its `/postgres` destination suffix. The permission
  decision belongs to the capability, and templates choose their own object
  prefixes using the shared bucket identity. This review performs no state or
  Terraform migration.
- Shared output protocols such as `redis`, `nats` and `postgresql` are connection
  vocabulary, rather than runtime dispatch identities.

Do not remove these contracts during an isolation cleanup. A breaking migration
requires a separately described migration and acceptance checks.

## Enforcement and evidence

`tests/architecture.test.ts` rejects template implementation imports outside
registry/legacy composition, sibling-template imports, core reads of built-in
template config fields, runtime identity dispatch, domain effects and shared
feature dependencies. The existing generic command loader checks the catalog's
command allowlist before dynamic import.

`tests/extension-contributions.test.ts` covers bound summaries and diagnostics,
backup permission intent, third-template alert/state contributions, retained
legacy credentials, undeclared paths, traversal and symlink rejection.
`tests/external-extension-runtime.test.ts` registers another runtime and exercises
source dispatch without changing core, including rejected VM operations.

Run `bun run check` and the [artifact checks](release.md) after changing these
contracts. The default suite uses isolated fixtures/mocks; local passing tests
do not establish live IAM, DNS, email delivery or production restore health.
