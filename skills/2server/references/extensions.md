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

Optional `extensions.alertWebhookEnv` enables Alertmanager; the value must be
an HTTPS Alertmanager-compatible receiver URL. Its absence means alerts stay
in Prometheus. Same-VM monitoring cannot notify when that VM is lost; retain an
external uptime check if already configured. Jaeger is not an implemented
extension; adding tracing is separate implementation work.

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

Removing Alertmanager alone needs a bounded Compose update with orphan cleanup
after confirming the exact project/service: ordinary `extensions --apply` does
not use `--remove-orphans`. Preserve Prometheus, node-exporter and alert history.
