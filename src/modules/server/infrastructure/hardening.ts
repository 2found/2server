// Host security baseline: one source for what `server harden --apply` writes,
// what bootstrap installs and what the read-only audit (plan, and the
// monitoring security collector) compares against. The audit reads effective
// state (`sshd -T`, `sysctl -n`, Docker inspect), never file contents, and
// prints only check names, ports, container names and counts.

type Accept = { equals: string[] } | { atMost: number } | { atLeast: number };
type Setting = { key: string; value: string; accept: Accept };

// First value wins in sshd: the 00- drop-in precedes distro/cloud-init files.
// Local forwarding stays available for operator tunnels to loopback services.
export const sshdBaseline: Setting[] = [
  { key: "PasswordAuthentication", value: "no", accept: { equals: ["no"] } },
  { key: "KbdInteractiveAuthentication", value: "no", accept: { equals: ["no"] } },
  { key: "PermitRootLogin", value: "prohibit-password", accept: { equals: ["no", "prohibit-password", "without-password"] } },
  { key: "PermitEmptyPasswords", value: "no", accept: { equals: ["no"] } },
  { key: "X11Forwarding", value: "no", accept: { equals: ["no"] } },
  { key: "AllowAgentForwarding", value: "no", accept: { equals: ["no"] } },
  { key: "AllowTcpForwarding", value: "local", accept: { equals: ["no", "local"] } },
  { key: "AllowStreamLocalForwarding", value: "no", accept: { equals: ["no"] } },
  { key: "MaxAuthTries", value: "3", accept: { atMost: 3 } },
  { key: "LoginGraceTime", value: "30", accept: { atMost: 60 } },
];

// Never touches forwarding (Docker needs ip_forward) or rp_filter (multi-homed
// and bridge traffic). Values a stricter operator raises still pass.
export const sysctlBaseline: Setting[] = [
  { key: "kernel.kptr_restrict", value: "2", accept: { atLeast: 1 } },
  { key: "kernel.dmesg_restrict", value: "1", accept: { atLeast: 1 } },
  { key: "kernel.yama.ptrace_scope", value: "1", accept: { atLeast: 1 } },
  { key: "kernel.unprivileged_bpf_disabled", value: "1", accept: { atLeast: 1 } },
  { key: "fs.protected_hardlinks", value: "1", accept: { atLeast: 1 } },
  { key: "fs.protected_symlinks", value: "1", accept: { atLeast: 1 } },
  { key: "fs.protected_fifos", value: "1", accept: { atLeast: 1 } },
  { key: "fs.protected_regular", value: "2", accept: { atLeast: 2 } },
  { key: "fs.suid_dumpable", value: "0", accept: { atMost: 0 } },
  { key: "net.ipv4.tcp_syncookies", value: "1", accept: { atLeast: 1 } },
  { key: "net.ipv4.icmp_echo_ignore_broadcasts", value: "1", accept: { atLeast: 1 } },
  { key: "net.ipv4.icmp_ignore_bogus_error_responses", value: "1", accept: { atLeast: 1 } },
  ...["all", "default"].flatMap((scope) => [
    { key: `net.ipv4.conf.${scope}.accept_redirects`, value: "0", accept: { atMost: 0 } },
    { key: `net.ipv4.conf.${scope}.secure_redirects`, value: "0", accept: { atMost: 0 } },
    { key: `net.ipv4.conf.${scope}.send_redirects`, value: "0", accept: { atMost: 0 } },
    { key: `net.ipv4.conf.${scope}.accept_source_route`, value: "0", accept: { atMost: 0 } },
    { key: `net.ipv6.conf.${scope}.accept_redirects`, value: "0", accept: { atMost: 0 } },
  ]),
];

// Only a server reached through GCP IAP ignores the IAP range, so a burst of
// bad keys through IAP (already IAM gated) cannot ban every operator path in.
// Any other host, on any provider, exempts loopback only. The distro filter
// keeps its own journalmatch: Debian 13's also matches OpenSSH 9.8 `sshd-session`.
export const gcpIapRange = "35.235.240.0/20";
export type HardeningTransport = { kind?: string; iap?: boolean };
export function fail2banJail(ssh?: HardeningTransport) {
  const ignore = ["127.0.0.1/8", "::1", ...(ssh?.kind === "gcp" && ssh.iap !== false ? [gcpIapRange] : [])];
  return `[DEFAULT]
ignoreip = ${ignore.join(" ")}
bantime = 1h
bantime.increment = true
bantime.maxtime = 1w
findtime = 10m
maxretry = 5

[sshd]
enabled = true
backend = systemd
mode = aggressive
`;
}

export const sshdDropIn = sshdBaseline.map((s) => `${s.key} ${s.value}`).join("\n") + "\n";
export const sysctlFile = sysctlBaseline.map((s) => `${s.key} = ${s.value}`).join("\n") + "\n";
export const unattendedUpgradesFile = `APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
`;
// LLMNR and mDNS answer name queries on every interface (5355/5353). A cloud
// VM resolves through its provider's DNS and needs neither.
export const resolvedDropIn = `[Resolve]
LLMNR=no
MulticastDNS=no
`;

function heredoc(path: string, body: string, tag: string) {
  return `cat > ${path} <<'${tag}'\n${body}${tag}\n`;
}

// Idempotent and validated before every reload. It never restarts Docker,
// reboots, flushes a firewall or changes SSH keys; the calling session stays up.
export function hardeningScript(ssh?: HardeningTransport): string {
  return `set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
exec 8>/var/lock/2server-harden.lock
flock -w 120 8
# --no-upgrade: hardening installs missing tools, it never upgrades packages.
if ! dpkg -s fail2ban python3-systemd unattended-upgrades >/dev/null 2>&1; then
  apt-get -o DPkg::Lock::Timeout=120 update -qq
  apt-get -o DPkg::Lock::Timeout=120 install -y --no-upgrade fail2ban python3-systemd unattended-upgrades
fi
${heredoc("/etc/apt/apt.conf.d/52two-server", unattendedUpgradesFile, "APT")}
mkdir -p /etc/ssh/sshd_config.d
grep -Eq '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\\.d/' /etc/ssh/sshd_config || { echo 'sshd_config does not include sshd_config.d; refusing to harden SSH' >&2; exit 1; }
ssh_backup=$(mktemp)
if [ -f /etc/ssh/sshd_config.d/00-2server.conf ]; then cp /etc/ssh/sshd_config.d/00-2server.conf "$ssh_backup"; else : > "$ssh_backup"; fi
${heredoc("/etc/ssh/sshd_config.d/00-2server.conf", sshdDropIn, "SSH")}
if ! /usr/sbin/sshd -t; then
  if [ -s "$ssh_backup" ]; then cp "$ssh_backup" /etc/ssh/sshd_config.d/00-2server.conf; else rm -f /etc/ssh/sshd_config.d/00-2server.conf; fi
  rm -f "$ssh_backup"
  echo 'sshd rejected the 2server baseline; previous SSH configuration restored' >&2
  exit 1
fi
rm -f "$ssh_backup"
systemctl reload ssh 2>/dev/null || systemctl reload sshd
mkdir -p /etc/fail2ban/jail.d
jail_backup=$(mktemp)
if [ -f /etc/fail2ban/jail.d/00-2server.conf ]; then cp /etc/fail2ban/jail.d/00-2server.conf "$jail_backup"; else : > "$jail_backup"; fi
${heredoc("/etc/fail2ban/jail.d/00-2server.conf", fail2banJail(ssh), "JAIL")}
if ! fail2ban-client -t >/dev/null; then
  if [ -s "$jail_backup" ]; then cp "$jail_backup" /etc/fail2ban/jail.d/00-2server.conf; else rm -f /etc/fail2ban/jail.d/00-2server.conf; fi
  rm -f "$jail_backup"
  echo 'fail2ban rejected the 2server jail; previous jail restored, fail2ban not restarted' >&2
  exit 1
fi
rm -f "$jail_backup"
systemctl enable fail2ban >/dev/null 2>&1
systemctl restart fail2ban
${heredoc("/etc/sysctl.d/60-2server-hardening.conf", sysctlFile, "SYSCTL")}
# -e skips keys this kernel lacks (IPv6 disabled, no Yama).
sysctl -e -q -p /etc/sysctl.d/60-2server-hardening.conf
if systemctl cat systemd-resolved.service >/dev/null 2>&1; then
  mkdir -p /etc/systemd/resolved.conf.d
  resolved_new=$(mktemp)
${heredoc('"$resolved_new"', resolvedDropIn, "RESOLVED")}  if cmp -s "$resolved_new" /etc/systemd/resolved.conf.d/60-2server.conf; then
    rm -f "$resolved_new"
  else
    install -m 644 "$resolved_new" /etc/systemd/resolved.conf.d/60-2server.conf
    rm -f "$resolved_new"
    # Only on a change; a no-op when resolved is not running.
    systemctl try-restart systemd-resolved
  fi
fi
`;
}

function acceptTest(variable: string, accept: Accept) {
  if ("equals" in accept) return `case "$${variable}" in ${accept.equals.join("|")}) true;; *) false;; esac`;
  const op = "atMost" in accept ? "-le" : "-ge";
  const limit = "atMost" in accept ? accept.atMost : accept.atLeast;
  return `[[ "$${variable}" =~ ^-?[0-9]+$ ]] && [ "$${variable}" ${op} ${limit} ]`;
}

// Read-only. Prints Prometheus text format; exits 0 with partial results when
// a probe fails, which surfaces as a failing check rather than a missing file.
// The allowlists come from every file in allowedExceptionsDir (one per
// monitoring App, `ports=` and `containers=` lines) plus the space-separated
// SECURITY_ALLOWED_PORTS / SECURITY_ALLOWED_CONTAINERS, so `server harden` and
// each collector see the same declared exceptions. SECURITY_AUDIT_ROOT prefixes
// file reads (tests).
export const allowedExceptionsDir = "/opt/2server/security/allowed.d";
export function securityAuditScript(): string {
  const sshChecks = sshdBaseline.map((s) => {
    const k = s.key.toLowerCase();
    const fallback = k === "kbdinteractiveauthentication" ? ` v=\${v:-$(get challengeresponseauthentication)};` : "";
    return `  v=$(get ${k});${fallback} if ${acceptTest("v", s.accept)}; then check ssh:${s.key} 1; else check ssh:${s.key} 0; fi`;
  }).join("\n");
  const sysctlChecks = sysctlBaseline.map((s) =>
    `if v=$(sysctl -n ${s.key} 2>/dev/null); then if ${acceptTest("v", s.accept)}; then check sysctl:${s.key} 1; else check sysctl:${s.key} 0; fi; fi`,
  ).join("\n");
  return `#!/bin/bash
# remote() runs \`bash -se\`: a failed probe must not end the report early.
set +e
set -uo pipefail
root="\${SECURITY_AUDIT_ROOT:-}"
allowed_ports=" 22 80 443 \${SECURITY_ALLOWED_PORTS:-} "
allowed_containers=" \${SECURITY_ALLOWED_CONTAINERS:-} "
for f in "$root"${allowedExceptionsDir}/*; do
  [ -f "$f" ] || continue
  # Only digits, or Docker-name characters, reach the lists: a file is never evaluated.
  while IFS='=' read -r k v; do
    case "$k" in
      ports) allowed_ports+="$(tr -cs '0-9' ' ' <<< "$v") ";;
      containers) allowed_containers+="$(tr -cs 'A-Za-z0-9_.-' ' ' <<< "$v") ";;
    esac
  done < "$f"
done
check() { printf 'two_security_check{check="%s"} %s\\n' "$1" "$2"; }
printf 'two_security_audit_timestamp_seconds %s\\n' "$(date +%s)"

if cfg=$(timeout 10 sshd -T 2>/dev/null) && [ -n "$cfg" ]; then
  get() { awk -v k="$1" '$1 == k { print $2; exit }' <<< "$cfg"; }
  check ssh:effective_config 1
${sshChecks}
else
  check ssh:effective_config 0
fi

${sysctlChecks}

if f2b=$(timeout 10 fail2ban-client status sshd 2>/dev/null); then
  check fail2ban:sshd 1
  banned=$(awk -F'\\t' '/Currently banned:/ { print $NF; exit }' <<< "$f2b")
  [[ "$banned" =~ ^[0-9]+$ ]] && printf 'two_security_fail2ban_banned{jail="sshd"} %s\\n' "$banned"
else
  check fail2ban:sshd 0
fi

unattended=0
eval "$(apt-config shell unattended APT::Periodic::Unattended-Upgrade 2>/dev/null)" 2>/dev/null || unattended=0
if [[ "$unattended" =~ ^[1-9][0-9]*$ ]]; then
  check apt:unattended_upgrades 1
else
  check apt:unattended_upgrades 0
fi
if stamp=$(stat -c %Y "$root/var/lib/apt/periodic/unattended-upgrades-stamp" 2>/dev/null) && [[ "$stamp" =~ ^[0-9]+$ ]]; then
  printf 'two_security_unattended_upgrades_last_run_timestamp_seconds %s\\n' "$stamp"
fi
if sim=$(timeout 90 apt-get -s -o Debug::NoLocking=1 dist-upgrade 2>/dev/null); then
  check apt:simulation 1
  printf 'two_security_updates_pending{kind="security"} %s\\n' "$(grep -Ec '^Inst .*(-security|Debian-Security)' <<< "$sim")"
  printf 'two_security_updates_pending{kind="container_runtime"} %s\\n' "$(grep -Ec '^Inst (docker-ce|docker-ce-cli|containerd[.]io|docker-compose-plugin|docker-buildx-plugin|runc) ' <<< "$sim")"
else
  check apt:simulation 0
fi

# A newer installed kernel of the running flavor, or the distro marker.
running=$(uname -r)
flavor=$(sed -E 's/^[0-9.]+(-[0-9]+)?//' <<< "$running")
newest=$(for f in "$root"/boot/vmlinuz-*"$flavor"; do [ -e "$f" ] && printf '%s\\n' "\${f##*/vmlinuz-}"; done | sort -V | tail -n 1)
if [ -e "$root/var/run/reboot-required" ] || { [ -n "$newest" ] && [ "$newest" != "$running" ]; }; then
  printf 'two_security_reboot_required 1\\n'
else
  printf 'two_security_reboot_required 0\\n'
fi

if systemctl is-active --quiet systemd-resolved 2>/dev/null; then
  protocols=$(timeout 10 resolvectl status 2>/dev/null | awk '/Protocols:/ { print; exit }')
  if [[ "$protocols" == *-LLMNR* && "$protocols" != *+mDNS* ]]; then check resolved:multicast_off 1; else check resolved:multicast_off 0; fi
fi

# The refresher running is not enough: the DOCKER-USER jump must be in place.
if systemctl is-active --quiet 2server-metadata-events.service 2>/dev/null \\
  && iptables -w 10 -C DOCKER-USER -d 169.254.169.254/32 -p tcp -m multiport --dports 80,443 -j TWO-METADATA 2>/dev/null; then
  check metadata:isolation 1
else
  check metadata:isolation 0
fi

# Listeners reachable beyond loopback and the Docker bridges, plus Docker
# published ports (iptables DNAT hides them from ss without the userland proxy).
# Each is labelled with its process (or container) so the owner is evident.
# Skipped: the GCE guest agent's plugins (random ports, owned by the platform)
# and resolved's LLMNR/mDNS, which resolved:multicast_off reports instead.
declare -A public=()
bridges=" $(ip -o -4 addr show 2>/dev/null | awk '$2 ~ /^(docker0|br-)/ { split($4, a, "/"); printf "%s ", a[1] }')"
while read -r proto local users; do
  addr="\${local%:*}"; port="\${local##*:}"
  [[ "$port" =~ ^[0-9]+$ ]] || continue
  case "$addr" in 127.*|'[::1]'|::1|*%lo|'[::ffff:127.'*) continue;; esac
  case "$bridges" in *" $addr "*) continue;; esac
  [ "$proto" = udp ] && case "$port" in 68|546) continue;; esac
  # users:(("name",pid=N,fd=M),...): the first process owns the socket.
  name=unknown exe=
  case "$users" in 'users:(("'*) name="\${users#'users:(("'}"; name="\${name%%'"'*}";; esac
  [[ "$users" =~ pid=([0-9]+) ]] && exe=$(readlink "$root/proc/\${BASH_REMATCH[1]}/exe" 2>/dev/null)
  case "$exe" in /usr/lib/google/guest_agent/*) continue;; esac
  case "$exe:$port" in */systemd/systemd-resolved:5355|*/systemd/systemd-resolved:5353) continue;; esac
  public["$proto/$port"]="\${name//[^A-Za-z0-9_.-]/_}"
done < <(ss -Hlntup 2>/dev/null | awk '{ print $1, $5, $7 }')
if names=$(timeout 10 docker ps -q 2>/dev/null) && [ -n "$names" ]; then
  inspected=$(timeout 20 docker inspect $names 2>/dev/null)
  while IFS=$'\\t' read -r proto port name; do
    [ -n "$port" ] && public["$proto/$port"]="container:$name"
  done < <(jq -r '.[] | (.Name | ltrimstr("/")) as $n | (.NetworkSettings.Ports // {}) | to_entries[] | select(.value != null) | (.key | split("/")) as $k
    | .value[] | select((.HostIp // "") | test("^(|0[.]0[.]0[.]0|::)$")) | "\\($k[1])\\t\\(.HostPort)\\t\\($n)"' <<< "$inspected" 2>/dev/null)
  while IFS=$'\\t' read -r name risk; do
    [ -n "$name" ] || continue
    case "$allowed_containers" in *" $name "*) continue;; esac
    printf 'two_security_container_risk{container="%s",risk="%s"} 1\\n' "$name" "$risk"
  done < <(jq -r '.[] | (.Name | ltrimstr("/")) as $n | [
      (if .HostConfig.Privileged then "privileged" else empty end),
      (if .HostConfig.NetworkMode == "host" then "host_network" else empty end),
      (if ((.HostConfig.CapAdd // []) | map(ascii_upcase | ltrimstr("CAP_")) | any(. == "SYS_ADMIN" or . == "ALL")) then "sys_admin" else empty end),
      (if ((.Mounts // []) | any((.Source // "") | test("(^|/)docker[.]sock$"))) then "docker_socket" else empty end)
    ] | unique[] | "\\($n)\\t\\(.)"' <<< "$inspected" 2>/dev/null)
fi
for key in "\${!public[@]}"; do
  port="\${key#*/}"
  case "$allowed_ports" in *" $port "*) continue;; esac
  printf 'two_security_public_listener{proto="%s",port="%s",process="%s"} 1\\n' "\${key%/*}" "$port" "\${public[$key]}"
done
exit 0
`;
}

export type AuditReport = {
  checks: { check: string; pass: boolean }[];
  failing: string[];
  rebootRequired: boolean | null;
  updatesPending: Record<string, number>;
  fail2banBanned: number | null;
  publicListeners: string[];
  containerRisks: { container: string; risk: string }[];
};

const line = /^([a-z_][a-z0-9_]*)(?:\{([^}]*)\})? (-?[0-9.]+)$/;
export function parseAudit(text: string): AuditReport {
  const report: AuditReport = { checks: [], failing: [], rebootRequired: null, updatesPending: {}, fail2banBanned: null, publicListeners: [], containerRisks: [] };
  for (const raw of text.split("\n")) {
    const m = line.exec(raw.trim());
    if (!m) continue;
    const labels = Object.fromEntries([...(m[2] ?? "").matchAll(/([a-z_]+)="([^"]*)"/g)].map((l) => [l[1], l[2]]));
    const value = Number(m[3]);
    if (m[1] === "two_security_check") report.checks.push({ check: labels.check, pass: value === 1 });
    else if (m[1] === "two_security_reboot_required") report.rebootRequired = value === 1;
    else if (m[1] === "two_security_updates_pending") report.updatesPending[labels.kind] = value;
    else if (m[1] === "two_security_fail2ban_banned") report.fail2banBanned = value;
    else if (m[1] === "two_security_public_listener") report.publicListeners.push(`${labels.port}/${labels.proto}${labels.process ? ` (${labels.process})` : ""}`);
    else if (m[1] === "two_security_container_risk") report.containerRisks.push({ container: labels.container, risk: labels.risk });
  }
  report.failing = report.checks.filter((c) => !c.pass).map((c) => c.check);
  report.publicListeners.sort();
  if (!report.checks.length) throw new Error("Security audit returned no checks; inspect SSH/sudo access on the VM");
  return report;
}
