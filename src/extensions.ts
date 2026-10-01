import type { Config } from "./config";
import { upload } from "./edge";
import { remote, quote } from "./process";
import { monitoringSettings } from "./monitoring";
export function monitoringCompose(c: Config) {
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
          "--web.enable-lifecycle=false",
          ...(monitoringSettings(c)
            ? [`--web.external-url=https://${monitoringSettings(c)!.hostname}`]
            : []),
        ],
        networks: [c.edge.network],
        logging,
      },
      "node-exporter": {
        image: "prom/node-exporter:v1.9.0",
        restart: "unless-stopped",
        mem_limit: "64m",
        cpus: 0.25,
        pid: "host",
        volumes: ["/:/host:ro,rslave"],
        command: ["--path.rootfs=/host"],
        networks: [c.edge.network],
        logging,
      },
    },
    networks: { [c.edge.network]: { external: true } },
    volumes: { metrics: {} },
  };
  if (c.extensions.alertWebhookEnv) {
    compose.services.alertmanager = {
      user: "0:0",
      image: "prom/alertmanager:v0.28.1",
      restart: "unless-stopped",
      mem_limit: "64m",
      ports: ["127.0.0.1:9093:9093"],
      volumes: [
        "./alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro",
        "alerts:/alertmanager",
      ],
      networks: [c.edge.network],
      logging,
    };
    compose.volumes.alerts = {};
  }
  return compose;
}
export function monitoringFiles(c: Config): Record<string, string> {
  const alertFiles: Record<string, string> = {};
  if (c.extensions.alertWebhookEnv) {
    const url = process.env[c.extensions.alertWebhookEnv];
    if (!url || !URL.canParse(url) || new URL(url).protocol !== "https:")
      throw new Error(
        "Alert webhook must be an HTTPS secret environment value",
      );
    alertFiles["alertmanager.yml"] = JSON.stringify({
      route: {
        receiver: "operator",
        group_by: ["alertname"],
        group_wait: "30s",
        repeat_interval: "4h",
      },
      receivers: [
        { name: "operator", webhook_configs: [{ url, send_resolved: true }] },
      ],
    });
  }
  return {
    ...alertFiles,
    "compose.json": JSON.stringify(monitoringCompose(c)),
    "prometheus.yml":
      (c.extensions.alertWebhookEnv
        ? "alerting:\n  alertmanagers:\n    - static_configs:\n        - targets: [alertmanager:9093]\n"
        : "") +
      "global:\n  scrape_interval: 30s\nrule_files: [alerts.yml]\nscrape_configs:\n  - job_name: node\n    static_configs:\n      - targets: [node-exporter:9100]\n",
    "alerts.yml":
      'groups:\n  - name: host\n    rules:\n      - alert: HostDown\n        expr: up == 0\n        for: 2m\n      - alert: MemoryPressure\n        expr: node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes < 0.1\n        for: 5m\n      - alert: DiskPressure\n        expr: node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"} / node_filesystem_size_bytes < 0.1\n        for: 5m\n',
  };
}
export async function extensions(c: Config) {
  if (c.extensions.monitoring) {
    await upload(c, monitoringFiles(c), "/opt/2server/monitoring");
    await remote(
      c,
      "chmod 644 /opt/2server/monitoring/prometheus.yml /opt/2server/monitoring/alerts.yml && docker compose -p two-server-monitoring -f /opt/2server/monitoring/compose.json up -d",
    );
    await remote(
      c,
      `set -euo pipefail
for attempt in $(seq 1 30); do
  if docker run --rm --network ${quote(c.edge.network)} curlimages/curl:8.12.1 -fsS --connect-timeout 2 --max-time 3 http://two-${c.name}-prometheus:9090/-/ready >/dev/null 2>&1; then exit 0; fi
  sleep 2
done
echo 'Prometheus readiness failed; DNS was not published' >&2
exit 1
`,
    );
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
