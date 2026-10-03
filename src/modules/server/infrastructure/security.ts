import type { Config } from '../../config/application/config';
import { remote } from '../../../shared/infrastructure/process';
import { upload } from '../../domains/infrastructure/edge';

export async function installMetadataPolicy(c: Config) {
  const policy = await Bun.file(new URL('../../../../scripts/metadata-firewall.py', import.meta.url)).text();
  await upload(c, {
    'metadata-firewall.py': policy,
    '20-2server-metadata.conf': `[Service]
ExecStartPre=/usr/bin/python3 /opt/2server/security/metadata-firewall.py --initialize
`,
    '2server-metadata.service': `[Unit]
Description=2server workload cloud metadata isolation
After=docker.service
Requires=docker.service
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /opt/2server/security/metadata-firewall.py
TimeoutStartSec=60
`,
    '2server-metadata.timer': `[Unit]
Description=Refresh workload metadata policy after container lifecycle changes
[Timer]
OnBootSec=5s
OnUnitInactiveSec=5s
AccuracySec=1s
[Install]
WantedBy=timers.target
`,
  }, '/opt/2server/security');
  await remote(c, `set -euo pipefail
install -d -m 755 /etc/systemd/system/docker.service.d
install -m 644 /opt/2server/security/20-2server-metadata.conf /etc/systemd/system/docker.service.d/
install -m 644 /opt/2server/security/2server-metadata.service /opt/2server/security/2server-metadata.timer /etc/systemd/system/
systemctl daemon-reload
systemctl start 2server-metadata.service
systemctl enable --now 2server-metadata.timer`);
}
