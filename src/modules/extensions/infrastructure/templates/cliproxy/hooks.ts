import { quote } from '../../../../../shared/infrastructure/process';
import type { Config } from '../../../../config/application/config';
import { extensionProject,requiredSecret } from '../../../application/stateful';
import type { ExtensionSpecs } from '../../../domain/specs.generated';
import type { ExtensionHooks } from '../../../domain/types';
import { serviceDataOwnership } from '../../service';

// Matches `service.user` in extension.yaml.
export const CLIPROXY_USER = '65532:65532';
export const CLIPROXY_PORT = 8317;
type Spec = NonNullable<ExtensionSpecs['cliproxy']>;

// Keys travel through curl config files and a bcrypt hash; one charset keeps
// both free of quoting. bcrypt reads at most 72 bytes of the management key.
const SAFE_KEY = /^[A-Za-z0-9_.:+/=-]+$/;
export function clientKey(c: Config, env: string): string {
  const value = requiredSecret(env, c);
  if (!SAFE_KEY.test(value) || value.length > 256)
    throw new Error(`${env} must be 20-256 characters of letters, digits and _.:+/=-`);
  return value;
}
export function managementKey(c: Config): string {
  const env = c.extensions.cliproxy!.managementKeyEnv, value = requiredSecret(env, c);
  if (!SAFE_KEY.test(value) || value.length > 72)
    throw new Error(`${env} must be 20-72 characters of letters, digits and _.:+/=-`);
  return value;
}
export const cliproxyContainer = (c: Config) => extensionProject(c, 'cliproxy');

function byChannel<T extends {channel: string}, V>(items: T[], value: (item: T) => V): Record<string, V[]> {
  const out: Record<string, V[]> = {};
  for (const item of items) (out[item.channel] ??= []).push(value(item));
  return out;
}

// The whole runtime configuration, owned by the App spec. JSON is valid YAML,
// so values never need YAML escaping. The official CLIProxyAPI Management
// Center (`management.html`) is stored in `/data/static` and gated alongside
// `/v0|/v8/management/*` by the bcrypt-hashed management key; file logs,
// request logs, usage aggregation and plugins stay off. Cooldowns are saved
// beside the accounts: a deploy restarts the runtime, and without them it
// would retry every account whose quota is already spent.
export function cliproxyConfig(spec: Spec, clientKeys: string[], managementHash: string) {
  return {
    'config-version': 8,
    server: {
      host: '',
      port: CLIPROXY_PORT,
      'commercial-mode': true,
      'max-request-body-bytes': spec.maxRequestBodyMb * 1024 * 1024,
      'trusted-proxies': ['127.0.0.1', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
    },
    management: {'allow-remote': true, 'secret-key': managementHash, 'disable-control-panel': false, 'disable-auto-update-panel': false},
    access: {'api-keys': clientKeys},
    routing: {strategy: spec.routing, retry: {'request-retry': spec.requestRetry, 'max-retry-interval': spec.maxRetryIntervalSeconds},
      cooldown: {'save-cooldown-status': true}},
    requests: {streaming: {'keepalive-seconds': spec.streamKeepaliveSeconds, 'bootstrap-retries': spec.streamBootstrapRetries}},
    oauth: {
      'auth-dir': '/data/auths',
      'model-alias': byChannel(spec.models, m => ({name: m.name, alias: m.alias, ...(m.fork ? {fork: true} : {})})),
      'excluded-models': byChannel(spec.excludedModels, m => m.pattern),
    },
    observability: {
      logs: {debug: false, 'logging-to-file': false, 'request-log': false},
      usage: {'usage-statistics-enabled': false},
    },
    plugins: {enabled: false},
  };
}

export const cliproxyHooks = {
  refineSpec(value, ctx) {
    const spec = value as Spec;
    if (spec.clientKeyEnv.includes(spec.managementKeyEnv))
      ctx.addIssue({code: 'custom', message: 'managementKeyEnv must not be one of clientKeyEnv'});
    const seen = new Set<string>();
    for (const m of spec.models) {
      const key = `${m.channel}\0${m.alias}`;
      if (seen.has(key)) ctx.addIssue({code: 'custom', message: `Model alias ${m.alias} is declared twice for ${m.channel}; one alias resolves to one model per channel`});
      seen.add(key);
    }
  },
  stateful: {
    async files(c, files, service) {
      const spec = c.extensions.cliproxy!;
      const keys = spec.clientKeyEnv.map(env => clientKey(c, env)), management = managementKey(c);
      if (new Set(keys).size !== keys.length) throw new Error('Each clientKeyEnv secret needs its own value');
      if (keys.includes(management)) throw new Error('The management key must differ from every client key');
      // Only a bcrypt hash reaches the container; the key stays in VM secrets.
      const hash = await Bun.password.hash(management, {algorithm: 'bcrypt', cost: 10});
      files['config.yaml'] = JSON.stringify(cliproxyConfig(spec, keys, hash), null, 1) + '\n';
      // Root-only readiness probe: proves the config loaded and a client key is
      // accepted. Never mounted into the container.
      files['verify.conf'] = [
        'silent', 'show-error', 'fail', 'max-time = 5', 'output = "/dev/null"',
        `url = "http://127.0.0.1:${CLIPROXY_PORT}/v1/models"`,
        `header = ${JSON.stringify('Authorization: Bearer ' + keys[0])}`,
      ].join('\n') + '\n';
      // Go reads the cgroup CPU quota itself; it does not read the memory limit.
      service.environment = {
        TZ: 'UTC',
        HOME: '/data',
        WRITABLE_PATH: '/data',
        MANAGEMENT_STATIC_PATH: '/data/static',
        GOMEMLIMIT: `${Math.floor(spec.memoryMb * 0.8)}MiB`,
      };
    },
    prepareHost: c => {
      const dataPath = c.extensions.cliproxy!.dataPath;
      const auths = quote(dataPath + '/auths'), staticDir = quote(dataPath + '/static');
      return [
        serviceDataOwnership({user: CLIPROXY_USER, dataPath}),
        `mkdir -p ${auths} ${staticDir}`,
        `chown -h ${CLIPROXY_USER} ${auths} ${staticDir}`,
        `chmod 0700 ${auths} ${staticDir}`,
      ].join('\n');
    },
    prepareRelease: (_c, release) => [
      `chown ${CLIPROXY_USER} ${quote(release + '/config.yaml')} && chmod 0400 ${quote(release + '/config.yaml')}`,
      `chown 0:0 ${quote(release + '/verify.conf')} && chmod 0400 ${quote(release + '/verify.conf')}`,
    ].join('\n'),
    // The image has no HTTP client, so the host's curl runs inside the
    // container's network namespace; verify.conf sits beside the mounted config.
    verify: c => {
      const container = quote(cliproxyContainer(c));
      return `cliproxy_pid=$(docker inspect -f '{{.State.Pid}}' ${container})
cliproxy_release=$(dirname "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/run/secrets/config.yaml"}}{{.Source}}{{end}}{{end}}' ${container})")
nsenter -t "$cliproxy_pid" -n curl --config "$cliproxy_release/verify.conf"`;
    },
  },
} satisfies ExtensionHooks;
