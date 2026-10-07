---
name: 2server
description: Deploy and operate apps, domains, VMs and service templates with the 2server CLI (2srv). Use for 2server infrastructure operations and deployment integration, not unrelated application development.
---

# 2server

Use `2srv` (`2server` is the compatibility alias). Source App/Domain/Zone files
own desired configuration; the VM owns secrets and applied state. External
templates manage their workloads directly through their provider.

## Start in the consuming project

Run operations from the repository that owns the reviewed manifests and ignored
`.2server/connection.yaml`, not from this skill's directory. Resolve the exact
server, environment, provider account and resource ownership before mutation.
Examples are templates, never deployment targets.

Check `2srv help` and the selected manifest. The CLI needs Bun >= 1.3 and Node
>= 20. If missing, explain `npm install -g @2server/cli`; install or upgrade only
when that is in scope. Do not silently use a source checkout instead of the
operator's installed release.

Skill references are relative to this `SKILL.md`. When a reference names
`docs/`, `src/`, `scripts/` or `terraform/`, those paths belong to the **installed
product**, not this skill or the consuming project. Resolve that root with
`bun <absolute-skill-directory>/scripts/product-root.ts`; it follows the installed
CLI launcher and verifies the package identity. Read only the relevant document.
For product code changes, use the actual checkout's `AGENTS.md`, `BRANDING.md`
and `docs/ARCHITECT-CLI.md`, and run development commands from that checkout.

## Choose a reference

| Task | Read |
| --- | --- |
| Source files, fields, secret references, image tags, migrations, Zone policy | [Source configuration](references/source-config.md) |
| Connection discovery, VM-owned config, locks, control backup/recovery | [Control state](references/control-state.md) |
| Provision, SSH, stop/start a VM | [VM and connection](references/vm.md) |
| DNS, TLS, cache, domain retirement, Cloudflare credentials | [Domains](references/domains.md) |
| Add/adopt/remove apps, deployment scripts, CI, rollback | [Apps](references/apps.md) |
| Named templates, monitoring, notifications, image proxy, email routing | [Extensions](references/extensions.md) |
| PostgreSQL roles, backup/PITR, Redis/NATS, disk growth | [Stateful services](references/stateful.md) |

## Plan and apply

- Prefer `validate -f FILE`, `plan -f FILE`, then `deploy -f FILE --apply`
  for the selected source App. Zone policy uses `apply -f FILE --apply` without
  an app rollout. Inspect the actual Terraform plan for provisioning.
- Fresh VM: `init server NAME -o server.local.json`, edit SSH, then
  `server bootstrap -f server.local.json --env-file PRIVATE_FILE --apply`.
  Bootstrap requires an empty manifest. Existing published VMs use `connect`.
- Extensions are named apps: `init app NAME --template TEMPLATE -o FILE`, then
  the same source deployment flow. Use `app NAME help` to discover the selected
  **installed** template's commands; never guess a singleton or invent verbs.
- Every remote mutation requires `--apply`. Validate is offline; plans may inspect
  VM/provider state and pull image layers, but do not run migrations, issue
  certificates, send notifications or prove write permissions. Bootstrap dry
  run is offline intent only.
- The user's requested operation authorizes that operation. A request for a
  plan, skill or script does not authorize deployment. Ask only for missing
  consequential choices or work outside the authorized scope.

## Preserve state and recover deliberately

- Keep server/resource names, ownership labels, state paths and Terraform state
  stable. Keep deployment targets in the consuming repository or private operator
  directory. Never apply a new Terraform root over existing resources without
  import; never silently rename an installed resource.
- Supply secrets through private files and VM references. Do not print values,
  put them in argv, or commit real manifests, keys or state. Connected commands
  have no local dotenv fallback; named apps have no global-secret fallback.
  `secret set --app NAME` updates app secrets; `server env` updates shared VM
  credentials. Missing credentials: follow the relevant reference, name the key
  and setup command, and never ask for values in chat.
- Deletion is explicit retirement. Removing a file/entry does not uninstall
  resources. Stop retains a VM; destruction is separate. Preserve foreign
  resources, data volumes, deletion protection, readiness and traffic rollback.
- Stop on unresolved authentication, ownership, conflict or health failure.
  Inspect before a bounded retry; do not force locks, weaken TLS/authentication
  or retry an ambiguous notification send. Use provider-aware SSH helpers,
  not guessed provider-specific command strings.

Verify the requested result, including an appropriate failure/access case when
relevant. Report the target, completed and pending stages, evidence and blockers.
Distinguish local validation from live effects; container startup alone is not
deployment success, and traffic rollback does not undo database migrations.
