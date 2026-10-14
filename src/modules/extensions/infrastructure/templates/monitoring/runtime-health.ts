import type { Config } from "../../../../config/application/config";
import { extensionProject } from '../../../application/stateful';
import { instanceName,instanceRoot } from '../../../domain/instance';
import { extensionDiscovery } from './discovery';

// Read on-host desired state: a scoped CLI manifest must not erase coverage of
// other apps. Never mount the Docker socket into the monitoring containers.
export function runtimeHealthFiles(c: Config): Record<string, string> {
  return {
    "runtime-metrics.sh": `#!/bin/bash
set -euo pipefail
mkdir -p /opt/2server/metrics
chmod 755 /opt/2server/metrics
tmp=$(mktemp /opt/2server/metrics/.runtime.XXXXXX)
trap 'rm -f "$tmp"' EXIT
seen="|"
inspect_format='{"name":{{json .Name}},"state":{{json .State}},"restarts":{{.RestartCount}},"owner":{{json (index .Config.Labels "io.2server.owner")}},"networks":{{json .NetworkSettings.Networks}}}'
# One record per container: name, owner, running, healthy, restarts, OOM, edge IP.
inspect_fields='[(.name // "" | ltrimstr("/")), (.owner // ""),
  (if .state.Running then 1 else 0 end),
  (if .state.Running and ((.state.Health.Status // "healthy") == "healthy") then 1 else 0 end),
  .restarts, (if .state.OOMKilled then 1 else 0 end),
  (.networks[$network].IPAddress // "")] | map(tostring) | join("\\u001f")'
# Inspect every container in one Docker call and one jq pass. Each jq or Docker
# CLI start costs tens of milliseconds of CPU, and several per container every
# minute made this collector one of the busiest processes on a small host. A
# name the snapshot lacks (missing, created since, failed batch) is inspected
# on its own in probe, so the snapshot only ever saves work.
declare -A inspected=()
if names=$(timeout 10 docker ps -a --format '{{.Names}}' 2>/dev/null) && [ -n "$names" ]; then
  while IFS= read -r rec; do
    key="\${rec%%$'\\x1f'*}"
    if [ -n "$key" ]; then inspected["$key"]="$rec"; fi
  done < <(timeout 20 docker inspect -f "$inspect_format" $names 2>/dev/null | jq -r --arg network '${c.edge.network}' "$inspect_fields" 2>/dev/null || true)
fi
probe() {
  local n="$1" owned="\${2:-yes}" rec="" running=0 healthy=0 restarts=0 oom=0 ip="" code
  local port="\${3:-}" health_path="\${4:-/healthz}" _name owner r_running r_healthy r_restarts r_oom r_ip
  case "$seen" in *"|$n|"*) return;; esac
  seen="$seen$n|"
  if [ -n "\${inspected[$n]+x}" ]; then
    rec="\${inspected[$n]}"
  else
    rec=$(timeout 5 docker inspect -f "$inspect_format" "$n" 2>/dev/null | jq -r --arg network '${c.edge.network}' "$inspect_fields" 2>/dev/null) || rec=""
  fi
  if [ -n "$rec" ]; then
    IFS=$'\\x1f' read -r _name owner r_running r_healthy r_restarts r_oom r_ip <<< "$rec"
    if [ "$owned" = no ] || [ "$owner" = '${c.name}' ]; then
      running="$r_running"; healthy="$r_healthy"; restarts="$r_restarts"; oom="$r_oom"; ip="$r_ip"
    fi
  fi
  if [ -n "$port" ]; then
    code=000
    if [ "$running" = 1 ]; then
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
  # Every active generation is read by one jq, not one per app: every jq
  # start is a measurable cost.
  generation_files=()
  for current in /opt/2server/apps/*/current; do
    [ -f "$current" ] || continue
    root="\${current%/current}"; app="\${root##*/}"; color=$(<"$current")
    [[ "$app" =~ ^[a-z0-9][a-z0-9-]*$ ]] || continue
    case "$color" in blue|green) ;; *) exit 1;; esac
    generation_files+=("$root/$color.json")
  done
  if [ "\${#generation_files[@]}" -gt 0 ]; then
    generations=$(jq -r '(input_filename | capture("/(?<app>[^/]+)/(?<color>blue|green)[.]json$")) as $id |
      [$id.app, $id.color, (.replicas // 1), (if .compose then 1 else 0 end),
      (if .compose then (.compose.containers[$id.color] | tostring) else "" end),
      (.kind // "service"), (.port // ""), (.healthPath // "/healthz")] | map(tostring) | join("\\u001f")' "\${generation_files[@]}")
  else
    generations=""
  fi
  while IFS=$'\\x1f' read -r app color count is_compose compose_container kind port health_path; do
    [ -n "$app" ] || continue
    [[ "$count" =~ ^[0-9]+$ ]] && [ "$count" -le 32 ]
    for ((i=1;i<=count;i++)); do
      n="two-${c.name}-$app-$color"; [ "$i" = 1 ] || n="$n-$i"
      owned=yes
      if [ "$is_compose" = 1 ]; then
        n="$compose_container"
        owned=no
      fi
      if [ "$kind" = service ]; then
        probe "$n" "$owned" "$port" "$health_path"
      else
        probe "$n"
      fi
    done
  done <<< "$generations"
  ${extensionDiscovery(c)}
  # Live extensions, with every template identity read by one jq.
  declare -A template=()
  extensions=""
  identity_files=()
  for root in /opt/2server/extensions/*; do
    [ -f "$root/current/extension.json" ] && [ ! -f "$root/retired" ] || continue
    app="\${root##*/}"
    [[ "$app" =~ ^[a-z][a-z0-9-]*$ ]] || continue
    extensions="$extensions$app"$'\\n'
    if [ -f "$root/current/identity.json" ]; then identity_files+=("$root/current/identity.json"); fi
  done
  if [ "\${#identity_files[@]}" -gt 0 ]; then
    identities=$(jq -r 'input_filename + "\\t" + (.template | tostring)' "\${identity_files[@]}")
    while IFS=$'\\t' read -r file name; do
      [ -z "$file" ] || template["$file"]="$name"
    done <<< "$identities"
  fi
  while IFS= read -r app; do
    [ -n "$app" ] || continue
    ext="\${template[/opt/2server/extensions/$app/current/identity.json]:-$app}"
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
  done <<< "$extensions"
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
