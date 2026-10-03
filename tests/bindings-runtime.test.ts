import { expect,test } from 'bun:test';
import { mkdir,mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '../src/modules/config/application/config';
import { assertBindingsReady,bindingOperations } from '../src/modules/extensions/application/bindings';
import { extensionFor } from '../src/modules/extensions/application/registry';
import { extensionProject,statefulFiles } from '../src/modules/extensions/application/stateful';
import { compileDefinition } from '../src/modules/extensions/infrastructure/definition';
import { run } from '../src/shared/infrastructure/process';
const integration = process.env.DOCKER_TESTS === '1' ? test : test.skip;

integration('real YAML service consumes authenticated Redis binding; stopped provider fails readiness', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'two-bindings-runtime-'));
  const name = `bindings-${crypto.randomUUID().slice(0, 8)}`, network = `two-${name}`;
  const previousSecret = process.env.TWO_BINDING_RUNTIME_PASSWORD;
  const previousRemote = bindingOperations.remote;
  process.env.TWO_BINDING_RUNTIME_PASSWORD = 'test-$literal:@/%?-long-secret';
  const c = configSchema.parse({ version: 1, name,
    ssh: { kind: 'ssh', host: 'unused.example', user: 'ops' }, edge: { mode: 'managed', network },
    extensions: { redis: { passwordEnv: 'TWO_BINDING_RUNTIME_PASSWORD', dataPath: join(dir, 'data') } },
  });
  const bindings = { REDIS_URL: { extension: 'redis', output: 'url' } };
  const check = 'test "$(redis-cli -u "$REDIS_URL" ping)" = PONG';
  const consumer = compileDefinition(Bun.YAML.parse(Bun.YAML.stringify({
    apiVersion: '2server.app/v1', kind: 'ExtensionDefinition', metadata: { name: 'binding-client' },
    runtime: { engine: 'service', defaults: { image: 'redis:8.2-alpine', bindings,
      command: ['sh', '-ec', `${check}; exec sleep 600`],
      healthCheck: { command: ['sh', '-ec', check], intervalSeconds: 1, startPeriodSeconds: 1 },
    } },
  })), {});
  const config = { ...c, extensions: { ...c.extensions, 'binding-client': consumer.schema.parse({}) } };
  const projects: Array<{ name: string; file: string }> = [];
  try {
    await run(['docker', 'network', 'create', network]);
    for (const ext of [extensionFor(config, 'redis')!, consumer]) {
      const release = join(dir, ext.name); await mkdir(release);
      const files = await statefulFiles(config, ext);
      if (ext.name === 'redis') {
        // Redis chowns its data directory. A bind mount would leave root/Redis-
        // owned files on a Linux runner, preventing the test user from cleanup.
        const compose = JSON.parse(files['compose.json']);
        compose.volumes = {data: {}};
        compose.services[extensionProject(config, ext.name)].volumes[0] = 'data:/data';
        files['compose.json'] = JSON.stringify(compose);
      }
      for (const [file, body] of Object.entries(files)) await writeFile(join(release, file), body, { mode: 0o600 });
      const project = { name: extensionProject(config, ext.name), file: join(release, 'compose.json') };
      projects.push(project);
      try {
        await run(['docker', 'compose', '-p', project.name, '-f', project.file, 'up', '-d', '--wait', '--wait-timeout', '40']);
      } catch (error) {
        const logs = await run(['bash', '-c', 'docker logs "$1" 2>&1', '--', project.name]).catch(() => 'no container logs');
        throw new Error(`${ext.name} failed readiness: ${logs.replaceAll(process.env.TWO_BINDING_RUNTIME_PASSWORD!, '<test-secret>')}`, { cause: error });
      }
    }
    bindingOperations.remote = async (_config, script) => run(['bash', '-c', script]);
    await assertBindingsReady(config, bindings);
    expect((await run(['docker', 'exec', extensionProject(config, consumer.name), 'sh', '-ec', 'redis-cli -u "$REDIS_URL" ping'])).trim()).toBe('PONG');
    await run(['docker', 'stop', extensionProject(config, 'redis')]);
    await expect(assertBindingsReady(config, bindings)).rejects.toThrow('bash failed');
  } finally {
    bindingOperations.remote = previousRemote;
    if (previousSecret === undefined) delete process.env.TWO_BINDING_RUNTIME_PASSWORD;
    else process.env.TWO_BINDING_RUNTIME_PASSWORD = previousSecret;
    for (const p of projects.reverse()) await run(['docker', 'compose', '-p', p.name, '-f', p.file, 'down', '--volumes', '--timeout', '1']).catch(() => {});
    await run(['docker', 'network', 'rm', network]).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}, 90000);
