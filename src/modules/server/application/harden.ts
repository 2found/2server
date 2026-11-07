import { quote } from "../../../shared/infrastructure/process";
import type { Config } from "../../config/application/config";
import { type AuditReport,hardeningScript,parseAudit,securityAuditScript } from "../infrastructure/hardening";

type Remote = (c: Config, script: string) => Promise<string>;

// Only a VM 2server set up (and, with a manifest, the same server) is audited
// or changed; a foreign host is never hardened by a mistyped connection.
function ownerGuard(name?: string) {
  return name
    ? `test "$(cat /opt/2server/edge/owner 2>/dev/null)" = ${quote(name)} || { echo 'VM is not owned by this server manifest' >&2; exit 1; }`
    : `test -s /opt/2server/edge/owner || { echo 'VM is not managed by 2server' >&2; exit 1; }`;
}

// What --apply changes. Everything else in the report is evidence for a
// deliberate operator decision (reboot, runtime upgrade, port, container).
export const hardenedChecks = /^(ssh|sysctl|fail2ban|apt:unattended_upgrades|resolved)/;

export type HardenResult = {
  applied: boolean;
  report: AuditReport;
  // Failing checks --apply would fix, and findings it never changes.
  fixable: string[];
  reportOnly: string[];
};

function result(applied: boolean, report: AuditReport): HardenResult {
  const reportOnly = [
    ...report.failing.filter((c) => !hardenedChecks.test(c)),
    ...(report.rebootRequired ? ["reboot required"] : []),
    ...Object.entries(report.updatesPending).filter(([, n]) => n > 0).map(([kind, n]) => `${n} ${kind} update(s) pending`),
    ...report.publicListeners.map((p) => `public listener ${p}`),
    ...report.containerRisks.map((r) => `container ${r.container}: ${r.risk}`),
  ];
  return { applied, report, fixable: report.failing.filter((c) => hardenedChecks.test(c)), reportOnly };
}

export async function hardenServer(c: Config, apply: boolean, remote: Remote, owner?: string): Promise<HardenResult> {
  const guard = ownerGuard(owner);
  if (apply) await remote(c, `${guard}\n${hardeningScript(c.ssh)}`);
  return result(apply, parseAudit(await remote(c, `${guard}\n${securityAuditScript()}`)));
}
