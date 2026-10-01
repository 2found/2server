# Cloudflare and domains

Read `README.md` sections on Cloudflare ownership and cache, and the selected
manifest. Configure `cloudflare.tokenEnv` (default `CLOUDFLARE_API_TOKEN`) and
optionally `originTokenEnv` as environment variable names. Use a scoped bearer
token, not a Global API Key passed as bearer. The README lists required DNS,
zone, cache and Origin CA permissions. A zone must already use Cloudflare
nameservers; registration/delegation is not implemented by this CLI.

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

## Retire a domain

There is no domain-delete CLI. `preflightEdge` intentionally refuses a manifest
that silently drops a live hostname. Perform a bounded retirement transaction
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
