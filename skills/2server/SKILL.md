---
name: 2server
description: Operate 2server.app infrastructure from a server manifest—provision or stop VMs, configure provider-specific SSH and Cloudflare domains, add or remove apps and extensions, and deploy apps with scripts or CI. Use for 2server operations and integration work, not unrelated application feature development.
---

# 2server

Use the existing 2server implementation and one manifest per VM. Locate the
product root by finding `src/cli.ts` and `package.json` with name `2server`;
it may be the checkout root or a `2server/` submodule. Resolve repository paths from the active
checkout, not a hardcoded developer path. Read its `README.md`, applicable
`AGENTS.md`, and the selected manifest before operating. Run commands from the
product root. Treat `src/config.ts` and `bun src/cli.ts help` as the supported
contract; examples are templates, never deployment targets.

## Select the workflow

Read only the reference needed for the request:

- VM provisioning, SSH, stop/start: [VM and connection](references/vm.md).
- Cloudflare, hostname, certificates, cache or domain retirement:
  [Domains](references/domains.md).
- App onboarding, removal, deployment scripts, CI or rollback:
  [Apps](references/apps.md).
- PostgreSQL roles, WAL/PITR, restore checks, Redis, NATS and disk growth:
  [Stateful services](references/stateful.md).
- Monitoring or image proxy installation/removal:
  [Extensions](references/extensions.md).

## Shared operating rules

- Declare SSH in each manifest's `ssh` object. GCP uses `kind: "gcp"` and IAP;
  AWS and other directly reachable VMs use `kind: "ssh"`. Derive commands with
  `src/process.ts:sshArgs`; do not scatter provider-specific SSH strings through
  deploy scripts. See the VM reference for displaying the resolved command.
- Resolve the exact server, environment, cloud account and resource ownership
  before mutation. The user's requested operation authorizes that operation;
  do not repeatedly ask for approval already given. A request to create a skill,
  script or plan is not a request to deploy it. Ask only for missing consequential
  choices or actions outside the authorized scope, after preparing concrete work.
- Keep manifest names stable: DNS comments, edge ownership and operator state
  depend on them. Keep all managed domains in the manifest even when deploying
  one app. Keep deployment-specific resources in the consuming repository or
  an ignored operator directory; never publish them in the generic product.
  Do not apply a new Terraform root over existing resources without state import.
- Secrets are environment/secret-manager references. Keep credentials, private
  keys, state and real local manifests untracked. Do not log secret output or
  pass secrets in command arguments. Preserve `~/.local/state/2server/<name>/`
  privately; monitoring credentials and certificate renewal depend on it.
  For local operators, prefer the product checkout's ignored `.env` (mode 0600)
  for Cloudflare credentials and `MONITORING_PASSWORD`; run Bun from that root.
  Use `extensions.monitoring.passwordEnv` to select the password variable.
- If a Cloudflare credential is missing, stop the affected operation and give
  the user the setup steps in [Domains](references/domains.md#missing-key-or-permission-failure),
  including the exact environment variable and `2server/.env` location.
  For 401/403, report the failed operation and explain permissions and resource
  scope. Do not just repeat the error or ask the user to paste a token into chat.
- CLI mutations require `--apply`. `plan` inspects Cloudflare; other dry runs
  describe intent and do not guarantee that a deployment will succeed. Inspect
  the actual Terraform plan for provisioning.
- Removal is an explicit retirement operation: deleting a JSON entry does not
  uninstall resources. Use `delete <resource> NAME -f manifest --apply` for
  owned app/domain/extension retirement. Use `stop vm` for shutdown; VM deletion
  uses the original Terraform state and is distinct from stopping. Never bypass
  deletion protection or invent flags to obtain a green command.
- Stop after an unresolved authentication, ownership or health failure. Inspect
  the actual state and cause before a bounded retry; do not blindly rerun apply
  or weaken TLS/authentication to make verification pass.

Finish with the target, changes made, verification evidence and any remaining
blocker. Distinguish local validation from a live deployment. Never report an
operation complete from a successful container start alone.
