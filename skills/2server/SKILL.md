---
name: 2server
description: Operate 2server, the 2found infrastructure and deployment tool, from source App/Domain files and extension templates—provision or stop VMs, configure provider-specific SSH and Cloudflare domains, add or remove apps and extensions, and deploy apps with scripts or CI. Use for 2server operations and integration work, not unrelated application feature development.
---

# 2server

Use source App/Domain files and extension templates for desired workloads, and VM control state for secrets, shared infrastructure and deployment history. Locate the
product root by finding `src/cli.ts` and `package.json` with name `@2server/cli` (older checkouts: `2server`);
it may be the checkout root or a `2server/` submodule. Resolve repository paths from the active
checkout, not a hardcoded developer path. Read its `README.md`, applicable
`AGENTS.md`, and the selected manifest before operating. Run commands from the
product root. Use `2srv` for installed commands (`2server` is the compatibility
alias); preserve state/schema paths and the skill name. Read `BRANDING.md` before
naming commands or writing public copy. For code changes, read `docs/ARCHITECT-CLI.md` for command routing, module/layer ownership and plan/apply boundaries. Treat `src/modules/config/application/config.ts` and `bun src/cli.ts help` as the supported
contract; examples are templates, never deployment targets.

## Select the workflow

Read only the reference needed for the request. `docs/README.md` indexes the
maintained operating and contributor contracts:

- Source files, `-f`, templates, image tags and secret CLI: [Source config](references/source-config.md).
- Switching machines, VM-owned config/secrets, `.2server/`, backup/recovery:
  [Control state](references/control-state.md).
- VM provisioning, SSH, stop/start: [VM and connection](references/vm.md).
- Cloudflare, hostname, certificates, cache or domain retirement:
  [Domains](references/domains.md).
- App onboarding, removal, deployment scripts, CI or rollback:
  [Apps](references/apps.md).
- PostgreSQL roles, WAL/PITR, restore checks, Redis, NATS and disk growth:
  [Stateful services](references/stateful.md).
- Monitoring, Discord webhook CRUD/test, or image proxy installation/removal:
  [Extensions](references/extensions.md).

## Shared operating rules

For CLI release preparation, use `docs/release.md` and `bun run release:check`.
Consult `docs/roadmap.md` for proposed runtimes; proposals are not installed
templates or supported commands, except the shipped `url-shortener` Worker
runtime and the `email-routing` Cloudflare template (see `docs/email-routing.md`).
Email Routing may read VM-owned credentials through an explicit connection,
but both templates manage their workloads directly in Cloudflare. Keep extension
operations under `app NAME`.

- Fresh VM: `init server NAME -o server.local.json` (or provision with `--output`),
  then `server bootstrap -f server.local.json --env-file PRIVATE_FILE --apply`.
  Bootstrap combines setup, publication and connection; it requires an empty
  server manifest. `connect` alone requires already published VM state.
- Extension = template. Use `init app NAME --template TEMPLATE -o FILE`, then
  the same `deploy -f FILE` and `app NAME ...` as any app. Always select the
  instance name, not a guessed singleton. `app NAME help` discovers additional
  commands only after installation. Keep extension CLI handlers in the extension;
  never add DB/monitoring verbs to core help or dispatch.
- Prefer `deploy -f app/2server/deploy.yaml` or `deploy -f platform/NAME.yaml`.
  Shared Cloudflare rate limits and optional `spec.cacheRules` use a `kind: Zone`
  file and the same `plan` /
  `apply -f FILE --apply` workflow, without an app rollout. Inspect shared zone
  capacity and explicit hostname/path scope; never replace foreign rules. Cache
  rules respect origin headers and query strings; allow cookies only for
  viewer-identical public assets. See [Zone configuration](references/source-config.md#optional-cache-rules)
  for a complete example, defaults, precedence and permissions. Turnstile is
  application-owned and is not provisioned by 2server.
  Source owns public app configuration; VM owns secret values and actual state.
  `connect` saves only private SSH in ignored `.2server/connection.yaml`.
  Use the source-config reference; old whole-server manifests are bootstrap/legacy only.
- Declare SSH in each manifest's `ssh` object for bootstrap/provider identity. GCP uses `kind: "gcp"` and IAP;
  AWS and other directly reachable VMs use `kind: "ssh"`. Derive commands with
  `src/shared/infrastructure/process.ts:sshArgs`; do not scatter provider-specific SSH strings through
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
  In connected mode the VM owns these values; use `server env --env-file
  secrets.env --apply`, then reload the affected service/domain. A local `.env`
  is bootstrap/legacy input only, never a fallback for missing VM secrets.
  Named template apps use `secret set --app NAME`; their `*Env` fields reference
  the App file’s secret map. Legacy singleton fields retain their old scope.
- If a Cloudflare credential is missing, stop the affected operation and give
  the user the setup steps in [Domains](references/domains.md#missing-key-or-permission-failure),
  including the exact variable and `server env` command for connected mode,
  or `2server/.env` for initial publication/legacy mode.
  For 401/403, report the failed operation and explain permissions and resource
  scope. Do not just repeat the error or ask the user to paste a token into chat.
- Remote mutations require `--apply`. Bootstrap dry run is offline intent.
  Source App/Domain plans inspect VM state and Cloudflare; image tags can pull
  layers. Plans do not run migrations, issue certificates or prove health/write
  permissions. Inspect the actual Terraform plan for provisioning.
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
