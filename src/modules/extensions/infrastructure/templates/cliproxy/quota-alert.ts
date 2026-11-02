import { readFileSync } from 'node:fs';
import { quote } from '../../../../../shared/infrastructure/process';
import type { Config } from '../../../../config/application/config';
import { extensionProject,extensionRoot } from '../../../application/stateful';
import { instanceName } from '../../../domain/instance';
import type { ExtensionSpecs } from '../../../domain/specs.generated';
import {
  ANTIGRAVITY_DEFAULT_ENDPOINT,ANTIGRAVITY_ENDPOINT_PATTERN,ANTIGRAVITY_QUOTA_MODELS,ANTIGRAVITY_USER_AGENT,
  CODEX_QUOTA_MODEL,CODEX_USAGE_URL,CODEX_USER_AGENT,
} from './quota';
import type { Config as RuntimeConfig } from './quota-alert.runtime';

// Opt-in `quotaAlert`: a sidecar container in the gateway's compose project
// that reads the live quota exactly as `app NAME quota` does (the management
// API, with the shared probe constants of ./quota.ts) and posts to a Discord
// webhook when a model's pool is nearly exhausted. The program
// (quota-alert.runtime.ts) runs on a distroless Bun image as its own uid with a
// read-only root and no capabilities; nothing of it runs on the VM host. The
// webhook URL and management key reach it only as one 0400 file owned by that
// uid, mounted read-only.
type Spec = NonNullable<ExtensionSpecs['cliproxy']>;
type QuotaAlert = NonNullable<Spec['quotaAlert']>;

// Its own uid: the gateway (65532) can neither read the secrets nor touch the state.
export const QUOTA_ALERT_USER = '65533:65533';
const WEBHOOK = /^https:\/\/(?:(?:ptb\.|canary\.)?discord(?:app)?\.com)\/api\/webhooks\/[0-9]{5,25}\/[A-Za-z0-9_-]{20,200}$/;
const SOURCE = readFileSync(new URL('./quota-alert.runtime.ts', import.meta.url), 'utf8');

export const quotaAlertContainer = (c: Config) => `${extensionProject(c, 'cliproxy')}-quota-alert`;
export const quotaAlertStateDir = (c: Config) => `${extensionRoot('cliproxy', c)}/quota-alert.d`;

export function checkWebhook(url: string): string {
  if (!WEBHOOK.test(url)) throw new Error('quotaAlert.webhookEnv must hold a Discord webhook URL (https://discord.com/api/webhooks/ID/TOKEN)');
  return url;
}

export function quotaAlertConfig(c: Config, q: QuotaAlert, port: number): RuntimeConfig {
  return {
    app: instanceName(c, 'cliproxy'),
    // The gateway by its container name on the shared network (its management
    // API accepts remote callers with the key); not its network namespace, which
    // a gateway restart would leave stale.
    baseUrl: `http://${extensionProject(c, 'cliproxy')}:${port}/v0/management`,
    ...(q.models ? {models: q.models} : {}),
    thresholdPercent: q.thresholdPercent,
    repageSeconds: q.repageMinutes * 60,
    intervalSeconds: q.intervalMinutes * 60,
    gatewayFailures: 3,
    antigravity: {
      models: ANTIGRAVITY_QUOTA_MODELS.map(([key]) => key),
      endpoint: ANTIGRAVITY_DEFAULT_ENDPOINT,
      endpointPattern: ANTIGRAVITY_ENDPOINT_PATTERN,
      userAgent: ANTIGRAVITY_USER_AGENT,
    },
    codex: {model: CODEX_QUOTA_MODEL, url: CODEX_USAGE_URL, userAgent: CODEX_USER_AGENT},
  };
}

// Release files. Secrets are passed in (resolved by hooks.ts) and land only in
// quota-alert.secrets.json, which prepareRelease makes 0400 for the sidecar uid.
export function quotaAlertFiles(c: Config, q: QuotaAlert, port: number, secrets: {managementKey: string; webhookUrl: string}): Record<string, string> {
  return {
    'quota-alert.ts': SOURCE,
    'quota-alert.json': JSON.stringify(quotaAlertConfig(c, q, port)) + '\n',
    'quota-alert.secrets.json': JSON.stringify({managementKey: secrets.managementKey, webhookUrl: checkWebhook(secrets.webhookUrl)}) + '\n',
  };
}

// The compose service, from a copy of the engine's safety baseline (labels,
// network, no-new-privileges, bounded logs, no published ports).
export function quotaAlertService(c: Config, q: QuotaAlert, base: Record<string, unknown>): Record<string, unknown> {
  return {
    ...base,
    image: q.image,
    container_name: quotaAlertContainer(c),
    user: QUOTA_ALERT_USER,
    read_only: true,
    cap_drop: ['ALL'],
    mem_limit: '128m',
    cpus: 0.1,
    pids_limit: 64,
    stop_grace_period: '10s',
    tmpfs: ['/tmp:rw,noexec,nosuid,nodev,size=8m,mode=1777'],
    environment: {TZ: 'UTC', HOME: '/tmp', BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0', DO_NOT_TRACK: '1'},
    entrypoint: ['/usr/local/bin/bun'],
    command: ['/opt/quota-alert/quota-alert.ts'],
    volumes: [
      './quota-alert.ts:/opt/quota-alert/quota-alert.ts:ro',
      './quota-alert.json:/etc/quota-alert/config.json:ro',
      './quota-alert.secrets.json:/run/secrets/quota-alert.json:ro',
      `${quotaAlertStateDir(c)}:/state`,
    ],
    healthcheck: {
      test: ['CMD', '/usr/local/bin/bun', '/opt/quota-alert/quota-alert.ts', '--health'],
      interval: '60s', timeout: '10s', retries: 3, start_period: '30s', start_interval: '2s',
    },
  };
}

// The program and its config are root-owned and world-readable inside the
// root-only release; the secrets file belongs to the sidecar uid alone.
export function quotaAlertPrepareRelease(release: string): string {
  const f = (name: string) => quote(`${release}/${name}`);
  return [
    `chown 0:0 ${f('quota-alert.ts')} ${f('quota-alert.json')} && chmod 0444 ${f('quota-alert.ts')} ${f('quota-alert.json')}`,
    `chown ${QUOTA_ALERT_USER} ${f('quota-alert.secrets.json')} && chmod 0400 ${f('quota-alert.secrets.json')}`,
  ].join('\n');
}

// 2server <= 0.2.32 ran this alert as a root systemd timer on the host. Every
// deploy (enabled or not) and removal deletes those units, the lock and the
// metrics file; the container replaces them.
const legacyCleanup = (c: Config) => {
  const unit = quotaAlertContainer(c), app = instanceName(c, 'cliproxy');
  return `if [ -e /etc/systemd/system/${unit}.timer ] || [ -e /etc/systemd/system/${unit}.service ]; then
  systemctl disable --now ${unit}.timer 2>/dev/null || true
  systemctl stop ${unit}.service 2>/dev/null || true
  rm -f /etc/systemd/system/${unit}.service /etc/systemd/system/${unit}.timer
  systemctl daemon-reload
fi
rm -f ${quote(`/opt/2server/metrics/${app}-quota-alert.prom`)} ${quote(`/var/lock/2server-${app}-quota-alert.lock`)}`;
};

// State directory owned by the sidecar uid. The sidecar can plant anything in
// it, so root only runs `chown -h` there (it never follows a link, even one
// swapped in after a check) and never reads what the directory holds.
export function quotaAlertPrepareHost(c: Config, q: QuotaAlert | undefined): string {
  if (!q) return legacyCleanup(c);
  const dir = quote(quotaAlertStateDir(c)), state = quote(`${quotaAlertStateDir(c)}/state.json`);
  return `${legacyCleanup(c)}
install -d -m 700 ${dir}
chown -h ${QUOTA_ALERT_USER} ${dir} && chmod 700 ${dir}
chown -h ${QUOTA_ALERT_USER} ${state} 2>/dev/null || true`;
}

export const quotaAlertTeardown = (c: Config) => legacyCleanup(c);
