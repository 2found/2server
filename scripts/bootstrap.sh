#!/bin/bash
set -euo pipefail
# Debian 12/13 or Ubuntu 22.04/24.04. Run through authenticated SSH, as root.
# No reboot, no Docker upgrade, no firewall flush, no change to SSH auth.
export DEBIAN_FRONTEND=noninteractive
. /etc/os-release
case "$ID:$VERSION_ID" in debian:12|debian:13|ubuntu:22.04|ubuntu:24.04) ;; *) echo 'Unsupported OS' >&2; exit 1;; esac
apt-get update -qq
apt-get install -y ca-certificates curl gnupg unattended-upgrades fail2ban jq openssl e2fsprogs xfsprogs util-linux
install -m 0755 -d /etc/apt/keyrings
if ! command -v docker >/dev/null; then
  curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
  chmod 0644 /etc/apt/keyrings/docker.asc
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' "$(dpkg --print-architecture)" "$ID" "$VERSION_CODENAME" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  apt-mark hold docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi
docker compose version >/dev/null
systemctl enable --now docker fail2ban
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=256M\nSystemKeepFree=1G\n' > /etc/systemd/journald.conf.d/2server.conf
systemctl restart systemd-journald
mkdir -p /opt/2server/edge/apps /opt/2server/edge/releases/initial/sites
chmod 0700 /opt/2server
[ -L /opt/2server/edge/current ] || ln -s releases/initial /opt/2server/edge/current
# Security updates may run automatically; kernel/runtime restarts remain deliberate.
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\nUnattended-Upgrade::Automatic-Reboot "false";\n' > /etc/apt/apt.conf.d/52two-server
# Bounded maintenance: never remove volumes or stopped rollback containers.
cat > /etc/systemd/system/2server-prune.service <<'UNIT'
[Unit]
Description=2server unused image and build cache maintenance
[Service]
Type=oneshot
ExecStart=/usr/bin/docker image prune -af --filter until=168h
ExecStart=/usr/bin/docker builder prune -af --filter until=168h
UNIT
cat > /etc/systemd/system/2server-prune.timer <<'UNIT'
[Unit]
Description=Daily 2server Docker maintenance
[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now 2server-prune.timer

# The CLI already authenticated with BatchMode/key-based SSH before this runs.
# Validate before reload and leave the current session alive.
mkdir -p /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/00-2server.conf <<'SSH'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
X11Forwarding no
MaxAuthTries 3
SSH
/usr/sbin/sshd -t
systemctl reload ssh
