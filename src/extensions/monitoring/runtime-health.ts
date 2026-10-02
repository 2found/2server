import {extensionDiscovery} from './discovery';
import {instanceName,instanceRoot} from '../instance';
import {extensionProject} from '../../stateful';
import type { Config } from "../../config";
import { quote } from "../../process";

// Read on-host desired state: a scoped CLI manifest must not erase coverage of
// other apps. Never mount the Docker socket into the monitoring containers.
export function runtimeHealthFiles(c: Config): Record<string, string> {
  const adopted = typeof c.extensions.monitoring === "object" ? c.extensions.monitoring : { containers: [], upstreams: [] };
  return {
    "runtime-metrics.sh": `#!/bin/bash
set -euo pipefail
mkdir -p /opt/2server/metrics
chmod 755 /opt/2server/metrics
tmp=$(mktemp /opt/2server/metrics/.runtime.XXXXXX)
trap 'rm -f "$tmp"' EXIT
seen="|"
probe() {
  local n="$1" owned="\${2:-yes}" state running=0 healthy=0 restarts=0 oom=0 ip code
  local port="\${3:-}" health_path="\${4:-/healthz}"
  case "$seen" in *"|$n|"*) return;; esac
  seen="$seen$n|"
  if state=$(timeout 5 docker inspect -f '{"state":{{json .State}},"restarts":{{.RestartCount}},"owner":{{json (index .Config.Labels "io.2server.owner")}},"networks":{{json .NetworkSettings.Networks}}}' "$n" 2>/dev/null); then
    if [ "$owned" = no ] || [ "$(jq -r .owner <<< "$state")" = '${c.name}' ]; then
      restarts=$(jq -r .restarts <<< "$state")
      running=$(jq -r 'if .state.Running then 1 else 0 end' <<< "$state")
      healthy=$(jq -r 'if .state.Running and ((.state.Health.Status // "healthy") == "healthy") then 1 else 0 end' <<< "$state")
      oom=$(jq -r 'if .state.OOMKilled then 1 else 0 end' <<< "$state")
    fi
  fi
  if [ -n "$port" ]; then
    code=000
    if [ "$running" = 1 ]; then
      ip=$(jq -r --arg network '${c.edge.network}' '.networks[$network].IPAddress // empty' <<< "$state")
      if [[ "$ip" =~ ^[0-9]+[.][0-9]+[.][0-9]+[.][0-9]+$ ]]; then
        code=$(curl --noproxy '*' -s --connect-timeout 1 --max-time 2 -o /dev/null -w '%{http_code}' "http://$ip:$port$health_path") || code=000
      fi
    fi
    if [[ "$code" =~ ^2[0-9][0-9]$ ]]; then
      printf 'two_app_ready{container="%s"} 1\n' "$n"
    else
      printf 'two_app_ready{container="%s"} 0\n' "$n"
    fi
  fi
  printf 'two_container_running{container="%s"} %s\n' "$n" "$running"
  printf 'two_container_healthy{container="%s"} %s\n' "$n" "$healthy"
  printf 'two_container_restarts_total{container="%s"} %s\n' "$n" "$restarts"
  printf 'two_container_oom_killed{container="%s"} %s\n' "$n" "$oom"
}
{
  printf 'two_runtime_metrics_timestamp_seconds %s\n' "$(date +%s)"
  probe '${c.edge.container}' no
  for current in /opt/2server/apps/*/current; do
    [ -f "$current" ] || continue
    root="\${current%/current}"; app="\${root##*/}"; color=$(cat "$current")
    [[ "$app" =~ ^[a-z0-9][a-z0-9-]*$ ]] || continue
    case "$color" in blue|green) ;; *) exit 1;; esac
    count=$(jq -er '.replicas // 1' "$root/$color.json")
    [[ "$count" =~ ^[0-9]+$ ]] && [ "$count" -le 32 ]
    for ((i=1;i<=count;i++)); do
      n="two-${c.name}-$app-$color"; [ "$i" = 1 ] || n="$n-$i"
      owned=yes
      if jq -e '.compose' "$root/$color.json" >/dev/null; then
        n=$(jq -r --arg color "$color" '.compose.containers[$color]' "$root/$color.json")
        owned=no
      fi
      if [ "$(jq -r '.kind // "service"' "$root/$color.json")" = service ]; then
        probe "$n" "$owned" "$(jq -r '.port // empty' "$root/$color.json")" "$(jq -r '.healthPath // "/healthz"' "$root/$color.json")"
      else
        probe "$n"
      fi
    done
  done
  # Explicitly observed existing containers/routes are not adopted or restarted.
  ${(adopted.containers ?? []).map(n => `probe ${quote(n)} no`).join("\n  ")}
  ${(adopted.upstreams ?? []).map(u => `targets=$(awk '/^[[:space:]]*reverse_proxy[[:space:]]/{for(i=2;i<=NF;i++) if ($i ~ /^[a-zA-Z0-9][a-zA-Z0-9_.-]*:[0-9]+$/) print $i}' ${quote(u.file)} 2>/dev/null || true)
  if [ -z "$targets" ]; then
    printf 'two_app_ready{container="missing-upstream-${u.name}"} 0\n'
  fi
  for target in $targets; do probe "\${target%:*}" no "\${target##*:}" ${quote(u.healthPath)}; done`).join("\n  ")}
  ${extensionDiscovery(c)}
  for root in /opt/2server/extensions/*; do
    [ -f "$root/current/extension.json" ] && [ ! -f "$root/retired" ] || continue
    app="\${root##*/}"
    [[ "$app" =~ ^[a-z][a-z0-9-]*$ ]] || continue
    ext="$app"
    if [ -f "$root/current/identity.json" ]; then ext=$(jq -r .template "$root/current/identity.json"); fi
    probe "two-${c.name}-$app"
    if [ "$ext" = redis ]; then
      if info=$(timeout 5 docker exec "two-${c.name}-$app" sh -ec 'export REDISCLI_AUTH=$(cat /run/secrets/redis-password); redis-cli --raw INFO' 2>/dev/null); then
        printf '%s\n' "$info" | tr -d '\r' | awk -F: -v app="$app" '
          $1 == "used_memory" || $1 == "maxmemory" || $1 == "aof_delayed_fsync" { if ($2 ~ /^[0-9]+$/) print "two_redis_" $1 "{app=\\\"" app "\\\"} " $2 }
          $1 == "aof_last_write_status" || $1 == "aof_last_bgrewrite_status" { print "two_redis_" $1 "{app=\\\"" app "\\\"} " ($2 == "ok" ? 1 : 0) }'
      fi
    elif [ "$ext" = nats ]; then
      if info=$(timeout 5 docker exec "two-${c.name}-$app" wget -T 2 -qO- http://127.0.0.1:8222/varz 2>/dev/null); then
        jq -r --arg app "$app" '"two_nats_connections{app=\\\"" + $app + "\\\"} " + (.connections|tostring), "two_nats_slow_consumers_total{app=\\\"" + $app + "\\\"} " + (.slow_consumers|tostring)' <<< "$info"
      fi
      if info=$(timeout 5 docker exec "two-${c.name}-$app" wget -T 2 -qO- http://127.0.0.1:8222/jsz 2>/dev/null); then
        jq -r --arg app "$app" 'select(.config.max_storage > 0) | "two_nats_storage_bytes{app=\\\"" + $app + "\\\"} " + (.storage|tostring), "two_nats_max_storage_bytes{app=\\\"" + $app + "\\\"} " + (.config.max_storage|tostring)' <<< "$info"
      fi
    fi
  done
}${c.instance ? ` | sed -E -e 's/^([a-zA-Z_:][a-zA-Z0-9_:]*)\\{/\\1{collector="${c.instance.name}",/' -e t -e 's/^([a-zA-Z_:][a-zA-Z0-9_:]*) /\\1{collector="${c.instance.name}"} /'` : ''} > "$tmp"
chmod 644 "$tmp"
mv -f "$tmp" /opt/2server/metrics/${instanceName(c,"runtime")}.prom
`,
    "runtime-metrics.service": `[Unit]\nDescription=2server runtime metrics\nAfter=docker.service\n[Service]\nType=oneshot\nExecStart=/bin/bash ${instanceRoot(c,"/opt/2server/monitoring")}/runtime-metrics.sh\nTimeoutStartSec=120s\n`,
    "runtime-metrics.timer": `[Unit]\nDescription=2server runtime metric collection\n[Timer]\nOnBootSec=30s\nOnUnitActiveSec=60s\nUnit=${c.instance?extensionProject(c,"runtime-metrics"):`two-${c.name}-runtime-metrics`}.service\n[Install]\nWantedBy=timers.target\n`,
  };
}
export function runtimeHealthInstall(c: Config) {
  const unit = `${c.instance?extensionProject(c,"runtime-metrics"):`two-${c.name}-runtime-metrics`}`;
  return `install -m 644 ${instanceRoot(c,"/opt/2server/monitoring")}/runtime-metrics.service /etc/systemd/system/${unit}.service
install -m 644 ${instanceRoot(c,"/opt/2server/monitoring")}/runtime-metrics.timer /etc/systemd/system/${unit}.timer
systemctl daemon-reload
systemctl enable --now ${unit}.timer
systemctl start ${unit}.service`;
}
export const runtimeAlertRules = `
  - name: runtime
    rules:
      - alert: RuntimeMetricsMissing
        expr: absent(two_runtime_metrics_timestamp_seconds)
        for: 3m
      - alert: RuntimeMetricsStale
        expr: time() - two_runtime_metrics_timestamp_seconds > 180
        for: 2m
      - alert: AppNotReady
        expr: two_app_ready == 0
        for: 2m
      - alert: ExtensionConfigMissing
        expr: two_extension_config_healthy == 0
        for: 2m
      - alert: ContainerUnavailable
        expr: two_container_healthy == 0
        for: 2m
      - alert: ContainerRestartLoop
        expr: increase(two_container_restarts_total[10m]) > 3
        for: 2m
      - alert: ContainerOOMKilled
        expr: two_container_oom_killed == 1
        for: 1m
      - alert: RedisMemoryPressure
        expr: two_redis_used_memory / two_redis_maxmemory > 0.85
        for: 5m
      - alert: RedisPersistenceFailure
        expr: two_redis_aof_last_write_status == 0 or two_redis_aof_last_bgrewrite_status == 0
        for: 2m
      - alert: RedisSlowFsync
        expr: increase(two_redis_aof_delayed_fsync[5m]) > 0
        for: 5m
      - alert: NATSSlowConsumers
        expr: increase(two_nats_slow_consumers_total[5m]) > 0
        for: 2m
      - alert: JetStreamStoragePressure
        expr: two_nats_storage_bytes / two_nats_max_storage_bytes > 0.85
        for: 5m
      - alert: NodeCollectorFailure
        # Optional hardware/filesystem collectors also return zero for no data.
        # Alert on the core collectors this VM monitoring contract requires.
        expr: node_scrape_collector_success{collector=~"cpu|meminfo|filesystem|diskstats|netdev|loadavg|stat|time|textfile|uname|vmstat"} == 0 or node_textfile_scrape_error == 1
        for: 5m
      - alert: HostInodesLow
        expr: node_filesystem_files_free{fstype!~"tmpfs|overlay"} / node_filesystem_files < 0.1
        for: 5m
      - alert: HostCPUHigh
        expr: 1 - avg by (instance, job) (rate(node_cpu_seconds_total{mode="idle"}[5m])) > 0.9
        for: 10m
      - alert: PrometheusRuleFailures
        expr: increase(prometheus_rule_evaluation_failures_total[5m]) > 0
        for: 2m
      - alert: AlertDeliveryFailure
        expr: increase(alertmanager_notifications_failed_total[5m]) > 0
        for: 2m
`;
