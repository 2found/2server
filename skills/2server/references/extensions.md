# Extensions

## Add monitoring

For one domain zone, set `extensions.monitoring: true`. Otherwise declare the
zone; hostname, user and password source can also be explicit:

```json
"extensions": {
  "monitoring": {
    "zone": "example.com", "hostname": "metrics.example.com",
    "username": "admin", "passwordEnv": "MONITORING_PASSWORD"
  }
}
```

Then run `validate`, inspect the monitoring domain in `plan`, and run
`extensions server.local.json --apply`. This installs bounded Prometheus and
node-exporter, waits for internal readiness, and reconciles its Cloudflare DNS,
Origin CA TLS, authenticated Caddy route and cache bypass. Other live sites are
retained. No separate domains apply is needed to expose monitoring. The default
hostname is `monitor.<zone>`; it must not conflict with another declared domain.

For local operation, set `passwordEnv: "MONITORING_PASSWORD"` and store its
value in the ignored `2server/.env` with mode 0600. Keep infrastructure secrets
in the product checkout instead of unrelated application or QA env files.

`passwordEnv` references a 16–72 byte secret. If omitted, a random password is
persisted privately at
`~/.local/state/2server/<name>/monitoring-credentials.json`; report its location,
not its value. Reuse it in subsequent applies, verification and scheduled cert
renewal. Test anonymous/wrong-password rejection and authenticated readiness.
Caddy uses bcrypt; never replace it with plaintext or bypass auth for probes.

## Discord notifications

Store the incoming webhook URL in ignored `2server/.env` (0600), for example
`DISCORD_WEBHOOK_URL`. Never put the URL in JSON, command arguments, logs or
tracked files. If missing, instruct the operator to create a Discord channel
webhook under Edit Channel → Integrations → Webhooks and save its URL locally;
name the required env variable and file, without requesting secrets in chat.

Use this spec (`discord.json` contains only a secret reference):

```json
{"name":"discord","provider":"discord","urlEnv":"DISCORD_WEBHOOK_URL","enabled":true,"sendResolved":true}
```

For an installed monitoring stack:

```bash
bun src/cli.ts create webhook discord -f server.local.json --spec discord.json --apply
bun src/cli.ts get webhook -f server.local.json
bun src/cli.ts update webhook discord -f server.local.json --spec discord.json --apply
bun src/cli.ts test webhook discord -f server.local.json --apply
bun src/cli.ts delete webhook discord -f server.local.json --apply
```

Without `--apply`, mutations and tests are previews. `test` sends one clearly
marked test message from the operator machine and requires Discord's message ID
confirmation; it does not prove VM egress. Treat transport failures as unknown
delivery and inspect the channel before retrying. CRUD updates Alertmanager and
atomically saves the manifest only after deployment succeeds. Deletion unregisters
the target in 2server; it does not delete the Discord-hosted webhook. Removing
the last enabled receiver retires Alertmanager while preserving its history.

For first install, put that spec in `extensions.webhooks: [...]` alongside
monitoring and deploy the extension. Enabled targets use Alertmanager's native
Discord integration (firing/resolved, grouped alerts), not its generic webhook
payload. Existing `extensions.alertWebhookEnv` remains supported for HTTPS
Alertmanager-compatible receivers. Disabled targets do not require their secret.
Webhook CRUD does not reconcile DNS; initial monitoring deployment does.

Same-VM monitoring cannot notify when that VM is lost; retain external uptime
checks. Jaeger is not an implemented extension; tracing is separate work.

## Add image proxy

Read `src/config.ts` and `src/extensions.ts` for `extensions.imageProxy` fields:
key/salt environment references and `allowedSources` HTTPS prefixes. Keys must
be hex secrets of at least 32 bytes. Deploy extensions, then declare an `images`
cache domain targeting `two-<manifest>-imgproxy:8080` on the edge network and
apply domains. Unlike monitoring, image proxy DNS needs that explicit domain
entry. The service uses standard signed imgproxy URLs under `/i`; preserve
existing custom/unsigned API proxy contracts instead of silently replacing them.
Verify a valid signed image and rejection of an invalid signature/disallowed
source; inspect Cache-Control and Cloudflare cache behavior when tested live.

## Remove an extension

Setting monitoring false or deleting imageProxy config does not uninstall it.
Pause its reconciliation and retire/reassign its hostname/cache rules using the
domain reference. For monitoring, retire generated domain
`two-server-monitoring` too; future configuration must disable it so renewal
will not recreate DNS. Keep the authenticated retiring route until DNS caches
expire if necessary, then remove it in a validated atomic Caddy release.

Inspect Docker Compose project labels and paths before running the relevant
command through the declared transport:

```bash
docker compose -p two-server-monitoring -f /opt/2server/monitoring/compose.json down
docker compose -p two-server-imgproxy -f /opt/2server/imgproxy/compose.json down
```

Run only the command for the selected extension. Preserve named volumes by
omitting `--volumes`; Prometheus history and alerts may be needed. Do not delete
shared edge networks. Remove its manifest configuration, exclusive CI secret
references and deployment files, retaining private rollback material as needed.
Explicit data deletion is separate from stopping/removing the service. Verify
its containers, owned DNS/cache rules and live routes are gone, and other apps
still work. A failed DNS step is not a completed removal.

Monitoring updates retire specifically removed services after readiness succeeds.
They preserve Prometheus, node-exporter and alert history volumes.

## Scoped resource commands

Prefer `create extension monitoring|image-proxy -f server.local.json --spec
extension.json --apply`, `update extension`, or `reload extension` when only one
extension is requested. `delete extension monitoring` retires its owned DNS and
cache rule, waits for DNS TTL drain, removes its Caddy site, stops the stack, and
updates the manifest. `delete extension image-proxy` requires routes to be
retired/reassigned first. Volumes and private history are retained.
PostgreSQL, Redis and NATS use the [stateful workflow](stateful.md).

## Reliability and alerts

Monitoring validates configuration before activation and waits for all component
health checks before domain reconciliation. A failed update attempts to restore
the old stack; inspect a reported rollback failure before retrying. Runtime
metrics use active on-host app/extension state, not just the scoped manifest.
Check collector freshness as well as container state. Exporter and Alertmanager
use a separate network; no Docker socket is exposed to monitoring containers.
Read `docs/reliability.md` for coverage and the limits of same-VM observation.

Existing Compose services can be observed without adoption: set
`extensions.monitoring.containers` to Docker names and `upstreams` to objects
`{name, file, healthPath}`. Each upstream file is an absolute on-host Caddy snippet
containing simple `reverse_proxy container:port` targets. The collector follows
blue/green pointer changes; missing files and failing 2xx probes alert. Avoid
registering the same container twice. Observation never restarts those services.
