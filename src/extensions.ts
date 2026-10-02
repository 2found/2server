import { deployStateful, statefulNames, statefulFiles } from "./stateful";
import type { Config } from "./config";
import { upload } from "./edge";
import { remote, quote } from "./process";
import { monitoringSettings } from "./monitoring";
import { runtimeHealthFiles, runtimeHealthInstall, runtimeAlertRules } from "./runtime-health";
import { hasAlertReceivers, alertmanagerConfig } from "./webhooks";
import { postgresAlertRules } from "./postgres-health";
export function monitoringCompose(c: Config) {
  const health = (port: number, path: string) => ({
    test: ["CMD", "wget", "-T", "2", "-qO-", `http://127.0.0.1:${port}${path}`],
    interval: "10s", timeout: "3s", retries: 6, start_period: "15s",
  });
  const limits = { security_opt: ["no-new-privileges:true"], cap_drop: ["ALL"], pids_limit: 128, stop_grace_period: "60s" };
  const logging = {
    driver: "json-file",
    options: { "max-size": "10m", "max-file": "3" },
  };
  const compose: {
    services: Record<string, unknown>;
    networks: Record<string, unknown>;
    volumes: Record<string, unknown>;
  } = {
    services: {
      prometheus: {
        ...limits,
        healthcheck: health(9090, "/-/ready"),
        image: "prom/prometheus:v3.2.1",
        container_name: `two-${c.name}-prometheus`,
        restart: "unless-stopped",
        mem_limit: "384m",
        cpus: 0.5,
        ports: ["127.0.0.1:9090:9090"],
        volumes: [
          "./prometheus.yml:/etc/prometheus/prometheus.yml:ro",
          "./alerts.yml:/etc/prometheus/alerts.yml:ro",
          "metrics:/prometheus",
        ],
        command: [
          "--config.file=/etc/prometheus/prometheus.yml",
          "--storage.tsdb.retention.time=7d",
          "--storage.tsdb.retention.size=1GB",
          // Lifecycle/admin HTTP mutations are disabled by default. Prometheus
          // boolean flags do not accept the --flag=false spelling.
          ...(monitoringSettings(c)
            ? [`--web.external-url=https://${monitoringSettings(c)!.hostname}`]
            : []),
        ],
        networks: [c.edge.network, "two_monitoring"],
        logging,
      },
      "node-exporter": {
        ...limits,
        healthcheck: health(9100, "/"),
        image: "prom/node-exporter:v1.9.0",
        container_name: `two-${c.name}-node-exporter`,
        restart: "unless-stopped",
        mem_limit: "64m",
        cpus: 0.25,
        pid: "host",
        volumes: ["/:/host:ro,rslave", "/opt/2server/metrics:/metrics:ro"],
        command: ["--path.rootfs=/host", "--collector.textfile.directory=/metrics"],
        networks: ["two_monitoring"],
        logging,
      },
    },
    networks: { [c.edge.network]: { external: true }, two_monitoring: {} },
    volumes: { metrics: {} },
  };
  if (hasAlertReceivers(c)) {
    compose.services.alertmanager = {
      ...limits,
      healthcheck: health(9093, "/-/ready"),
      cpus: 0.25,
      user: "0:0",
      image: "prom/alertmanager:v0.28.1",
      container_name: `two-${c.name}-alertmanager`,
      restart: "unless-stopped",
      mem_limit: "64m",
      ports: ["127.0.0.1:9093:9093"],
      volumes: [
        "./alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro",
        "alerts:/alertmanager",
      ],
      networks: ["two_monitoring"],
      logging,
    };
    compose.volumes.alerts = {};
  }
  return compose;
}
export function monitoringFiles(c: Config): Record<string, string> {
  const alertFiles: Record<string, string> = {};
  if (hasAlertReceivers(c))
    alertFiles["alertmanager.yml"] = JSON.stringify(alertmanagerConfig(c));
  return {
    ...alertFiles,
    ...runtimeHealthFiles(c),
    "compose.json": JSON.stringify(monitoringCompose(c)),
    "prometheus.yml":
      (hasAlertReceivers(c)
        ? `alerting:\n  alertmanagers:\n    - static_configs:\n        - targets: [two-${c.name}-alertmanager:9093]\n`
        : "") +
      `global:\n  scrape_interval: 30s\nrule_files: [alerts.yml]\nscrape_configs:\n  - job_name: node\n    static_configs:\n      - targets: [two-${c.name}-node-exporter:9100]\n  - job_name: prometheus\n    static_configs:\n      - targets: [localhost:9090]\n` +
      (hasAlertReceivers(c) ? `  - job_name: alertmanager\n    static_configs:\n      - targets: [two-${c.name}-alertmanager:9093]\n` : ""),
    "alerts.yml":
      'groups:\n  - name: host\n    rules:\n      - alert: HostDown\n        expr: up == 0\n        for: 2m\n      - alert: MemoryPressure\n        expr: node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes < 0.1\n        for: 5m\n      - alert: DiskPressure\n        expr: node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"} / node_filesystem_size_bytes < 0.1\n        for: 5m\n' + postgresAlertRules + runtimeAlertRules,
  };
}
export function monitoringInstallScript(c: Config, release: string) {
  return `set -Eeuo pipefail
exec 7>/var/lock/2server-extension-monitoring.lock
flock -w 120 7
test "$(cat /opt/2server/edge/owner)" = ${quote(c.name)}
root=/opt/2server/monitoring
candidate=${quote(release)}
chmod 644 "$candidate/prometheus.yml" "$candidate/alerts.yml"
docker run --rm --network none --user 0:0 -v "$candidate:/etc/prometheus:ro" --entrypoint /bin/promtool prom/prometheus:v3.2.1 check config /etc/prometheus/prometheus.yml >/dev/null
${hasAlertReceivers(c) ? `docker run --rm --network none --user 0:0 -v "$candidate:/fixture:ro" --entrypoint /bin/amtool prom/alertmanager:v0.28.1 check-config /fixture/alertmanager.yml >/dev/null` : ""}
backup=$(mktemp -d "$root/rollback.XXXXXX")
for file in "$candidate"/*; do
  file=$(basename "$file")
  if [ -f "$root/$file" ]; then cp "$root/$file" "$backup/$file"; fi
done
restore() {
  trap - ERR
  if [ -f "$backup/compose.json" ]; then
    for service in $(jq -r --slurpfile old "$backup/compose.json" '.services | keys[] as $s | select($old[0].services[$s] == null) | $s' "$candidate/compose.json"); do
      docker compose -p two-server-monitoring -f "$candidate/compose.json" rm -s -f "$service" >/dev/null 2>&1 || true
    done
  else
    docker compose -p two-server-monitoring -f "$candidate/compose.json" down >/dev/null 2>&1 || true
  fi
  for file in "$candidate"/*; do
    file=$(basename "$file")
    if [ -f "$backup/$file" ]; then cp "$backup/$file" "$root/$file"; else rm -f "$root/$file"; fi
  done
  if [ -f "$backup/compose.json" ]; then
    docker compose -p two-server-monitoring -f "$root/compose.json" up -d --force-recreate --wait --wait-timeout 120 >/dev/null 2>&1 || echo 'Monitoring rollback failed; inspect retained private rollback directory' >&2
  fi
}
trap restore ERR
cp "$candidate"/* "$root/"
mkdir -p /opt/2server/metrics
chmod 755 /opt/2server/metrics
docker compose -p two-server-monitoring -f "$root/compose.json" up -d --force-recreate --wait --wait-timeout 120 >/dev/null
# Retire removed receivers (not their history volumes) after the new stack is ready.
if [ -f "$backup/compose.json" ]; then
  for service in $(jq -r --slurpfile next "$root/compose.json" '.services | keys[] as $s | select($next[0].services[$s] == null) | $s' "$backup/compose.json"); do
    docker compose -p two-server-monitoring -f "$backup/compose.json" rm -s -f "$service" >/dev/null
  done
fi
trap - ERR
${runtimeHealthInstall(c)}
`;
}
export async function extensions(c: Config) {
  for (const name of statefulNames)
    if (c.extensions[name]) statefulFiles(c, name);
  for (const name of statefulNames)
    if (c.extensions[name]) await deployStateful(c, name);
  if (c.extensions.monitoring) {
    const release = `/opt/2server/monitoring/releases/${crypto.randomUUID()}`;
    await upload(c, monitoringFiles(c), release);
    await remote(c, monitoringInstallScript(c, release));
  }
  if (c.extensions.imageProxy) {
    const ext = c.extensions.imageProxy;
    const key = process.env[ext.keyEnv],
      salt = process.env[ext.saltEnv];
    if (
      !key ||
      !salt ||
      ![key, salt].every((v) => /^(?:[a-f0-9]{2}){32,}$/.test(v))
    )
      throw new Error(
        "imgproxy key/salt must be hex secrets of at least 32 bytes",
      );
    const sources = ext.allowedSources;
    if (
      sources.some((s) => {
        const u = new URL(s);
        return (
          u.protocol !== "https:" ||
          !!u.username ||
          !!u.password ||
          !!u.search ||
          !!u.hash ||
          !s.endsWith("/") ||
          /[\n\r,]/.test(s)
        );
      })
    )
      throw new Error(
        "imgproxy sources must be HTTPS path prefixes ending in /, without credentials or query strings",
      );
    const compose = {
      services: {
        imgproxy: {
          image: "darthsim/imgproxy:v3.27.2",
          container_name: `two-${c.name}-imgproxy`,
          restart: "unless-stopped",
          mem_limit: "256m",
          cpus: 0.5,
          security_opt: ["no-new-privileges:true"],
          cap_drop: ["ALL"],
          env_file: ["imgproxy.env"],
          networks: [c.edge.network],
          logging: {
            driver: "json-file",
            options: { "max-size": "10m", "max-file": "3" },
          },
        },
      },
      networks: { [c.edge.network]: { external: true } },
    };
    await upload(
      c,
      {
        "compose.json": JSON.stringify(compose),
        "imgproxy.env": `IMGPROXY_PATH_PREFIX=/i\nIMGPROXY_KEY=${key}\nIMGPROXY_SALT=${salt}\nIMGPROXY_ALLOWED_SOURCES=${sources.join(",")}\nIMGPROXY_ALLOW_LOOPBACK_SOURCE_ADDRESSES=false\nIMGPROXY_ALLOW_PRIVATE_SOURCE_ADDRESSES=false\nIMGPROXY_ALLOW_LINK_LOCAL_SOURCE_ADDRESSES=false\nIMGPROXY_MAX_SRC_RESOLUTION=25\nIMGPROXY_CONCURRENCY=2\nIMGPROXY_TTL=31536000\n`,
      },
      "/opt/2server/imgproxy",
    );
    await remote(
      c,
      "docker compose -p two-server-imgproxy -f /opt/2server/imgproxy/compose.json up -d",
    );
  }
}
