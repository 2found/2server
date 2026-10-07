# Documentation

Read the [documentation website](https://2found.dev/docs/2server/) for navigable
guides, section links and copyable examples. This directory remains the source
of truth; the website publishes a snapshot linked to its source commit.

Start with the [README quick start](../README.md#quick-start). All paths and source
commands assume a standalone 2server checkout. App manifests and operational
evidence belong to the repository using 2server.

## Operate

| Task | Reference |
| --- | --- |
| App/Domain/Zone fields, secrets, bindings, migrations | [Source configuration](source-config.md) |
| Provision a VM, configure Cloudflare, adopt Compose, retire resources | [Operator guide](operator-guide.md) |
| Create a token with the correct Account/Zone permissions and resources | [Cloudflare tokens](cloudflare-tokens.md) |
| Connect from another machine, inspect locks, back up or restore control state | [Control state](control-state.md) |
| Concurrent releases, snapshot conflicts and interrupted work | [Locking](locking.md) |
| Readiness, capacity, monitoring and Redis/NATS durability | [Reliability](reliability.md) |
| PostgreSQL credentials, backup and isolated restore | [PostgreSQL](postgres.md) |
| Cloudflare inbound forwarding, verification and mail conflicts | [Email routing](email-routing.md) |

For agent installation and marketplaces, read [agent plugins](agent-plugins.md).
For operations, the [skill](../skills/2server/SKILL.md) selects a focused reference for
each task. CLI `help` describes core commands; `app NAME help` describes the
selected installed template. `help legacy` covers compatibility grammar.

## Build and release

| Task | Reference |
| --- | --- |
| Contributor constraints and naming | [AGENTS.md](../AGENTS.md), [BRANDING.md](../BRANDING.md) |
| CLI routing, layers, state and lifecycle | [CLI architecture](ARCHITECT-CLI.md) |
| Add a recipe, native hook, external runtime or template command | [Extension authoring](extensions.md) |
| Shared contributions and retained compatibility contracts | [Extension boundaries](extension-boundaries.md) |
| Local tests, Docker and Terraform checks | [Development](development.md) |
| Package verification, publishing and staging acceptance | [Release](release.md) |
| Changes and work not yet shipped | [Changelog](../CHANGELOG.md), [Roadmap](roadmap.md) |

The source schema, CLI help and template definitions describe supported behavior.
Roadmap proposals are not commands or installed capabilities.
