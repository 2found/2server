# Availability on one VM

2server provides process restart, health-aware routing, guarded deployments and
local persistent recovery. It does **not** provide host-level HA: losing the VM,
its disk or network takes down the edge, databases and monitoring together.
Running Sentinel or a NATS quorum on this same VM would not remove that failure
domain. No extra VM, quorum or automatic database promotion is provisioned.

| Component | Implemented protection | Remaining boundary |
| --- | --- | --- |
| Apps | Docker restart, PID 1 init, bounded resources/logs; blue/green service deploy and rollback; every candidate passes readiness | A single replica has restart downtime; removed containers need CLI reconciliation |
| Caddy | Continuous active app health; passive eviction only with multiple serving replicas; bounded retry, config validation/rollback, graceful stop | One edge process/VM; existing direct proxy routes have no inferred health path |
| Redis | Authenticated PING and AOF write health, persistent AOF, rewrite memory headroom, graceful stop | Single process; no replica or off-VM backup automation |
| NATS | Auth, JetStream readiness, file storage and explicit fsync, bounded clients/payload/pending data | Core is transient; JetStream is single-node; no off-VM backup automation |
| Monitoring | Component readiness, private exporter/Alertmanager network, guarded config update, runtime/DB/host alerts | Local monitoring cannot notify through a VM outage; configure an external uptime check |

## Apps and edge

For a stateless HTTP service that must keep serving through one process failure,
set `replicas: 2` (or more). The default stays one: 2server does not silently double
RAM allocation. Size the host for **both generations** during blue/green deploy:
`replicas × memoryMb × 2`, plus all extensions, Caddy, kernel and spare capacity.
A 2 GB VM may not have room for every app with two replicas and all extensions.
The CPU/memory limits isolate processes; they do not reserve physical capacity.

```json
{
  "replicas": 2,
  "healthPath": "/readyz",
  "stopTimeoutSeconds": 60,
  "drainSeconds": 70
}
```

These are fields in an existing app spec, not a complete create/update spec.
Readiness must return 2xx when that instance can accept requests; it should be
cheap and should not write business data. Redirects are not readiness responses.
Caddy checks every five seconds, quarantines after two failed active checks and
requires two successes for recovery. Connection failures also quarantine for ten
seconds. It retries connection selection for up to three seconds; after a
connection succeeds, only GET/HEAD can be retried. Application POST side effects
still need idempotency keys when clients themselves retry. See the
[Caddy reverse proxy contract](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

Containers use Docker init to forward signals and reap children. Applications
must handle SIGTERM and finish/return work before `stopTimeoutSeconds`. The old
service generation drains for `drainSeconds` after the Caddy switch; long requests
and websocket clients need explicit reconnect/resume behavior. Workers stop the
old generation first; jobs need durable queues, bounded concurrency and safe
redelivery. Do not scale singleton schedulers without a distributed lock.

Managed Caddy gets a local admin readiness probe and 75 seconds to stop (the
Caddy grace period is 60 seconds). Existing Caddy adoption retains its operator's
runtime contract; inspect its restart/stop settings separately. App routing
improvements apply on app deploy/rollback, including when using existing Caddy.

Docker restarts exited processes with `unless-stopped`; an explicitly stopped
container stays stopped, including after reboot. An `unhealthy` status alone does
not trigger a restart. Readiness failures remove an app from Caddy and raise
HTTP readiness alerts; do not restart every client when a shared
database is unavailable. Inspect and use scoped CLI reload after fixing the
cause. See [Docker restart semantics](https://docs.docker.com/engine/containers/start-containers-automatically/).

## Redis

Redis uses AOF as the persistence path, without periodic RDB snapshots. Default
`appendfsync: "everysec"` trades throughput for a roughly one-second crash-loss
window; select `"always"` when each write must be fsynced. Neither setting survives
loss of the only disk. Snapshot/restore and remote backups are not automated.

`maxmemoryMb` cannot exceed half of `memoryMb`, leaving room for process overhead
and copy-on-write during AOF rewrite. This is a conservative starting point, not
an OOM guarantee under arbitrary workloads. `noeviction` returns write errors
when full instead of silently dropping queue/session data. Monitor memory and
size/reduce data before the limit. Redis deployment persists
`vm.overcommit_memory=1` in `/etc/sysctl.d/60-2server-redis.conf`; removing the
extension does not undo that shared host setting. See
[Redis memory guidance](https://redis.io/docs/latest/operate/oss_and_stack/management/admin/).

AOF write failure makes health unhealthy and emits a persistence alert. A
truncated AOF is refused (`aof-load-truncated no`) rather than silently accepting
partial data. Preserve the original files and assess repair/data loss before
using Redis repair tools. See [Redis persistence](https://redis.io/docs/latest/management/persistence/).

## NATS

Core remains appropriate for disposable real-time messages. For durable work,
set `jetstream: true` and use file-backed streams. `syncInterval` defaults to
`"always"` for this single-node setup; a duration such as `"1s"` trades durability
for throughput. Fsync can substantially reduce throughput, so benchmark the VM's
disk before increasing traffic. The pinned NATS 2.11 image accepts this setting;
see [upstream configuration](https://github.com/nats-io/nats.docs/blob/master/running-a-nats-service/configuration/README.md).

Default limits are 1,024 connections, 1,024 KiB payloads, 8 MiB pending per client,
and a ten-second write deadline. `maxConnections`, `maxPayloadKb`,
`maxMemoryMb` and `maxFileGb` are configurable. Per-client limits are not a total
memory reservation; connection count, stream indexes and consumers need headroom.
Apps own their stream policy: set max bytes/age/messages, durable consumers,
explicit acknowledgement, bounded in-flight work and idempotent redelivery.
Await the JetStream publish acknowledgement; Core publish is not a durable ack.
Clients need reconnect with backoff during broker restart. Reload still recreates
the single broker; rolling multi-node NATS is outside this product's current scope.

## Monitoring and operational checks

Deploy the monitoring App to install/update the runtime collector and rules.
The extension reads saved active app generations and the existing VM control
config each minute, then discovers expected containers from installed Apps'
Compose bundles, including stateless templates and sidecars. Adding/removing an
App needs no monitoring reload. Retained files of deleted Apps are excluded;
missing containers report down and missing Compose bundles alert separately.
Optional Alertmanager is observed only when present in the deployed bundle.
Discovery, collector scripts and alert configuration are owned by the monitoring
extension; the core CLI writes no monitoring-specific inventory. Only the host
collector reads private config; no secrets or Docker socket enter Prometheus.
Legacy stateful release discovery remains supported. A scoped manifest does
not erase other app coverage. Parked generations, scaled-to-zero
apps and explicitly retired extensions are excluded. Missing containers are
reported as down. Docker state, HTTP app readiness, health, restart counts and OOM flags, Redis
memory/AOF status, and NATS connection/slow-consumer/storage metrics are exported
as an atomic node-exporter textfile. No Docker socket or Redis/NATS credential is
mounted into Prometheus. HTTP readiness probes use the container's IPv4 address
on the declared bridge network from the Linux host, with a two-second deadline.
Caddy independently enforces readiness for routing. Workers require an image
HEALTHCHECK. A collection timeout retains the previous file and fires a stale
collector alert; many simultaneously failing replicas can exceed its 120-second
budget. IPv6-only edge networks are not supported by this collector.

Stale/missing runtime collection, unhealthy containers, restart loops, OOM,
Redis memory/persistence, JetStream storage, slow consumers, memory, disk/inodes,
CPU utilization above 90% for ten minutes (five-minute average), Prometheus rule
failures and Alertmanager delivery errors have rules. Outbound
notifications require an enabled receiver in the monitoring App's `webhooks`
(legacy: `extensions.webhooks` or `extensions.alertWebhookEnv`); no receiver means
local alerts only. Prometheus also scrapes itself and Alertmanager. The latter
and node-exporter use a separate Docker network with server-specific DNS names.
An external uptime check **with an alert policy and notification channel** is
required for whole-VM outages: Prometheus/Alertmanager cannot send while their
VM is down. App-specific request latency/error rates require instrumentation.

Monitoring validates Prometheus/Alertmanager configuration before replacing live
files, waits for all components to be healthy, and restores the previous config
on failure. History volumes are retained. Updates briefly interrupt monitoring;
private candidate/rollback files remain under `/opt/2server/extensions/APP/`
(legacy: `/opt/2server/monitoring/`). Collector
installation is a later step: a systemd failure can leave a healthy stack running
without fresh metrics; inspect the reported error and timer before retrying.
Monitoring still reconciles its DNS/TLS/authenticated domain after readiness.

```bash
2server deploy -f platform/monitoring.yaml --apply
2server app monitoring get
2server get monitor
```

Run only the operations for configured resources. New managed-edge settings are
installed with `setup`; it can recreate Caddy and briefly interrupt traffic.
This change was verified locally with real Docker failures and rule evaluation,
not by restarting a production VM. VM reboot, actual host filesystem metrics,
external alert delivery and representative sustained load need environment tests.

## Deferred work

Priority follow-ups without new VMs: remote Redis/JetStream backup and restore
drills when either holds non-rebuildable data; workload-specific load tests and
resource sizing; image HEALTHCHECKs and SIGTERM/reconnect tests in each consuming
app. Host failover, redundant edge, database quorum and independent monitoring
remain separate infrastructure work requiring another failure domain.

### Existing services and collector coverage

For existing Compose workloads, monitoring can observe explicitly configured
container names and on-host Caddy upstream files without taking over deployment.
See the [extension skill](../skills/2server/references/extensions.md) for fields.
The NodeCollectorFailure alert covers core CPU, memory, filesystem, disk, network,
load, stat, time, textfile, uname and vmstat collectors. Optional hardware and
filesystem collectors are excluded: node-exporter also emits zero when those
collectors have [no data on this host](https://github.com/prometheus/node_exporter/blob/v1.9.0/collector/collector.go#L147-L164).
