# Cloudflare email on the Free plan

The `email-routing` extension configures incoming domain email using Cloudflare
Email Routing. Messages are forwarded to an existing, verified inbox such as
Gmail. It provisions no VM, Worker or D1 database and needs no paid Workers plan.
It does not provide a mailbox, IMAP, POP3 or outbound SMTP.

Cloudflare's [pricing](https://developers.cloudflare.com/email-service/platform/pricing/)
allows unlimited inbound routing on Free. Sending to arbitrary recipients requires
Workers Paid; sending to your own verified destinations is free. To reply from
your domain while keeping Cloudflare Free, use a separate SMTP provider. Configure
that provider's DKIM/SPF as part of its setup; do not add a second SPF record.

## Configure an instance

```sh
2server init app mail --template email-routing -o platform/mail.yaml
```

Edit the generated App file:

```yaml
apiVersion: 2server.app/v1
kind: App
metadata: {name: mail}
template: email-routing
spec:
  zone: example.com
  routes:
    - address: contact@example.com
      destination: owner@example.net
    - address: support@example.com
      destination: owner@example.net
```

Replace the domain and addresses. The CLI resolves the account from the active
Cloudflare zone. Optional `accountId` pins the expected account and rejects a
mismatch. This version manages exact addresses on
the zone apex; subdomain addresses and catch-all changes are not supported.
Destinations must be external inboxes to avoid forwarding loops.

Keep the instance name stable: each rule is owned by
`2server:<instance>:<address>`. Different instances cannot take over an address.
There are no VM `secrets`, HTTP `domains`, `requires` or `webhooks` on this App.

## API token

Use a scoped bearer token, with these permissions on the selected account/zone:

| Scope | Permission | Purpose |
| --- | --- | --- |
| Account | Email Routing Addresses: Edit | Register and inspect destination inboxes |
| Zone | Zone: Read | Resolve the active zone and verify its account |
| Zone | DNS: Read | Inspect existing mail DNS |
| Zone | Zone Settings: Edit | Enable Email Routing and its Cloudflare-managed DNS |
| Zone | Email Routing Rules: Edit | Inspect and reconcile exact-address rules |

Set `CLOUDFLARE_API_TOKEN` privately in the local process environment, CI secret
store, or ignored `2server/.env` (mode `0600`) when running from the product root.
Never put its value in an App file, command argument or Git. If the token is
already on a 2server VM, pass `--connection FILE` (or `--ssh user@host`) to
plan/deploy/get. The CLI reads the VM's configured `cloudflare.tokenEnv` through
a read-only control session and keeps the token in memory. It does not change VM
configuration, install containers or fall back to local values if the VM secret
is missing. See the
[Cloudflare API](https://developers.cloudflare.com/api/resources/email_routing/).

Account-wide permissions do not imply zone-level Email Routing rule permissions.
For an account-owned token with Account API Tokens Read/Edit, optional
`spec.manageTokenPermissions: true` can append `Email Routing Rules Write` to
one existing allow policy scoped to exactly the declared zone. `plan` reports
the proposed addition; apply preserves other policies and token restrictions.
It refuses broader or ambiguous zone policies, deny policies and concurrent
policy changes. This option defaults to false and never rotates the credential
or adds resource scopes.

For a newly requested zone without an existing exact-zone policy, the separate
`spec.createZoneTokenPolicy: true` opt-in allows creation of one such policy.
It requires `manageTokenPermissions: true` and a pinned `accountId`; the CLI
checks the zone belongs to that account before any grant. The new policy grants
only Zone Read, DNS Read, Zone Settings Write and Email Routing Rules Write on
that exact zone. Existing policies and token restrictions remain intact. A plan
reports the grant and defers protected mail reads; apply creates the policy,
then checks mail DNS/settings/rules and destination verification. It may leave
the granted policy in place if later mail preflight fails. It never grants rights
to all zones or all accounts. This option defaults to false.

## Plan, verify, deploy

```sh
2server validate -f platform/mail.yaml
2server plan -f platform/mail.yaml
2server deploy -f platform/mail.yaml --apply
# When the credential is owned by a connected VM:
2server deploy -f platform/mail.yaml --connection .2server/connection.json --apply
```

`validate` is offline. `plan` reads Cloudflare without mutation and checks account
ownership, conflicting MX/SPF, routing-rule ownership and destination verification.
`get -f FILE` diagnoses settings, DNS, destination verification and token policy
metadata, including separate account/zone API responses. Neither proves write
permission or delivery.

If a destination is new, `deploy --apply` registers it and Cloudflare sends a
verification message. The result is `status: pending-verification`; no mail DNS
or routing rules change yet. An opted-in token permission addition may already
have been applied. Open that message in the destination inbox and
verify the address, then run the same deploy command again. Existing pending
destinations are reused without repeatedly sending verification messages.

Once all destinations are verified, the CLI enables routing using Cloudflare's
DNS API and creates or updates only its owned rules. It checks live settings,
required DNS records and rule contents before reporting `status: ready`.
Repeated deployment keeps unchanged rules. An API failure can leave partial
changes: inspect the state with `plan` before retrying. The CLI reports permission
failures without printing token values or provider response bodies.

Existing mail-provider MX or a different SPF causes deployment to stop. Review
the mail migration and sender authentication explicitly before changing those
records. To replace a confirmed obsolete apex MX, explicitly list its exact
hostname and priority in `spec.replaceMx`, for example:

```yaml
replaceMx:
  - content: old.mx.example.net
    priority: 1000
```

The plan reports matching records. They are deleted only after destinations
are verified and DNS/rule ownership has been rechecked. Other conflicting MX
and SPF still stop deployment; no SPF replacement is supported. Foreign rules, catch-all
behavior, account-wide destinations and unrelated DNS remain intact.

For end-to-end verification, send to each configured alias from a separate
external inbox and confirm it arrives in the destination inbox. Also send to an
unconfigured alias and check the intended existing catch-all/drop behavior.
Cloudflare readiness checks alone do not prove inbox delivery.

## Disable or retire

To disable an owned address, keep its route in the file with `enabled: false`
and deploy. Removing a row leaves its existing rule in place and reports it in
`retainedRules`; it does not silently retire mail delivery.

Deletion and rollback from the CLI are refused. Retire rules explicitly in
Cloudflare after reviewing delivery needs. Do not disable zone-wide routing,
remove shared MX/SPF or delete account-wide destinations just to retire one
instance. `app NAME logs|restart` does not apply: this extension has no container
and is not recorded as a VM installation.
