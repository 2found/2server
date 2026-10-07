# Cloudflare and domains

Read `docs/cloudflare-tokens.md` for token creation, Account/Zone permissions,
resource scope and verification limits. Read
`docs/operator-guide.md#cloudflare-access-and-ownership` and `docs/source-config.md`
for the maintained ownership and schema contracts.

## Credentials

Use a scoped bearer API token in `cloudflare.tokenEnv` (default
`CLOUDFLARE_API_TOKEN`); `originTokenEnv` can select a separate issuance token.
A Global API Key or Origin CA service key is not a bearer token. Never request
values in chat or put them in command arguments.

- New VM: private mode-0600 dotenv file supplied to
  `server bootstrap -f server.local.json --env-file PRIVATE_FILE --apply`.
- Connected VM: `secret set --env-file PRIVATE_FILE --apply`; `secret list`
  shows names only. A local `.env` is never a fallback for a missing VM value.
- Legacy/local manifest: ignored mode-0600 dotenv or CI secret store. Bun loads
  `.env` from cwd; avoid a stale exported variable overriding it.

## Missing key or permission failure

Name the exact missing variable and the command appropriate to the mode above.
For 401/403, identify the failed operation and check token expiry, zone permissions
and managed-zone resource scope, including monitoring's zone. Use the installed product’s
operator guide and its current permission list rather than expanding to all permissions.
Cloudflare account tokens live under **Manage account → Account API tokens**;
an account-wide resource selection still needs the relevant zone permissions.
Verify them via `/accounts/<account-id>/tokens/verify`, not the user endpoint.
Token verification alone does not prove DNS/TLS/cache access. Stop unchanged
retries and never silently expand account/zone scope.

## Add or update

Prefer domains inside an App file, or a standalone Domain file. Keep stable
resource/server names: ownership comments use both. Use `kind: import` with
`up_two_<app-name>` for a native app, or the existing stable upstream for an
adopted app. Do not create another app solely to attach a hostname.

```bash
2srv validate -f api/2server/deploy.yaml
2srv plan -f api/2server/deploy.yaml
2srv deploy -f api/2server/deploy.yaml --apply
```

Plans inspect Cloudflare DNS ownership, conflicts, TLS and cache before rollout;
they do not issue certificates or test write permissions. Plans may pull image
layers for a tag. Bootstrap's dry run is only offline intent. For legacy manifests,
use `plan server.local.json`, then `domains server.local.json --apply`.

A zone must already use Cloudflare nameservers. Review zone-wide Full (strict)
against other origins. Existing A records require deliberate `adoptDns: true`;
conflicting A/AAAA/CNAME records fail. Preserve unrelated records and rules.
For explicit hostname/path Cache Rules, use optional `spec.cacheRules` in a
`kind: Zone` file; see [Zone configuration](source-config.md#optional-cache-rules).
Zone rules override Domain presets and use normal `plan` / `apply` without an
app rollout. Retain a bypass baseline for private routes.

Choose `cache: app` for dynamic/authenticated traffic; image/audio presets respect
origin headers and bypass cookies/Authorization. Verify login/cookies/CORS and a
negative/auth/cache case in addition to HTTPS before retiring an old hostname.

Certificate private state is fetched from/saved to the VM in connected mode.
Keep encrypted off-VM backups and schedule `domains --apply` weekly for renewal.
Exact-host certificates default to 365 days. For an explicitly requested 15-year
apex/wildcard certificate, use `certificate: {scope: zone, validityDays: 5475}`.
Cloudflare proxying must remain enabled for browser-trusted public HTTPS.
Deploy monitoring first if using its generated domain.

## Retire a domain

Use `delete domain NAME -f server.local.json --apply` for a complete declared
domain: it validates DNS ownership, deletes its records/cache rules, waits 300
seconds for DNS drain, atomically retires its route and updates the manifest.
`preflightEdge` still refuses silently dropping a live hostname. For a partial
hostname retirement or an existing custom migration, perform this transaction
for the exact requested hosts; prepare it locally using the current source
helpers before executing. Do not disable the general preflight check.

1. Pause matching CI/reconciliation; retain a private snapshot of manifest,
   exact Cloudflare records/rules and current edge release. Check
   `/opt/2server/edge/owner` equals the manifest name. Inventory all aliases and
   consumers; migrate/redirect them when that is part of the user's request.
2. Match DNS records by exact hostname, record ID and ownership comment
   `2server:<manifest-name>:<domain-name>`. Match cache rules by description and
   `two_server_<manifest>_<domain>` ref (hyphens become underscores; proxy
   presets also have `_bypass`). Re-read before deleting each owned record/rule
   to detect concurrent changes. Preserve TXT/MX, unrelated rules and zone TLS.
3. Retire the requested DNS records and their exclusively owned cache rules.
   Allow relevant DNS caches to expire or retain a temporary retiring route;
   do not revoke a certificate while cached traffic still needs that endpoint.
4. Build a complete new edge release retaining every other site, key and
   domain. Remove only retired site files and their hosts from the new
   `domains.json`. Use the atomic validation/reload pattern in
   `src/modules/domains/infrastructure/edge.ts:activateScript` with the edge lock and previous-release rollback.
   Never edit the live `current/domains.json` to silence the guard, and never
   remove shared imports/certificates still used by other hosts.
5. Verify remaining routes and absence of the owned DNS records; update the
   manifest and CI before resuming reconciliation. On failure restore the
   edge and owned DNS from the snapshot, or report partial state explicitly.
   Retain private rollback material until the agreed cleanup point.

Cloudflare API procedures: [delete a DNS record](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/delete/),
[delete one cache rule](https://developers.cloudflare.com/ruleset-engine/rulesets-api/delete-rule/).
Use `src/modules/domains/infrastructure/cloudflare.ts:Cloudflare.call` to keep credentials out of argv/logs.
