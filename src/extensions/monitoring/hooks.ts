import {instanceRoot,instanceName} from '../instance';
import {extensionProject} from '../../stateful';
import {monitoringNameFor} from './settings';
import { hostname } from "../../schema";
import type { Config } from "../../config";
import { upload, preflightEdge } from "../../edge";
import { remote, quote } from "../../process";
import { cloudflareClient } from "../../domains";
import { retireDomain } from "../../retire";
import { runtimeHealthFiles, runtimeHealthInstall, runtimeAlertRules } from "./runtime-health";
import { hasAlertReceivers, alertmanagerConfig } from "./webhooks";
import { postgresAlertRules } from "../postgres/health";
import type { ExtensionHooks } from "../types";
import type { ExtensionSpecs } from "../specs.generated";
import {catalogDefinition,declaredSchema,renderDeclaration} from "../catalog";

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

const definition = catalogDefinition("monitoring");
const defaults = declaredSchema(definition).parse({}) as Exclude<ExtensionSpecs["monitoring"], boolean>;
export const monitoringImageDefaults = defaults.images;

function monitoringImages(c: Config) {
  return {...monitoringImageDefaults,...(typeof c.extensions.monitoring==='object'?c.extensions.monitoring.images:undefined)};
}
export function monitoringCompose(c: Config) {
  const compose = renderDeclaration(definition.compose, {spec:{images:monitoringImages(c)},server:{...c,name:c.instance?`${c.name}-${c.instance.name}`:c.name},edge:c.edge}) as {
    services: Record<string, any>; networks: Record<string, unknown>; volumes: Record<string, unknown>;
  };
  compose.networks[c.edge.network] = {external:true};
  if(c.instance) for(const service of Object.values(compose.services)) delete service.ports;
  const settings = monitoringSettings(c);
  if (settings) compose.services.prometheus.command.push(`--web.external-url=https://${settings.hostname}`);
  if (!hasAlertReceivers(c)) {
    delete compose.services.alertmanager;
    delete compose.volumes.alerts;
  }
  if(c.instance)compose.services=Object.fromEntries(Object.entries(compose.services).map(([name,service])=>[extensionProject(c,name),{...service,labels:{'io.2server.owner':c.name,'io.2server.app':c.instance!.name}}]));
  return compose;
}

export function monitoringFiles(c: Config): Record<string, string> {
  const alertFiles: Record<string, string> = {};
  if (hasAlertReceivers(c))
    alertFiles["alertmanager.yml"] = JSON.stringify(alertmanagerConfig(c));
  const prometheus = renderDeclaration(definition.settings.prometheus, {server:{...c,name:c.instance?`${c.name}-${c.instance.name}`:c.name},edge:c.edge});
  if (!hasAlertReceivers(c)) {
    delete prometheus.alerting;
    prometheus.scrape_configs = prometheus.scrape_configs.filter((job: {job_name:string}) => job.job_name !== "alertmanager");
  }
  const alerts = structuredClone(definition.settings.alerts);
  const contributions = Bun.YAML.parse("groups:\n" + postgresAlertRules + runtimeAlertRules) as {groups:unknown[]};
  alerts.groups.push(...contributions.groups);
  return {
    ...alertFiles,
    ...runtimeHealthFiles(c),
    "compose.json": JSON.stringify(monitoringCompose(c)),
    "prometheus.yml": Bun.YAML.stringify(prometheus),
    "alerts.yml": Bun.YAML.stringify(alerts),
  };
}

export function monitoringInstallScript(c: Config, release: string) {
  const images=monitoringImages(c);
  return `set -Eeuo pipefail
exec 7>/var/lock/2server-extension-${instanceName(c,"monitoring")}.lock
flock -w 120 7
test "$(cat /opt/2server/edge/owner)" = ${quote(c.name)}
root=${instanceRoot(c,"/opt/2server/monitoring")}
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
      docker compose -p ${c.instance?extensionProject(c,"monitoring"):"two-server-monitoring"} -f "$candidate/compose.json" rm -s -f "$service" >/dev/null 2>&1 || true
    done
  else
    docker compose -p ${c.instance?extensionProject(c,"monitoring"):"two-server-monitoring"} -f "$candidate/compose.json" down >/dev/null 2>&1 || true
  fi
  for file in "$candidate"/*; do
    file=$(basename "$file")
    if [ -f "$backup/$file" ]; then cp "$backup/$file" "$root/$file"; else rm -f "$root/$file"; fi
  done
  if [ -f "$backup/compose.json" ]; then
    docker compose -p ${c.instance?extensionProject(c,"monitoring"):"two-server-monitoring"} -f "$root/compose.json" up -d --force-recreate --wait --wait-timeout 120 >/dev/null 2>&1 || echo 'Monitoring rollback failed; inspect retained private rollback directory' >&2
  fi
}
trap restore ERR
cp "$candidate"/* "$root/"
mkdir -p /opt/2server/metrics
chmod 755 /opt/2server/metrics
docker compose -p ${c.instance?extensionProject(c,"monitoring"):"two-server-monitoring"} -f "$root/compose.json" up -d --force-recreate --wait --wait-timeout 120 >/dev/null
# Retire removed receivers (not their history volumes) after the new stack is ready.
if [ -f "$backup/compose.json" ]; then
  for service in $(jq -r --slurpfile next "$root/compose.json" '.services | keys[] as $s | select($next[0].services[$s] == null) | $s' "$backup/compose.json"); do
    docker compose -p ${c.instance?extensionProject(c,"monitoring"):"two-server-monitoring"} -f "$backup/compose.json" rm -s -f "$service" >/dev/null
  done
fi
trap - ERR
${runtimeHealthInstall(c)}
`;
}

export const monitoringHooks = {
  domains: (c) => {
    const d = monitoringDomain(c);
    return d ? [d] : [];
  },
  auth: (c, state, create) => monitoringAuth(c, state,create),
  async deploy(c) {
    const release = `${instanceRoot(c,"/opt/2server/monitoring")}/releases/${crypto.randomUUID()}`;
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
docker compose -p ${c.instance?extensionProject(c,"monitoring"):"two-server-monitoring"} -f ${instanceRoot(c,"/opt/2server/monitoring")}/compose.json down
systemctl disable --now ${c.instance?extensionProject(c,"runtime-metrics"):`two-${c.name}-runtime-metrics`}.timer 2>/dev/null || true
systemctl stop ${c.instance?extensionProject(c,"runtime-metrics"):`two-${c.name}-runtime-metrics`}.service 2>/dev/null || true
rm -f /opt/2server/metrics/${instanceName(c,"runtime")}.prom`,
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
          (d) => d.name === monitoringNameFor(c) || d.hosts.includes(host),
        )
      )
        ctx.addIssue({
          code: "custom",
          message:
            "Monitoring hostname/name conflicts with a declared domain",
        });
    }
  },
} satisfies ExtensionHooks;
