# Extension templates and named apps

## Cloudflare email

Use `init app NAME --template email-routing -o FILE` for Free inbound forwarding.
Read `docs/email-routing.md` for the strict account/zone/routes spec and required
permissions. `docs/cloudflare-tokens.md` separates Account destination rights
from Zone rules/settings rights; `replaceMx` additionally needs Zone DNS Edit.
Plan/deploy/get use Cloudflare directly. If the token lives on the
VM, pass `--connection FILE` to read it through control state without writing
the VM. Missing destinations need inbox verification before DNS/rules activate.
Preserve foreign MX/SPF unless an explicitly reviewed obsolete apex MX is listed
in `replaceMx`. `manageTokenPermissions` is an opt-in for account-owned token
administrators: only append Email Routing Rules Write to one existing exact-zone
allow policy, never broaden resources. Preserve foreign rules, catch-all and
shared destinations. For a newly authorized zone, a separate
`createZoneTokenPolicy: true` opt-in with a pinned account allows a new policy
limited to that exact zone and the four minimum email setup rights. It does not
expand existing policies; review the permission-only plan before apply.
Retirement is explicit. No mailbox or outbound SMTP is created. Resolve exact domains, aliases
and destination inboxes before live configuration; never infer the destination
from a cloud login identity.

## Cloudflare Workers

Read `docs/cloudflare-tokens.md#workers-and-d1` for the `url-shortener` token.
It needs Account D1 and Workers rights, plus Zone Read and Workers Routes Write
on the custom-domain zone. New Workers require product Admin with the newer
roles; Custom Domains cannot use a per-Worker-only role. Plans verify the active
zone belongs to `spec.accountId` and list D1 before writes, but do not prove
upload/custom-domain write rights. Use the local process credential; this
template does not read VM secrets. Stop on scope/account failures before retrying.

Read `docs/extensions.md` under the installed product root for the maintained authoring,
binding and CLI contract. An extension is a template; users operate a named App.
For external-runtime code changes, keep schemas and provider operations beside
the template and register its `ExternalRuntime` adapter once. Core dispatches
through `Extension.source`; do not add engine-name branches to source or VM CLI.
Follow the standalone repository's `AGENTS.md` and `docs/extension-boundaries.md`.
Native templates supply summaries, diagnostics, backup permissions, alerts and
portable state through capabilities. Keep legacy behavior in template adapters;
never import a sibling template's implementation to contribute alerts or state.

```bash
2srv init app orders-db --template postgres -o platform/orders-db.yaml
2srv secret set --app orders-db --env-file /private/database.env --apply
2srv plan -f platform/orders-db.yaml
2srv deploy -f platform/orders-db.yaml --apply
2srv app orders-db help
2srv app orders-db backup --apply
```

- `kind: App`, `metadata.name` and `template` identify the instance. Do not infer
  that a template is installed from catalog presence or an init-generated file.
  Multiple apps can use one template; never select a DB by template alone.
- Use the common `app NAME get|deploy|logs|restart|delete` operations. Stateful
  apps use in-place lifecycle and explicit recovery, not traffic rollback.
  Backup/restore must target the selected database app. Deletion retains data.
- New template apps use app-scoped VM secrets. Their top-level `secrets` maps
  native `*Env` names to VM keys; never fall back to local/global values. Keep
  data paths and backup destinations exclusive. Do not rename instances or
  change data/role identity as an implicit migration.
- `app NAME help` exposes only the installed template's additional commands.
  New commands belong in its `commands` YAML map and sibling `cli.ts` exporting
  `run(config, command, args)`. No core CLI/help change is needed. Core operations
  cannot be shadowed; mutations default to intent and require `--apply`.
- Reuse generic Service recipes when sufficient; native hooks handle special
  lifecycle needs. Use runtime identity/secret helpers with the bound config.
  Never interpolate executable code into YAML or load command modules from a
  URL or VM-supplied path. Verify two instances do not collide.
- Bind consumers by instance: `DATABASE_URL: {app: orders-db, output: appUrl}`.
  Outputs resolve only into private runtime state. Providers must be healthy;
  deleting one with consumers is refused. Reapply consumers after rotation.

## Monitoring and images

Create monitoring as `init app metrics --template monitoring -o FILE`. Edit its
zone/hostname and set its password with `secret set --app metrics`. Deploy owns
readiness, authenticated Caddy routing and Cloudflare setup. Test anonymous and
wrong-password rejection as well as readiness. Generated credentials are private
VM state; report locations, never values.

After updating monitoring, compare installed Apps with live `two_container_healthy`
series, including stateless templates and sidecars. The extension discovers installed
Apps from VM config and Compose bundles each minute; no core inventory is needed. Verify a
missing container becomes zero, not a vanished target. Whole-VM outage alerts need
an external check with a notification policy; local Prometheus cannot provide them.

Explicit `containers`/`upstreams` follow the current VM control revision on each
collection, using this monitoring App's spec. Managed retirement excludes retained
targets even if an old explicit observation remains. For unmanaged services,
remove the retired targets from the monitoring source file and apply it; absence
alone still means an outage. Existing collectors need one monitoring deployment
with the updated CLI to adopt this discovery behavior. Invalid control state
preserves the last complete metrics file and triggers collector-staleness alerts.

Monitoring receiver definitions belong in the App's `webhooks` list, with URL
secret references in its secret map. Apply the file to change receivers. Inspect
with `app metrics webhooks`; send a test only when requested using
`app metrics webhooks test RECEIVER --apply`. No automatic retry after ambiguous
send failures. Store Discord URLs privately, never in source or chat.

Image-proxy templates require hex key/salt secrets and HTTPS allowed source
prefixes. Use bindings for their internal endpoint. Verify unsigned/invalid
requests fail before exposing a public route.

## Existing installations

Legacy Extension/Service inputs remain compatible and keep their old runtime
identity and secret scope. Their installed names work with `app NAME ...`.
Do not rewrite a legacy file as a newly named App and claim it adopted the old
data. Review migration explicitly. Missing credentials, ownership conflicts or
unhealthy dependencies are stopping conditions, not reasons to weaken guards.

## Soot

Read [Soot](soot.md) before using this native template. It requires pinned runtime
receipt/C1 input and exact private source-review artifacts. Initialization applies
only management; source/traffic needs a new reviewed C3 plan. No legacy singleton
command, implicit overwrite, concurrent bbolt opener or generic rollback applies.

## Platform search

Read `docs/meilisearch.md` for the standalone `meilisearch` template. Use
`init app platform-search --template meilisearch`; the operator imports its
app-scoped master key and applies the reviewed manifest. Persistent data and
private credential files belong to the named instance. Only the internal endpoint
is published; product API keys are created separately. Soot data-pool integration
is a separate optional service/Pack and never installs this search engine.
