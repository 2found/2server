import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileDefinition, loadDefinitions } from '../src/extensions/definition';
import { extensionRegistry, extensionSchemas } from '../src/extensions';
import { configSchema } from '../src/config';
import { statefulFiles } from '../src/stateful';
import { extensionTemplate } from '../src/templates';

const definition = {
  apiVersion: '2server.app/v1', kind: 'ExtensionDefinition', metadata: { name: 'thumbnailer' },
  runtime: { engine: 'service', defaults: {
    image: 'example/thumbnailer:1', port: 8080,
    healthCheck: { command: ['wget', '-qO-', 'http://localhost:8080/health'] },
    env: { MODE: 'safe' }, dataPath: '/opt/2server/data/thumbnailer',
  } },
  outputs: { endpoint: { type: 'endpoint', protocol: 'http', port: 8080 } },
};
const base = configSchema.parse({ version: 1, name: 'test', ssh: { kind: 'ssh', host: 'host.example', user: 'operator' }, edge: { mode: 'managed' } });

test('a YAML-only recipe reuses defaults, strict validation and the existing release engine', async () => {
  const ext = compileDefinition(definition, {});
  const spec = ext.schema.parse({ env: { EXTRA: 'literal-$value' } });
  expect(ext.schema.parse(undefined)).toBeUndefined();
  expect(spec).toMatchObject({ image: 'example/thumbnailer:1', memoryMb: 256, env: { MODE: 'safe', EXTRA: 'literal-$value' } });
  expect(() => ext.schema.parse({ typo: true })).toThrow();
  expect(() => ext.schema.parse({ memoryMb: -1 })).toThrow();
  for (const override of [{env: null}, {secrets: []}, {env: 'bad'}]) expect(() => ext.schema.parse(override)).toThrow();
  const config = { ...base, extensions: { ...base.extensions, thumbnailer: spec } };
  const files = await statefulFiles(config, ext);
  const service = JSON.parse(files['compose.json']).services['two-test-thumbnailer'];
  expect(service.environment).toEqual({ MODE: 'safe', EXTRA: 'literal-$$value' });
  expect(service.healthcheck.test).toEqual(['CMD', 'wget', '-qO-', 'http://localhost:8080/health']);
  expect(service.volumes).toEqual(['/opt/2server/data/thumbnailer:/data']);
  expect(service.ports).toBeUndefined();
  expect(service.security_opt).toEqual(['no-new-privileges:true']);
  expect(service.labels['io.2server.extension']).toBe('thumbnailer');
});

test('all builtins discover schemas, templates and outputs from YAML', () => {
  expect(extensionRegistry.map(e => e.cliName)).toEqual(['postgres', 'redis', 'nats', 'monitoring', 'image-proxy']);
  for (const ext of extensionRegistry) {
    expect(configSchema.shape.extensions.unwrap().unwrap().shape[ext.name as 'redis'] === extensionSchemas[ext.name]).toBe(true);
    expect(extensionTemplate(ext.cliName ?? ext.name).kind).toBe('Extension');
    expect(Object.keys(ext.outputs!)).not.toHaveLength(0);
  }
});

test('unknown hooks, executable fields, dual runtimes and duplicate aliases fail closed', async () => {
  expect(() => compileDefinition({ ...definition, hook: 'redis' }, {})).toThrow('exactly one');
  expect(() => compileDefinition({ ...definition, schema: {type:'object'} }, {})).toThrow('Native declaration fields');
  expect(() => compileDefinition({ ...definition, runtime: undefined, hook: 'untrusted' }, {})).toThrow('Unknown extension hook');
  expect(() => compileDefinition({ ...definition, install: 'curl example.com | sh' }, {})).toThrow();
  expect(() => compileDefinition({ ...definition, outputs: { endpoint: { type: 'endpoint', protocol: 'http', port: 8080, container: 'bad;exit' } } }, {})).toThrow();
  const dir = await mkdtemp(join(tmpdir(), 'definitions-'));
  try {
    await writeFile(join(dir, 'first.yaml'), Bun.YAML.stringify(definition));
    expect(loadDefinitions(dir, {}).map(e => e.name)).toEqual(['thumbnailer']);
    await writeFile(join(dir, 'second.yaml'), Bun.YAML.stringify({ ...definition, metadata: { name: 'other', key: 'thumbnailer' } }));
    expect(() => loadDefinitions(dir, {})).toThrow('Duplicate');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a new definition alone is accepted by a fresh CLI config and source parser', async () => {
  const { cp, symlink } = await import('node:fs/promises');
  const root = new URL('../', import.meta.url).pathname;
  const dir = await mkdtemp(join(tmpdir(), 'yaml-extension-cli-'));
  try {
    await cp(join(root, 'src'), join(dir, 'src'), { recursive: true });
    await symlink(join(root, 'node_modules'), join(dir, 'node_modules'));
    await writeFile(join(dir, 'src/extensions/thumbnailer.yaml'), Bun.YAML.stringify(definition));
    await writeFile(join(dir, 'src/extensions/cache-proxy.yaml'), Bun.YAML.stringify({
      ...definition, metadata: {name:'cache-proxy', key:'cacheProxy'},
      runtime: {...definition.runtime, defaults: {...definition.runtime.defaults, dataPath:'/opt/2server/data/cache-proxy'}},
    }));
    const proc = Bun.spawn([process.execPath, '-e', `
      import {configSchema} from './src/config';
      import {extensionTemplate} from './src/templates';
      import {extensionFor} from './src/extensions';
      import {parseResource, resourceCommand} from './src/resources';
      const doc=extensionTemplate('thumbnailer');
      const c=configSchema.parse({...${JSON.stringify(base)}, extensions:{thumbnailer:doc.spec}});
      if (!extensionFor(c,'thumbnailer') || c.extensions.thumbnailer.image !== 'example/thumbnailer:1') throw Error('Not registered');
      for (const verb of ['create','get','reload','delete']) {
        const request=parseResource([verb,'extension','cache-proxy','-f','manifest.json']);
        if (request?.name !== 'cacheProxy') throw Error('CLI alias not resolved for '+verb);
      }
      await Bun.write('manifest.json',JSON.stringify(c));
      await Bun.write('spec.json','{}');
      await resourceCommand(['create','extension','cache-proxy','-f','manifest.json','--spec','spec.json']);
      console.log('discovered');
    `], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
    const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(err).toBe(''); expect(code).toBe(0); expect(out.trim()).toBe('create extension cacheProxy: pass --apply to execute\ndiscovered');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('builtin YAML preserves migration guards, resource bounds and secret references', () => {
  const pg = extensionSchemas.postgres;
  const redis = extensionSchemas.redis;
  const nats = extensionSchemas.nats;
  for (const image of ['postgres:17', 'postgres:latest', 'other/postgres:18'])
    expect(() => pg.parse({passwordEnv:'PG_PASSWORD',image})).toThrow();
  for (const destination of ['gs://example-bucket/../data','gs://example-bucket/data/'])
    expect(() => pg.parse({passwordEnv:'PG_PASSWORD',backup:{destination}})).toThrow();
  for (const dataPath of ['/opt/../data','/opt/data;exit']) {
    expect(() => redis.parse({passwordEnv:'REDIS_PASSWORD',dataPath})).toThrow();
    expect(() => nats.parse({tokenEnv:'NATS_TOKEN',dataPath})).toThrow();
  }
  expect(() => redis.parse({passwordEnv:'bad-secret-name'})).toThrow();
  expect(() => nats.parse({tokenEnv:'NATS_TOKEN',maxMemoryMb:200})).toThrow('50%');
  expect(() => redis.parse({passwordEnv:'REDIS_PASSWORD',memoryMb:64})).toThrow('50%');
  expect(pg.parse({passwordEnv:'PG_PASSWORD',backup:{}})).toMatchObject({image:'postgres:18.6-bookworm',backup:{engine:'pgbackrest',fullIntervalHours:24}});
  expect(extensionSchemas.monitoring.parse(undefined)).toBe(false);
});

test('generated types match YAML and declaration references cannot evaluate expressions', async () => {
  const {extensionTypes} = await import('../scripts/gen-extension-types');
  const {renderDeclaration} = await import('../src/extensions/catalog');
  expect(extensionTypes()).toBe(await Bun.file(new URL('../src/extensions/specs.generated.ts',import.meta.url)).text());
  const input={volume:{$value:'spec.dataPath',suffix:':/data'},image:{$value:'spec.image'}};
  expect(renderDeclaration(input,{spec:{dataPath:'/opt/data',image:'example/app:1'}})).toEqual({volume:'/opt/data:/data',image:'example/app:1'});
  expect(()=>renderDeclaration({$value:'spec.missing'},{spec:{}})).toThrow('Missing');
  expect(()=>renderDeclaration({$value:'process.env.SECRET'},{})).toThrow('Invalid');
  expect(()=>renderDeclaration({$value:'spec.constructor'},{spec:{}})).toThrow('Missing');
  expect(()=>renderDeclaration({$value:'spec.image',eval:'anything'},{spec:{image:'x'}})).toThrow('Invalid');
});

test('monitoring contributions remain separate Prometheus rule groups', async () => {
  const {monitoringFiles} = await import('../src/extensions/monitoring/hooks');
  const c=configSchema.parse({...base,extensions:{monitoring:{zone:'example.com'}}});
  const rules=Bun.YAML.parse(monitoringFiles(c)['alerts.yml']) as {groups:Array<{name:string;rules:Array<{alert:string;expr:string}>}>};
  expect(rules.groups.map(g=>g.name)).toEqual(['host','postgres','runtime']);
  for(const group of rules.groups)for(const rule of group.rules) {
    expect(typeof rule.alert).toBe('string');expect(typeof rule.expr).toBe('string');
  }
});
