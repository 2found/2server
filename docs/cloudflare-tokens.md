# Create a Cloudflare token

2server uses a scoped **API Token** in `CLOUDFLARE_API_TOKEN`, sent as a bearer
credential. A Global API Key or Origin CA service key is a different credential
type and cannot be pasted into this variable.

Permissions and resources are separate: an Account permission needs the target
account in its resources; a Zone permission needs the target zone. An
account-owned token can carry both. Selecting an entire account does not grant
every permission, and an Account permission does not replace a Zone permission.
See Cloudflare's [permission categories](https://developers.cloudflare.com/fundamentals/api/reference/permissions/).

## Create and scope the token

1. Select the Cloudflare account that owns the domains and provider resources.
   For an account-owned service token, open **Manage Account → Account API
   tokens → Create Token**. The creator must have token-provisioning privileges
   and can only grant permissions they already hold. Alternatively, create a
   user token under **My Profile → API Tokens**; it remains tied to that user.
2. Choose **Create Custom Token**, and name it for its environment and purpose,
   for example `2server-production`. The **Edit zone DNS** template alone is
   insufficient for public VM deployment.
3. Add the permission rows for the features below. Select the correct **Account**
   or **Zone** category for each row. Dashboard `Edit` and API `Write` names
   describe write access; use the names offered by the current dashboard.
4. For **Account Resources**, include the specific account used by the App's
   `spec.accountId` or resolved from its zone. For **Zone Resources**, include
   each managed zone, including a separately configured monitoring zone.
   If the account-token dashboard presents **Entire <account name> account**,
   choose it only when access throughout that account is intended. Review the
   summary to ensure the zone permissions also cover the required zones.
   Account selection alone does not prove zone coverage.
5. Review any expiry and client-IP restrictions. Provider requests may originate
   from the laptop or CI runner; a connected command can read the token from
   the VM and still call Cloudflare from the operator's machine. Allow those
   egress addresses, rather than assuming all calls originate on the VM.
6. Review the summary, create the token, and save the secret privately. Cloudflare
   reveals it once. Do not put it in a manifest, command argument or Git.

These steps follow Cloudflare's [custom-token setup](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)
and [account-owned token setup](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/).

## Public VM apps and domains

Use all five Zone rows on every managed zone for the normal DNS/TLS/cache flow:

| Category | Permission | 2server operation |
| --- | --- | --- |
| Zone | Zone: Read | Find the active zone and inspect its identity |
| Zone | DNS: Edit / Write | Inspect, publish and retire owned DNS records |
| Zone | Zone Settings: Edit / Write | Inspect and set Full (strict) TLS |
| Zone | Cache Rules: Edit / Cache Settings: Write | Inspect and reconcile Cache Rules |
| Zone | SSL and Certificates: Edit / Write | Issue Cloudflare Origin CA certificates |

This flow does not require Account Settings Edit or token-administration rights.
Cache Purge and Page Rules do not replace Cache Rules. Account-level SSL access
does not replace the Zone-level certificate permission. Certificate issuance
uses [Zone SSL and Certificates Edit](https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/).
If `cloudflare.originTokenEnv` selects a separate bearer token, give that token
certificate permission and coverage for the same certificate zones.

## Zone policies

For a `kind: Zone` file, use Zone Read plus the rights for its declared policies:

| Policy | Additional Zone permission |
| --- | --- |
| `spec.cacheRules` | Cache Rules: Edit / Cache Settings: Write |
| `spec.rateLimit` or `spec.wafRules` | Zone WAF: Edit / Write |

The WAF permission is for the zone rate-limit and custom-firewall phases; it is
not an Account WAF grant. See [Zone configuration](source-config.md#cloudflare-zone-policy).

## Email Routing

Email Routing needs **both** the owning account and the email zone:

| Category | Permission | Purpose |
| --- | --- | --- |
| Account | Email Routing Addresses: Edit / Write | Register and inspect destination inboxes |
| Zone | Zone: Read | Resolve the zone and its owning account |
| Zone | DNS: Read | Inspect mail DNS |
| Zone | Zone Settings: Edit / Write | Enable Email Routing's managed DNS |
| Zone | Email Routing Rules: Edit / Write | Inspect and reconcile forwarding rules |
| Zone | DNS: Edit / Write, only with `spec.replaceMx` | Delete the explicitly approved obsolete MX records |

DNS Edit already covers DNS reads if the token also handles public VM domains.
Account destination rights alone cannot edit zone rules. Enabling routing's DNS
requires [Zone Settings Write](https://developers.cloudflare.com/api/resources/email_routing/subresources/dns/methods/create/);
registering destinations requires [Account Email Routing Addresses Write](https://developers.cloudflare.com/api/resources/email_routing/subresources/addresses/methods/create/).

Account API Tokens Read/Edit are needed only for the explicit
`manageTokenPermissions` opt-in, not normal mail deployment. The CLI's optional
account-rule and token-policy diagnostic probes may be denied while ordinary
zone operations work. Account-rule diagnostics do not substitute for Zone Email
Routing Rules Edit. Read [Email Routing](email-routing.md#api-token) before
opting into any token-policy changes.

## Workers and D1

The `url-shortener` template creates/queries D1, uploads a Worker and attaches
a custom domain. Its account and zone must belong together:

| Category | Permission | Purpose |
| --- | --- | --- |
| Account | D1: Edit / Write | List/create the database, run schema SQL and register customers |
| Account | Workers Scripts: Edit / Write (legacy permission) | Upload the Worker and attach its domain |
| Zone | Zone: Read | Resolve the active zone and check account identity |
| Zone | Workers Routes: Edit / Write | Configure the custom domain connection |

Cloudflare's newer Workers roles use **Admin at the Workers product scope** to
create a new Worker. Editor is sufficient to update an existing Worker, but
Custom Domains currently require product scope rather than a per-Worker role.
The CLI reconciles the custom domain on deployment, so include Workers Routes
Write for its zone. D1 rights remain separate because the CLI accesses D1
directly. Legacy Workers Scripts permissions still work without an announced
deprecation date. See [Workers roles and permissions](https://developers.cloudflare.com/workers/authorization/workers/),
[attach a Worker domain](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/update/)
and [create D1](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/create/).

## Store and check the credential

For an installed CLI, provide the credential through private process/CI
environment variables. In a source checkout, Bun loads the ignored `2server/.env`
when run from the product root; start from [.env.example](../.env.example), fill
it locally, and use `chmod 600 .env`.

For connected VM operations, update the referenced server credential from a
private dotenv file containing `CLOUDFLARE_API_TOKEN`:

```sh
2srv server env --env-file /private/cloudflare.env --apply
2srv validate -f platform/api.yaml
2srv plan -f platform/api.yaml
```

Use the selected VM connection. Connected commands do not fall back to local
`.env` or exported credentials. External templates follow their documented
credential source; [email routing](email-routing.md#api-token) supports a
read-only VM credential session, while Workers use the local process credential.

Token verification checks identity/status, not sufficient permissions:

| Token owner | Verification endpoint |
| --- | --- |
| Account | `GET /accounts/<account-id>/tokens/verify` |
| User | `GET /user/tokens/verify` |

`status: active` does not prove account scope, zone coverage or write rights.
Check the dashboard summary and run the plan for each App/Domain/Zone file.
Public-domain plans inspect DNS, TLS settings and cache; Worker plans inspect
zone/account identity and D1. Plans do not issue certificates, upload Workers,
enable mail DNS or exercise writes. Complete the intended deployment with
`--apply` only when authorized, then check its actual result.

On 401/403, check the reported permission, its category and resource scope,
expiry, IP restrictions and the credential source. A filtered zone list can
also appear as a missing active zone. Do not solve either case by granting all
account permissions or repeatedly retrying an unchanged token. A zone must
already be active under Cloudflare nameservers. The CLI never silently expands
token privileges; Email Routing policy management requires a separate explicit
opt-in and can leave a grant applied if later mail checks fail.
