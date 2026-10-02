# Cloudflare and domains

For VM-owned configuration, use [control state](control-state.md): `connect` once,
then run domain commands without a manifest path. Store/update Cloudflare tokens
with `server env --env-file secrets.env --apply`; credentials come from the VM,
not a machine-local `.env`. The local `.env` steps below apply only to initial
publication and legacy local mode. Never ask for a token in chat.


Read `README.md` sections on Cloudflare ownership and cache, and the selected
manifest. Configure `cloudflare.tokenEnv` (default `CLOUDFLARE_API_TOKEN`) and
optionally `originTokenEnv` as environment variable names. Use a scoped bearer
token, not a Global API Key passed as bearer. The README lists required DNS,
zone, cache and Origin CA permissions. A zone must already use Cloudflare
nameservers; registration/delegation is not implemented by this CLI.
Store local Cloudflare variables in the product checkout's ignored `.env`
(mode 0600). Bun loads it when run from the product root; CI uses its secret store.

## Missing key or permission failure

The CLI exits nonzero for a missing/blank Cloudflare credential and for provider
authentication/permission errors. Give the user actionable instructions:

1. Identify the missing manifest variable (`cloudflare.tokenEnv`, normally
   `CLOUDFLARE_API_TOKEN`; also `originTokenEnv` if it is separate). Explain that
   its value belongs in the ignored `2server/.env`, not `.babysit/.env`.
   Copy `.env.example` only when `.env` does not exist; preserve existing secrets.
2. In Cloudflare, select the intended account, then **Manage account → Account
   API tokens → Create Token**, or edit the existing account token. For the
   account-wide setup, select **Entire <account name> account**
   as the resource scope. That selects resources; it does not grant every API
   permission. A narrower scope also works when it includes every managed zone.
3. Grant zone permissions **Zone: Read**, **DNS: Edit**, **Zone Settings: Edit**,
   **Cache Rules / Cache Settings: Edit**, and **SSL and Certificates: Edit**.
   Ensure the resource selection includes every zone in the manifest, including
   monitoring's zone. Account-level SSL permissions alone do not cover Origin CA
   issuance or zone TLS settings. Ordinary deployment does not require token
   administration permissions.
4. Tell the user to save the token locally in the named variable, add
   `CLOUDFLARE_ACCOUNT_ID` for account-token verification, and use `chmod 600 .env`.
   Never request the token value in chat. If a shell-exported variable overrides
   the file, have them update or unset that stale export without printing it.
5. Once the user has saved it, rerun `plan` from the product root. For an existing
   token's 401/403, check expiry/status and the failed endpoint's permission and
   resource scope. Use `/accounts/<account-id>/tokens/verify` for account tokens;
   an active result alone does not prove DNS/TLS/cache access. Do not repeatedly
   retry unchanged credentials or expand token policies without authorization.

Use this guidance in the response, tailored to the actual missing variable or
failed operation. See Cloudflare's [account-token setup](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)
and the product [access requirements](../../../README.md#cloudflare-access-and-ownership).

## Add or update

Add a domain entry with stable `name`, Cloudflare `zone`, `hosts`, and upstream.
Use `kind: "import"` with `up_two_<app-name>` for a managed app, or the existing
stable upstream name for a legacy app. A container proxy target must be reachable
on the edge Docker network. `examples/existing-caddy.json` connects an example
hostname and `/api` to existing web/API imports. Do not create another container
just to attach a hostname.

Choose `cache: "app"` for dynamic/authenticated traffic, `images` for `/i/`, or
`audio` for `/a/`. Image/audio presets respect origin cache headers and bypass
cookies/Authorization; they do not make private responses publicly cacheable.
Confirm OAuth callbacks, cookies, CORS and frontend API origin separately.

```bash
bun src/cli.ts validate server.local.json
bun src/cli.ts plan server.local.json
bun src/cli.ts domains server.local.json --apply
bun src/cli.ts verify server.local.json
```

The plan may change zone-wide TLS to Full (strict); inspect other origins in
that zone. Existing records require deliberate `adoptDns: true` to adopt;
conflicting A/AAAA/CNAME records cause failure. Never delete an unrelated record
to make this step pass. Certificates are reused/renewed from private operator
state, copied over SSH stdin, and activated with Caddy validation and origin
checks before DNS publication. `verify` checks public TLS/HTTP; also exercise
the requested app route and a relevant negative/auth/cache case.

If monitoring is enabled, the generated monitoring domain participates in plan,
domains and verification automatically. Deploy the extension first. Keep its
password environment or private generated credential file available during
certificate renewal.

For a requested 15-year apex/wildcard Origin CA certificate, set
`certificate: { "scope": "zone", "validityDays": 5475 }` on the domain. Exact
host certificates default to 365 days. This covers the origin TLS hop; keep
Cloudflare proxying enabled for browser-trusted public HTTPS.

For account-owned credentials, verify through the account token endpoint.
Inspect effective zone resources as well as permission names when a token
verifies but DNS/settings/cache returns 403. Account-wide product permissions
are distinct from zone permissions. Extending a token's access scope requires
user authorization; prepare the exact added zone policy first.

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
   `src/edge.ts:activateScript` with the edge lock and previous-release rollback.
   Never edit the live `current/domains.json` to silence the guard, and never
   remove shared imports/certificates still used by other hosts.
5. Verify remaining routes and absence of the owned DNS records; update the
   manifest and CI before resuming reconciliation. On failure restore the
   edge and owned DNS from the snapshot, or report partial state explicitly.
   Retain private rollback material until the agreed cleanup point.

Cloudflare API procedures: [delete a DNS record](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/delete/),
[delete one cache rule](https://developers.cloudflare.com/ruleset-engine/rulesets-api/delete-rule/).
Use `src/cloudflare.ts:Cloudflare.call` to keep credentials out of argv/logs.
