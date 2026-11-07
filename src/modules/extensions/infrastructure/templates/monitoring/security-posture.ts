import type { Config } from "../../../../config/application/config";
import { securityAuditScript } from "../../../../server/infrastructure/hardening";
import { extensionProject } from '../../../application/stateful';
import { instanceName,instanceRoot } from '../../../domain/instance';
import type { ExtensionSpecs } from "../../../domain/specs.generated";

// The host security collector runs the same read-only audit as `server harden`
// on a root timer and publishes it through the node-exporter textfile
// directory. Like runtime metrics, nothing here mounts the Docker socket into a
// container; the collector reads state and never changes the host.
type Monitoring = Exclude<ExtensionSpecs["monitoring"], boolean>;
function securityOptions(c: Config): NonNullable<Monitoring["security"]> {
  const m = c.extensions.monitoring;
  return (typeof m === "object" ? m.security : undefined) ?? {};
}
export function securityUnit(c: Config) {
  return c.instance ? extensionProject(c, "security-metrics") : `two-${c.name}-security-metrics`;
}
export function securityPostureFiles(c: Config): Record<string, string> {
  const o = securityOptions(c);
  // Schema-validated integers and Docker names: safe inside single quotes.
  const ports = (o.allowedPublicPorts ?? []).join(" ");
  const containers = (o.allowedContainers ?? []).join(" ");
  const root = instanceRoot(c, "/opt/2server/monitoring");
  const label = c.instance
    ? ` | sed -E -e 's/^([a-zA-Z_:][a-zA-Z0-9_:]*)\\{/\\1{collector="${c.instance.name}",/' -e t -e 's/^([a-zA-Z_:][a-zA-Z0-9_:]*) /\\1{collector="${c.instance.name}"} /'`
    : "";
  return {
    "security-audit.sh": securityAuditScript(),
    "security-metrics.sh": `#!/bin/bash
set -euo pipefail
mkdir -p /opt/2server/metrics
chmod 755 /opt/2server/metrics
tmp=$(mktemp /opt/2server/metrics/.security.XXXXXX)
trap 'rm -f "$tmp"' EXIT
SECURITY_ALLOWED_PORTS='${ports}' SECURITY_ALLOWED_CONTAINERS='${containers}' /bin/bash ${root}/security-audit.sh${label} > "$tmp"
chmod 644 "$tmp"
mv -f "$tmp" /opt/2server/metrics/${instanceName(c, "security")}.prom
`,
    "security-metrics.service": `[Unit]\nDescription=2server host security audit metrics\nAfter=docker.service\n[Service]\nType=oneshot\nNice=10\nIOSchedulingClass=idle\nExecStart=/bin/bash ${root}/security-metrics.sh\nTimeoutStartSec=180s\n`,
    "security-metrics.timer": `[Unit]\nDescription=2server host security audit\n[Timer]\nOnBootSec=2m\nOnUnitActiveSec=15m\nRandomizedDelaySec=60s\nUnit=${securityUnit(c)}.service\n[Install]\nWantedBy=timers.target\n`,
  };
}
export function securityPostureInstall(c: Config) {
  const root = instanceRoot(c, "/opt/2server/monitoring"), unit = securityUnit(c);
  return `install -m 644 ${root}/security-metrics.service /etc/systemd/system/${unit}.service
install -m 644 ${root}/security-metrics.timer /etc/systemd/system/${unit}.timer
systemctl daemon-reload
systemctl enable --now ${unit}.timer
systemctl start --no-block ${unit}.service`;
}
export function securityPostureRemove(c: Config) {
  const unit = securityUnit(c);
  return `systemctl disable --now ${unit}.timer 2>/dev/null || true
systemctl stop ${unit}.service 2>/dev/null || true
rm -f /opt/2server/metrics/${instanceName(c, "security")}.prom`;
}

// `severity` and `summary` reach the Discord message; drift alerts carry the
// failing check name so the fix (`server harden --apply`) is unambiguous.
export const securityAlertRules = `
  - name: security
    rules:
      - alert: SecurityAuditMissing
        expr: absent(two_security_audit_timestamp_seconds)
        for: 1h
        labels: {severity: warning}
        annotations: {summary: "Host security audit has not reported; check the security-metrics timer"}
      - alert: SecurityAuditStale
        expr: time() - two_security_audit_timestamp_seconds > 2700
        for: 15m
        labels: {severity: warning}
        annotations: {summary: "Host security audit is older than 45 minutes"}
      - alert: SecurityBaselineDrift
        expr: two_security_check == 0
        for: 15m
        labels: {severity: critical}
        annotations: {summary: "Security check {{ $labels.check }} fails; review, then run server harden (--apply for SSH/fail2ban/sysctl/updates)"}
      - alert: UnexpectedPublicListener
        expr: two_security_public_listener == 1
        for: 10m
        labels: {severity: critical}
        annotations: {summary: "Port {{ $labels.port }}/{{ $labels.proto }} ({{ $labels.process }}) listens beyond loopback; unpublish it or allow it in monitoring.security"}
      - alert: InsecureContainer
        expr: two_security_container_risk == 1
        for: 10m
        labels: {severity: critical}
        annotations: {summary: "Container {{ $labels.container }} runs with {{ $labels.risk }} (host-root equivalent)"}
      - alert: SecurityUpdatesPending
        expr: two_security_updates_pending{kind="security"} > 0
        for: 48h
        labels: {severity: warning}
        annotations: {summary: "{{ $value }} OS security update(s) still pending after two days; unattended-upgrades may be blocked"}
      - alert: ContainerRuntimeUpdatePending
        expr: two_security_updates_pending{kind="container_runtime"} > 0
        for: 7d
        labels: {severity: warning}
        annotations: {summary: "Docker/containerd update pending for a week; runtime upgrades are deliberate, schedule one"}
      - alert: UnattendedUpgradesStale
        expr: time() - two_security_unattended_upgrades_last_run_timestamp_seconds > 259200
        for: 1h
        labels: {severity: warning}
        annotations: {summary: "unattended-upgrades has not run for three days"}
      - alert: HostRebootRequired
        expr: two_security_reboot_required == 1
        for: 72h
        labels: {severity: warning}
        annotations: {summary: "A newer kernel or library needs a reboot to take effect; schedule a maintenance window"}
`;
