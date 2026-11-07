import { expect,test } from "bun:test";
import { chmod,mkdir,mkdtemp,rm,symlink,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/modules/config/application/config";
import { readConfig } from "../src/modules/config/infrastructure/file";
import { renderEdge,renderSite } from "../src/modules/domains/infrastructure/render";
import { monitoringFiles,monitoringInstallScript } from "../src/modules/extensions/infrastructure/templates/monitoring/hooks";
import { hardenServer } from "../src/modules/server/application/harden";
import { hardeningScript,parseAudit,securityAuditScript,sshdBaseline,sysctlBaseline } from "../src/modules/server/infrastructure/hardening";

// Each stubbed probe is a process start; macOS runners need more than 5s.
const slow = 30000;
const example = () => readConfig(new URL("../examples/server.json", import.meta.url).pathname);

test("hardening validates before every reload, restores SSH on rejection and never restarts Docker or upgrades", () => {
  const s = hardeningScript();
  const order = ["sshd_config.d/00-2server.conf <<'SSH'", "/usr/sbin/sshd -t", "systemctl reload ssh", "fail2ban-client -t", "systemctl restart fail2ban", "sysctl -e -q -p", "LLMNR=no", "systemctl try-restart systemd-resolved"];
  const at = order.map((step) => s.indexOf(step));
  expect(at.every((i) => i >= 0)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
  expect(s).toContain("previous SSH configuration restored");
  expect(s).toContain("previous jail restored, fail2ban not restarted");
  expect(s).toContain("refusing to harden SSH");
  expect(s).toContain("install -y --no-upgrade fail2ban python3-systemd unattended-upgrades");
  for (const forbidden of [/restart docker/, /reboot/, /iptables -F/, /authorized_keys/, /ip_forward/, /rp_filter/]) expect(s).not.toMatch(forbidden);
  for (const setting of sshdBaseline) expect(s).toContain(`${setting.key} ${setting.value}\n`);
  for (const setting of sysctlBaseline) expect(s).toContain(`${setting.key} = ${setting.value}\n`);
  // The IAP range is never banned: it is every operator path into a GCP VM.
  expect(s).toContain("ignoreip = 127.0.0.1/8 ::1 35.235.240.0/20");
});

test("hardening and audit scripts are valid bash", async () => {
  for (const script of [hardeningScript(), securityAuditScript()]) {
    const p = Bun.spawn(["bash", "-n"], { stdin: new Blob([script]), stdout: "pipe", stderr: "pipe" });
    expect(await p.exited).toBe(0);
  }
});

type Host = {
  sshd?: string; sysctl?: Record<string, string>; fail2ban?: boolean; listeners?: string[];
  containers?: unknown[]; kernels?: string[]; apt?: string; metadata?: boolean; allowPorts?: string; allowContainers?: string; broken?: boolean;
  llmnr?: boolean; exes?: Record<string, string>;
};
const goodSshd = "passwordauthentication no\nkbdinteractiveauthentication no\npermitrootlogin without-password\npermitemptypasswords no\nx11forwarding no\nallowagentforwarding no\nallowtcpforwarding local\nallowstreamlocalforwarding no\nmaxauthtries 3\nlogingracetime 30\n";
const goodSysctl = Object.fromEntries(sysctlBaseline.map((s) => [s.key, s.value]));

async function audit(host: Host) {
  const root = await mkdtemp(join(tmpdir(), "two-security-audit-"));
  try {
    const bin = join(root, "bin");
    await mkdir(bin);
    await mkdir(join(root, "fs/boot"), { recursive: true });
    for (const k of host.kernels ?? ["6.1.0-28-cloud-amd64"]) await writeFile(join(root, "fs/boot", `vmlinuz-${k}`), "");
    await writeFile(join(root, "sysctl.txt"), Object.entries(host.sysctl ?? goodSysctl).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
    await writeFile(join(root, "inspect.json"), JSON.stringify(host.containers ?? []));
    for (const [pid, exe] of Object.entries(host.exes ?? {})) {
      await mkdir(join(root, "fs/proc", pid), { recursive: true });
      await symlink(exe, join(root, "fs/proc", pid, "exe"));
    }
    const stubs: Record<string, string> = {
      timeout: 'shift; exec "$@"',
      sshd: host.sshd === undefined ? `printf '%s' '${goodSshd}'` : host.sshd ? `printf '%s' '${host.sshd}'` : "exit 255",
      sysctl: `[ "$1" = -n ] || exit 1; v=$(awk -F= -v k="$2" '$1 == k { print $2 }' '${root}/sysctl.txt'); [ -n "$v" ] || exit 255; echo "$v"`,
      "fail2ban-client": host.fail2ban === false ? "exit 255" : `printf 'Status for the jail: sshd\\n|- Filter\\n\`- Actions\\n   |- Currently banned:\\t4\\n'`,
      "apt-config": `echo "unattended='1'"`,
      "apt-get": `printf '%s' '${host.apt ?? ""}'`,
      stat: "echo 1700000000",
      uname: "echo 6.1.0-28-cloud-amd64",
      ip: host.broken ? "exit 1" : "echo '5: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0'",
      ss: `printf '%s\\n' ${(host.listeners ?? ["tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*", "tcp LISTEN 0 4096 127.0.0.1:9090 0.0.0.0:*", "udp UNCONN 0 0 0.0.0.0:68 0.0.0.0:*"]).map((l) => `'${l}'`).join(" ")}`,
      docker: host.broken ? `case "$1" in ps) echo abc;; *) exit 1;; esac` : `case "$1" in ps) ${host.containers?.length ? "echo abc" : "true"};; inspect) cat '${root}/inspect.json';; esac`,
      systemctl: host.metadata === false ? "exit 3" : "exit 0",
      resolvectl: `printf 'Global\\n       Protocols: ${host.llmnr ? "+LLMNR" : "-LLMNR"} -mDNS -DNSOverTLS DNSSEC=no/unsupported\\n'`,
    };
    for (const [name, body] of Object.entries(stubs)) {
      await writeFile(join(bin, name), `#!/bin/bash\n${body}\n`);
      await chmod(join(bin, name), 0o755);
    }
    // remote() runs `sudo -n bash -se`: errexit is on, as on the VM.
    const p = Bun.spawn(["bash", "-se"], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SECURITY_AUDIT_ROOT: join(root, "fs"), SECURITY_ALLOWED_PORTS: host.allowPorts ?? "", SECURITY_ALLOWED_CONTAINERS: host.allowContainers ?? "" },
      stdin: new Blob([securityAuditScript()]), stdout: "pipe", stderr: "pipe",
    });
    const [out] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    expect(await p.exited).toBe(0);
    return { text: out, report: parseAudit(out) };
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("audit of a hardened host passes every check and reports nothing unexpected", async () => {
  const { text, report } = await audit({});
  expect(report.failing).toEqual([]);
  expect(report.checks.length).toBe(1 + sshdBaseline.length + sysctlBaseline.length + 5);
  expect(report).toMatchObject({ rebootRequired: false, fail2banBanned: 4, publicListeners: [], containerRisks: [], updatesPending: { security: 0, container_runtime: 0 } });
  expect(text).toContain("two_security_unattended_upgrades_last_run_timestamp_seconds 1700000000");
}, slow);

test("audit of a drifted host names each failing check, listener, risky container and pending update", async () => {
  const privileged = {
    Name: "/cadvisor", HostConfig: { Privileged: true, NetworkMode: "bridge", CapAdd: ["cap_sys_admin"] },
    Mounts: [{ Source: "/var/run/docker.sock" }], NetworkSettings: { Ports: { "6379/tcp": [{ HostIp: "0.0.0.0", HostPort: "6379" }, { HostIp: "::", HostPort: "6379" }], "9000/tcp": [{ HostIp: "127.0.0.1", HostPort: "9000" }] } },
  };
  const allowed = { Name: "/agent", HostConfig: { NetworkMode: "host" }, Mounts: [], NetworkSettings: { Ports: {} } };
  const { report } = await audit({
    sshd: goodSshd.replace("passwordauthentication no", "passwordauthentication yes").replace("maxauthtries 3", "maxauthtries 6"),
    sysctl: { ...goodSysctl, "kernel.kptr_restrict": "0" },
    fail2ban: false, metadata: false,
    kernels: ["6.1.0-28-cloud-amd64", "6.1.0-31-cloud-amd64", "6.12.0-1-amd64"],
    apt: "Inst libssl3 [3.0.14-1] (3.0.15-1 Debian-Security:12/stable-security [amd64])\nInst tzdata [a] (b Debian:12.8/stable [all])\nInst containerd.io [1.7.1-1] (1.7.2-1 Docker CE:bookworm [amd64])\n",
    listeners: [
      'tcp LISTEN 0 4096 0.0.0.0:5432 0.0.0.0:* users:(("postgres",pid=40,fd=5))', "tcp LISTEN 0 4096 [::]:8443 [::]:*",
      "tcp LISTEN 0 4096 172.17.0.1:7000 0.0.0.0:*", "tcp LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:*", "udp UNCONN 0 0 *:5353 *:*",
    ],
    containers: [privileged, allowed], allowPorts: "8443", allowContainers: "agent",
  });
  expect(report.failing.sort()).toEqual(["fail2ban:sshd", "metadata:isolation", "ssh:MaxAuthTries", "ssh:PasswordAuthentication", "sysctl:kernel.kptr_restrict"]);
  expect(report.rebootRequired).toBe(true);
  expect(report.updatesPending).toEqual({ security: 1, container_runtime: 1 });
  expect(report.publicListeners).toEqual(["5353/udp (unknown)", "5432/tcp (postgres)", "6379/tcp (container:cadvisor)"]);
  expect(report.containerRisks.map((r) => r.risk).sort()).toEqual(["docker_socket", "privileged", "sys_admin"]);
  expect(report.containerRisks.every((r) => r.container === "cadvisor")).toBe(true);
}, slow);

// Shape observed on a GCE Debian 12 VM: the guest agent's plugins listen on
// random ports, resolved answers LLMNR on every interface, an app binds `*`.
test("platform guest-agent listeners are skipped and LLMNR is a fixable check, not a listener", async () => {
  const { report } = await audit({
    llmnr: true,
    exes: { 731: "/usr/lib/google/guest_agent/GuestTelemetryExtension/guest_telemetry", 374: "/usr/lib/systemd/systemd-resolved", 900: "/var/lib/soot/bin/soot" },
    listeners: [
      'tcp LISTEN 0 4096 *:36295 *:* users:(("guest_telemetry",pid=731,fd=4))',
      'udp UNCONN 0 0 0.0.0.0:5355 0.0.0.0:* users:(("systemd-resolve",pid=374,fd=11))',
      'tcp LISTEN 0 4096 [::]:5355 [::]:* users:(("systemd-resolve",pid=374,fd=14))',
      'tcp LISTEN 0 4096 *:7788 *:* users:(("soot",pid=900,fd=25))',
      // A process merely named like the agent is still reported.
      'tcp LISTEN 0 4096 0.0.0.0:4444 0.0.0.0:* users:(("guest_telemetry",pid=901,fd=3))',
    ],
  });
  expect(report.failing).toEqual(["resolved:multicast_off"]);
  expect(report.publicListeners).toEqual(["4444/tcp (guest_telemetry)", "7788/tcp (soot)"]);
}, slow);

test("an unreadable SSH configuration or failing probe fails closed and the report still completes", async () => {
  const { report } = await audit({ sshd: "", broken: true });
  expect(report.failing).toEqual(["ssh:effective_config"]);
  expect(report.checks.some((c) => c.check === "ssh:PasswordAuthentication")).toBe(false);
  // Probes after the failures (ip, docker inspect, systemctl) still reported.
  expect(report.checks.at(-1)).toEqual({ check: "metadata:isolation", pass: true });
  expect(report.rebootRequired).toBe(false);
}, slow);

test("an empty or failed audit is an error, not a clean report", () => {
  expect(() => parseAudit("")).toThrow("no checks");
});

test("server harden plans read-only, applies baseline then re-audits, and refuses a foreign VM", async () => {
  const clean = (await audit({})).text;
  const sent: string[] = [];
  const remote = async (_c: Config, script: string) => { sent.push(script); return script.includes("two_security_check") ? clean : ""; };
  const c = { ssh: { kind: "direct" } } as unknown as Config;
  const plan = await hardenServer(c, false, remote);
  expect(plan).toMatchObject({ applied: false, fixable: [], reportOnly: [] });
  expect(sent).toHaveLength(1);
  expect(sent[0]).not.toContain("sshd -t");
  expect(sent[0]).toContain("test -s /opt/2server/edge/owner");
  sent.length = 0;
  await hardenServer(c, true, remote, "prod's");
  expect(sent).toHaveLength(2);
  expect(sent[0]).toContain("/usr/sbin/sshd -t");
  expect(sent[1]).toContain("two_security_check");
  for (const script of sent) expect(script).toContain(`= 'prod'\\''s' ||`);
  const failing = async () => { throw new Error("ssh failed (exit 1)"); };
  await expect(hardenServer(c, true, failing, "prod")).rejects.toThrow("ssh failed");
}, slow);

test("monitoring installs the security collector with its allowlists and security alert rules", async () => {
  const c = await example();
  c.extensions.monitoring = { ...(typeof c.extensions.monitoring === "object" ? c.extensions.monitoring : {}), security: { allowedPublicPorts: [5432], allowedContainers: ["agent"] } } as any;
  const files = monitoringFiles(c);
  expect(files["security-audit.sh"]).toBe(securityAuditScript());
  expect(files["security-metrics.sh"]).toContain("SECURITY_ALLOWED_PORTS='5432' SECURITY_ALLOWED_CONTAINERS='agent'");
  expect(files["security-metrics.sh"]).toContain(`/opt/2server/metrics/`);
  expect(files["security-metrics.timer"]).toContain("OnUnitActiveSec=15m");
  const alerts = Bun.YAML.parse(files["alerts.yml"]) as { groups: { name: string; rules: { alert: string }[] }[] };
  const security = alerts.groups.find((g) => g.name === "security")!;
  expect(security.rules.map((r) => r.alert)).toEqual(expect.arrayContaining(["SecurityBaselineDrift", "UnexpectedPublicListener", "InsecureContainer", "HostRebootRequired", "SecurityUpdatesPending"]));
  const install = monitoringInstallScript(c, "/opt/2server/monitoring/releases/x");
  expect(install).toContain(`systemctl enable --now two-${c.name}-security-metrics.timer`);
  expect(install.indexOf("security-metrics.timer")).toBeGreaterThan(install.indexOf("trap - ERR"));
});

test("edge sets HSTS without overriding an upstream policy and keeps only NET_BIND_SERVICE", async () => {
  const c = await example();
  expect(renderSite(c.domains[0])).toContain('?Strict-Transport-Security "max-age=31536000"');
  const caddy = renderEdge(c).services.caddy as Record<string, unknown>;
  expect(caddy).toMatchObject({ cap_drop: ["ALL"], cap_add: ["NET_BIND_SERVICE"], security_opt: ["no-new-privileges:true"] });
});
