import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appSchema, configSchema } from '../src/config';
import { resolveEnvMap, deployApp } from '../src/apps';
import { assertBindingsReady, assertExtensionUnused, bindingOperations, orderedExtensions, resolveBindings } from '../src/bindings';
import { statefulFiles } from '../src/stateful';
import { extensionFor } from '../src/extensions';
import { resourceCommand } from '../src/resources';

const base = { version: 1, name: 'server', ssh: { kind: 'ssh', host: 'host.example', user: 'operator' }, edge: { mode: 'managed' } };
const app = { name: 'api', image: `example/api@sha256:${'a'.repeat(64)}`, port: 8080, memoryMb: 128, cpus: 1 };
const redis = { passwordEnv: 'TEST_BINDING_PASSWORD' };
const ref = { REDIS_URL: { extension: 'redis', output: 'url' } };
const c = () => configSchema.parse({ ...base, extensions: { redis }, apps: [{ ...app, bindings: ref }] });
const remote = bindingOperations.remote;
const password = process.env.TEST_BINDING_PASSWORD;
afterEach(() => {
  bindingOperations.remote = remote;
  if (password === undefined) delete process.env.TEST_BINDING_PASSWORD;
  else process.env.TEST_BINDING_PASSWORD = password;
});

test('bindings remain references in persisted state; runtime URL encodes credentials', async () => {
  const config = c();
  const secret = 'p@ss:/?#%$literal-long-enough';
  process.env.TEST_BINDING_PASSWORD = secret;
  const env = await resolveEnvMap(config.apps[0], config);
  expect(env.REDIS_URL).toBe(`redis://default:${encodeURIComponent(secret)}@two-server-redis:6379`);
  expect(JSON.stringify(config)).not.toContain(secret);
  expect(JSON.stringify(config)).not.toContain(encodeURIComponent(secret));
  expect(config.apps[0].bindings).toEqual(ref);
  delete process.env.TEST_BINDING_PASSWORD;
  await expect(resolveEnvMap(config.apps[0], config)).rejects.toThrow('TEST_BINDING_PASSWORD');
  await expect(resolveEnvMap(config.apps[0])).rejects.toThrow('server config');
});

test('unknown providers, outputs and conflicting env sources fail validation', () => {
  expect(() => configSchema.parse({ ...base, apps: [{ ...app, bindings: ref }] })).toThrow('Missing binding extension');
  expect(() => configSchema.parse({ ...base, extensions: { redis }, apps: [{ ...app, bindings: { X: { extension: 'redis', output: 'typo' } } }] })).toThrow('Unknown output');
  for (const overlap of [{ env: { REDIS_URL: 'manual' } }, { secrets: { REDIS_URL: { provider: 'vm', key: 'URL' } } }, { instanceEnv: { REDIS_URL: 'manual' } }])
    expect(() => appSchema.parse({ ...app, bindings: ref, ...overlap })).toThrow();
  expect(() => appSchema.parse({ ...app, bindings: { REDIS_URL: { extension: 'redis', output: 'url', typo: true } } })).toThrow();
});

test('public aliases and least-privilege Postgres URL use stable runtime names', () => {
  process.env.TEST_BINDING_PASSWORD = 'long-password-for-binding';
  const config = configSchema.parse({ ...base, extensions: {
    postgres: { passwordEnv: 'TEST_BINDING_PASSWORD', username: 'reader', database: 'library' },
    imageProxy: { allowedSources: ['https://example.com/'], keyEnv: 'IMAGE_KEY', saltEnv: 'IMAGE_SALT' },
  } });
  expect(resolveBindings(config, { DATABASE_URL: { extension: 'postgres', output: 'appUrl' }, IMGPROXY_URL: { extension: 'image-proxy', output: 'endpoint' } })).toEqual({
    DATABASE_URL: 'postgresql://reader:long-password-for-binding@two-server-postgres:5432/library',
    IMGPROXY_URL: 'http://two-server-imgproxy:8080',
  });
});

test('service bindings order providers first, resolve in compose and reject cycles', async () => {
  process.env.TEST_BINDING_PASSWORD = 'long-password-for-binding';
  const config = configSchema.parse({ ...base, extensions: { redis, services: {
    worker: { image: 'example/worker:1', bindings: { API_URL: { extension: 'gateway', output: 'endpoint' }, ...ref } },
    gateway: { image: 'example/gateway:1', port: 8081 },
  } } });
  expect(orderedExtensions(config).map(e => e.name)).toEqual(['redis', 'gateway', 'worker']);
  const files = await statefulFiles(config, extensionFor(config, 'worker')!);
  const compose = JSON.parse(files['compose.json']);
  expect(compose.services['two-server-worker'].environment.API_URL).toBe('http://two-server-gateway:8081');
  expect(compose.services['two-server-worker'].environment.REDIS_URL).toContain('long-password-for-binding');
  expect(files['extension.json']).not.toContain('long-password-for-binding');
  const cyclic = { ...base, extensions: { services: {
    one: { image: 'example/one:1', port: 80, bindings: { URL: { extension: 'two', output: 'endpoint' } } },
    two: { image: 'example/two:1', port: 80, bindings: { URL: { extension: 'one', output: 'endpoint' } } },
  } } };
  expect(() => configSchema.parse(cyclic)).toThrow('cycle');
  expect(() => configSchema.parse({ ...base, extensions: { services: { 'image-proxy': { image: 'example/proxy:1' } } } })).toThrow('conflicts');
  expect(() => assertExtensionUnused(config, 'redis')).toThrow('Extension/worker');
});

test('readiness deduplicates providers and unhealthy dependency blocks app before deploy', async () => {
  let calls = 0;
  bindingOperations.remote = async (_c, script) => {
    calls++;
    expect(script.match(/docker inspect/g)).toHaveLength(1);
    expect(script).toContain('State.Running');
    expect(script).toContain('= healthy');
    expect(script).toContain("'two-server-redis'");
    throw new Error('dependency unhealthy');
  };
  await expect(assertBindingsReady(c(), { ...ref, OTHER_URL: ref.REDIS_URL })).rejects.toThrow('unhealthy');
  await expect(deployApp(c(), c().apps[0])).rejects.toThrow('unhealthy');
  expect(calls).toBe(2);
  await assertBindingsReady(c(), {});
  expect(calls).toBe(2);
});

test('delete refuses persisted consumers in both dry-run and apply before remote mutation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'extension-delete-'));
  const file = join(dir, 'server.json');
  try {
    await writeFile(file, JSON.stringify(c()));
    const before = await Bun.file(file).text();
    for (const apply of [[], ['--apply']])
      await expect(resourceCommand(['delete', 'extension', 'redis', '-f', file, ...apply])).rejects.toThrow('App/api');
    expect(await Bun.file(file).text()).toBe(before);
    const free = c(); free.apps = [];
    expect(() => assertExtensionUnused(free, 'redis')).not.toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('deploying a bound service selects only it and retains full provider context', async () => {
  const { deployExtension, extensionOperations } = await import('../src/deploy-extensions');
  const original = { ...extensionOperations };
  const config = configSchema.parse({ ...base, extensions: { redis, services: {
    worker: { image: 'example/worker:1', bindings: ref },
  } } });
  const calls: string[] = [];
  try {
    extensionOperations.preflightEdge = async () => { calls.push('preflight'); return ''; };
    extensionOperations.deploy = async (full, selected) => {
      calls.push('deploy');
      expect(full.extensions.redis?.passwordEnv).toBe('TEST_BINDING_PASSWORD');
      expect(selected!.map(e => e.name)).toEqual(['worker']);
    };
    await deployExtension(config, 'worker', 'unused');
    expect(calls).toEqual(['preflight', 'deploy']);
  } finally { Object.assign(extensionOperations, original); }
});
