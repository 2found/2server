import { z } from "zod";
import { envKey, hostname, image, name, path } from "../../schema";
import type { Config } from "../../config";
import { upload, preflightEdge } from "../../edge";
import { remote, quote } from "../../process";
import { cloudflareClient } from "../../domains";
import { retireDomain } from "../../retire";
import { runtimeHealthFiles, runtimeHealthInstall, runtimeAlertRules } from "./runtime-health";
import { hasAlertReceivers, alertmanagerConfig } from "./webhooks";
import { postgresAlertRules } from "../postgres/health";
import type { Extension } from "../types";

import {
  monitoringName,
  monitoringDomain,
  monitoringSettings,
  monitoringAuth,
  monitoringCredentialPath,
} from "./settings";
export {
  monitoringName,
  monitoringDomain,
  monitoringSettings,
  monitoringAuth,
  monitoringCredentialPath,
};

export const monitoringImageDefaults = {
  prometheus: "prom/prometheus:v3.2.1",
  nodeExporter: "prom/node-exporter:v1.9.0",
  alertmanager: "prom/alertmanager:v0.28.1",
};

export const monitoringSchema = z
  .union([
    z.boolean(),
    z
      .object({
        images: z.object({
          prometheus: image.default(monitoringImageDefaults.prometheus),
          nodeExporter: image.default(monitoringImageDefaults.nodeExporter),
          alertmanager: image.default(monitoringImageDefaults.alertmanager),
        }).strict().default(monitoringImageDefaults).optional(),
        zone: hostname.optional(),
        hostname: hostname.optional(),
        username: z
          .string()
          .regex(/^[a-zA-Z0-9_-]{1,64}$/)
          .default("admin"),
        passwordEnv: envKey.optional(),
        adoptDns: z.boolean().default(false),
        containers: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/)).max(100).optional(),
        upstreams: z.array(z.object({
          name,
          file: path,
          healthPath: path.default("/healthz"),
        }).strict()).max(100).optional(),
      })
      .strict(),
  ])
  .default(false);

function monitoringImages(c: Config) {
  return {...monitoringImageDefaults,...(typeof c.extensions.monitoring==='object'?c.extensions.monitoring.images:undefined)};
}
export function monitoringCompose(c: Config) {
  const images=monitoringImages(c);
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
        image: images.prometheus,
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
        image: images.nodeExporter,
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
      image: images.alertmanager,
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
  const images=monitoringImages(c);
  return `set -Eeuo pipefail
exec 7>/var/lock/2server-extension-monitoring.lock
flock -w 120 7
test "$(cat /opt/2server/edge/owner)" = ${quote(c.name)}
root=/opt/2server/monitoring
candidate=${quote(release)}
chmod 644 "$candidate/prometheus.yml" "$candidate/alerts.yml"
docker run --rm --network none --user 0:0 -v "$candidate:/etc/prometheus:ro" --entrypoint /bin/promtool ${quote(images.prometheus)} check config /etc/prometheus/prometheus.yml >/dev/null
${hasAlertReceivers(c) ? `docker run --rm --network none --user 0:0 -v "$candidate:/fixture:ro" --entrypoint /bin/amtool ${quote(images.alertmanager)} check-config /fixture/alertmanager.yml >/dev/null` : ""}
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

export const monitoringExtension = {
  name: "monitoring",
  schema: monitoringSchema,
  template: {
    zone: "example.com",
    hostname: "monitor.example.com",
    passwordEnv: "MONITORING_PASSWORD",
  },
  acceptsWebhooks: true,
  // Alertmanager receivers travel with monitoring even in a scoped deploy.
  scoped: (c) => ({
    monitoring: c.extensions.monitoring,
    alertWebhookEnv: c.extensions.alertWebhookEnv,
    webhooks: c.extensions.webhooks,
  }),
  domains: (c) => {
    const d = monitoringDomain(c);
    return d ? [d] : [];
  },
  auth: (c, state) => monitoringAuth(c, state),
  logTarget: (c) => `two-${c.name}-prometheus`,
  async deploy(c) {
    const release = `/opt/2server/monitoring/releases/${crypto.randomUUID()}`;
    await upload(c, monitoringFiles(c), release);
    await remote(c, monitoringInstallScript(c, release));
  },
  // `c` arrives normalized by withExtensionDomains (remove-domain ownership).
  async remove(c) {
    await preflightEdge(c);
    const d = monitoringDomain(c);
    if (d) await retireDomain(c, d, cloudflareClient(c));
    await remote(
      c,
      `test "$(cat /opt/2server/edge/owner)" = ${quote(c.name)}
docker compose -p two-server-monitoring -f /opt/2server/monitoring/compose.json down
systemctl disable --now two-${c.name}-runtime-metrics.timer 2>/dev/null || true
systemctl stop two-${c.name}-runtime-metrics.service 2>/dev/null || true
rm -f /opt/2server/metrics/runtime.prom`,
    );
  },
  validate(c, ctx) {
    if (new Set(c.extensions.webhooks.map(w => w.name)).size !== c.extensions.webhooks.length)
      ctx.addIssue({ code: "custom", message: "Webhook names must be unique" });
    if (!c.extensions.monitoring) return;
    const m =
      typeof c.extensions.monitoring === "object"
        ? c.extensions.monitoring
        : undefined;
    const zones = [...new Set(c.domains.map((d) => d.zone))];
    const zone = m?.zone ?? (zones.length === 1 ? zones[0] : undefined);
    if (!zone)
      ctx.addIssue({
        code: "custom",
        message:
          "Monitoring requires an explicit zone when the manifest has zero or multiple zones",
      });
    else {
      const host = m?.hostname ?? `monitor.${zone}`;
      if (host !== zone && !host.endsWith(`.${zone}`))
        ctx.addIssue({
          code: "custom",
          message: "Monitoring hostname must belong to its zone",
        });
      if (!hostname.safeParse(host).success)
        ctx.addIssue({
          code: "custom",
          message: "Invalid monitoring hostname",
        });
      if (
        c.domains.some(
          (d) => d.name === "two-server-monitoring" || d.hosts.includes(host),
        )
      )
        ctx.addIssue({
          code: "custom",
          message:
            "Monitoring hostname/name conflicts with a declared domain",
        });
    }
  },
} satisfies Extension;
