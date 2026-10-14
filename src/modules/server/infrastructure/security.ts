import type { Config } from '../../config/application/config';
import { remote } from '../../../shared/infrastructure/process';
import { upload } from '../../domains/infrastructure/edge';

export async function metadataPolicyFiles(): Promise<Record<string, string>> {
  const policy = await Bun.file(new URL('../../../../scripts/metadata-firewall.py', import.meta.url)).text();
  return {
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
    // A started container has a new veth, so an allowed workload restarted
    // outside a 2server deploy (restart policy, autoheal, `docker restart`)
    // has no metadata access until the policy is refreshed. Refresh on the
    // Docker start event rather than polling: a 5s poll cost a Python start,
    // a full `docker inspect` and an nsenter per granted container, around
    // 5% of a small host's CPU, and still left a 5s gap. Starts arriving while
    // a refresh runs queue in the pipe and get their own pass. The format
    // names `.Action`: Docker 29 dropped the legacy top-level `.ID`, and a
    // template error exits the stream, which restarted the unit every 5s.
    'metadata-events.sh': `#!/bin/bash
set -uo pipefail
/usr/bin/python3 /opt/2server/security/metadata-firewall.py || echo 'metadata policy refresh failed' >&2
docker events --filter type=container --filter event=start --format '{{.Action}}' | while read -r _; do
  /usr/bin/python3 /opt/2server/security/metadata-firewall.py || echo 'metadata policy refresh failed' >&2
done
`,
    '2server-metadata-events.service': `[Unit]
Description=Refresh workload metadata policy when a container starts
After=docker.service
Requires=docker.service
PartOf=docker.service
[Service]
Type=simple
ExecStart=/bin/bash /opt/2server/security/metadata-events.sh
Restart=always
RestartSec=5
[Install]
WantedBy=docker.service multi-user.target
`,
    // Safety net for a missed event (the stream reconnecting, say); deny is
    // the chain's default, so a late refresh only ever delays an allow.
    '2server-metadata.timer': `[Unit]
Description=Refresh workload metadata policy after container lifecycle changes
[Timer]
OnBootSec=5s
OnUnitInactiveSec=60s
AccuracySec=1s
[Install]
WantedBy=timers.target
`,
  };
}

export async function installMetadataPolicy(c: Config) {
  await upload(c, await metadataPolicyFiles(), '/opt/2server/security');
  await remote(c, `set -euo pipefail
install -d -m 755 /etc/systemd/system/docker.service.d
install -m 644 /opt/2server/security/20-2server-metadata.conf /etc/systemd/system/docker.service.d/
install -m 644 /opt/2server/security/2server-metadata.service /opt/2server/security/2server-metadata.timer /opt/2server/security/2server-metadata-events.service /etc/systemd/system/
systemctl daemon-reload
systemctl start 2server-metadata.service
systemctl enable 2server-metadata-events.service
systemctl restart 2server-metadata-events.service
systemctl enable --now 2server-metadata.timer`);
}
