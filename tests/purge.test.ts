import { afterEach,expect,test } from 'bun:test';
import { chmod,mkdir,mkdtemp,readdir,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configSchema } from '../src/modules/config/application/config';
import { purgePlan,retainedHistoryScript,statefulPurgeScript } from '../src/modules/extensions/application/purge';
import { extensionFor } from '../src/modules/extensions/application/registry';
import { statefulFiles } from '../src/modules/extensions/application/stateful';
import { domainsRoutingTo,imageRepository,purgeDataPathIssue } from '../src/modules/extensions/domain/purge';
import { serviceSchema } from '../src/modules/extensions/domain/service';
import { sootOperations } from '../src/modules/extensions/infrastructure/templates/soot/deploy';
import { parseDocument } from '../src/modules/source/application/documents';
import { templateApp } from '../src/modules/source/application/templates';
import { run } from '../src/shared/infrastructure/process';
import { deleteVmSecrets,setVmSecrets,vmSecret } from '../src/shared/infrastructure/vm-secrets';
import { fixture } from './fixtures/soot/helpers';

const base = { version: 1, name: 'server', ssh: { kind: 'ssh', host: 'unused.example', user: 'operator' }, edge: { mode: 'managed' } };
const svc = { image: 'registry.example/soot-data@sha256:' + 'a'.repeat(64), port: 8080, dataPath: '/opt/2server/data/soot-data' };
const hardened = { ...svc, user: '65532:65532', readOnly: true, capDropAll: true, pidsLimit: 128 };
const original = { ...sootOperations }, dirs: string[] = [];
afterEach(async () => { Object.assign(sootOperations, original); setVmSecrets(); for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const compose = async (spec: Record<string, unknown>) => {
  const c = configSchema.parse({ ...base, extensions: { services: { 'soot-data': spec } } });
  return JSON.parse((await statefulFiles(c, extensionFor(c, 'soot-data')!))['compose.json']).services['two-server-soot-data'];
};

test('service hardening fields are strict, opt-in and map one-to-one onto Compose', async () => {
  expect(serviceSchema.parse(hardened)).toMatchObject({ user: '65532:65532', readOnly: true, capDropAll: true, pidsLimit: 128 });
  for (const bad of [{ user: 'nonroot' }, { user: '65532' }, { user: '0:0;id' }, { user: '-1:0' }, { pidsLimit: 4 }, { readOnly: 'yes' }, { hardened: true }])
    expect(() => serviceSchema.parse({ ...svc, ...bad })).toThrow();
  const legacy = await compose(svc);
  expect(legacy).toMatchObject({ user: '0:0', pids_limit: 256, volumes: ['/opt/2server/data/soot-data:/data'], security_opt: ['no-new-privileges:true'] });
  for (const key of ['read_only', 'tmpfs', 'cap_drop']) expect(legacy[key]).toBeUndefined();
  const ephemeral = await compose({ image: svc.image });
  expect(ephemeral.user).toBeUndefined();
  const strict = await compose(hardened);
  expect(strict).toMatchObject({ user: '65532:65532', read_only: true, tmpfs: ['/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777'],
    cap_drop: ['ALL'], pids_limit: 128, security_opt: ['no-new-privileges:true'], volumes: ['/opt/2server/data/soot-data:/data'] });
  expect((await compose({ image: svc.image, user: '1000:1000' })).user).toBe('1000:1000');
  expect(parseDocument({ apiVersion: '2server.app/v1', kind: 'Service', metadata: { name: 'soot-data' }, spec: hardened }).spec).toMatchObject(hardened);
  expect(() => parseDocument({ apiVersion: '2server.app/v1', kind: 'Service', metadata: { name: 'soot-data' }, spec: { ...hardened, user: 'nonroot' } })).toThrow();
});

test('a nonroot data owner is applied without following planted links and keeps the marker root-owned', () => {
  const c = configSchema.parse({ ...base, extensions: { services: { 'soot-data': hardened, plain: { ...svc, dataPath: '/srv/plain' } } } });
  const script = extensionFor(c, 'soot-data')!.stateful!.prepareHost!(c);
  expect(script).toContain("test -d '/opt/2server/data/soot-data' && test ! -L '/opt/2server/data/soot-data'");
  expect(script).toContain("find '/opt/2server/data/soot-data' -xdev ! -path '/opt/2server/data/soot-data/.2server-owner' \\( ! -user 65532 -o ! -group 65532 \\) -exec chown -h 65532:65532 {} +");
  expect(script).toContain("chown 0:0 '/opt/2server/data/soot-data/.2server-owner'");
  expect(script).not.toMatch(/chown -R|chown [^-]*-L/);
  expect(extensionFor(c, 'plain')!.stateful!.prepareHost!(c)).toBe('');
});

test('purge path, image and route rules refuse anything not provably owned', () => {
  for (const ok of ['/opt/2server/data/soot-data', '/srv/soot-data', '/opt/2server/search/data'])
    expect(purgeDataPathIssue(ok)).toBeUndefined();
  for (const bad of ['/opt/2server', '/opt/2server/', '/opt/2server/data', '/srv', '/srv/', '/var/lib/data', 'opt/2server/data/x',
    '/opt/2server/data/../control', '/opt/2server/data/./x', '/opt/2server//data/x', '/opt/2server/control/x', '/opt/2server/extensions/x',
    '/opt/2server/edge', '/opt/2server/backups/x', '/opt/2server/data/x/', "/srv/x'y"])
    expect(purgeDataPathIssue(bad)).toBeDefined();
  expect(imageRepository('getmeili/meilisearch:v1.54.3')).toBe('getmeili/meilisearch');
  expect(imageRepository('docker.io/library/redis:7@sha256:' + 'b'.repeat(64))).toBe('redis');
  expect(imageRepository('localhost:5000/team/app')).toBe('localhost:5000/team/app');
  expect(imageRepository(svc.image)).toBe('registry.example/soot-data');
  const c = configSchema.parse({ ...base, domains: [{ name: 'data', zone: 'example.com', hosts: ['data.example.com'],
    upstream: { kind: 'proxy', target: 'two-server-other:80' }, routes: [{ prefix: '/api', upstream: { kind: 'proxy', target: 'two-server-soot-data:8080' } }] }],
    extensions: { services: { 'soot-data': svc } } });
  expect(domainsRoutingTo(c, ['two-server-soot-data'])).toEqual(['data']);
  expect(domainsRoutingTo(c, ['two-server-soot'])).toEqual([]);
  expect(() => purgePlan(c, extensionFor(c, 'soot-data')!)).toThrow('Domain data still routes to soot-data');
});

test('purge plans cover only engines that cannot leave artifacts outside the instance root', () => {
  process.env.TEST_PURGE_PG = 'x'.repeat(24);
  const c = configSchema.parse({ ...base, extensions: { postgres: { passwordEnv: 'TEST_PURGE_PG' }, services: { 'soot-data': hardened, ephemeral: { image: 'example/e:1' } } } });
  expect(() => purgePlan(c, extensionFor(c, 'postgres')!)).toThrow('Purge is unsupported for postgres');
  expect(purgePlan(c, extensionFor(c, 'soot-data')!)).toEqual({ app: 'soot-data', containers: ['two-server-soot-data'], extensionRoot: '/opt/2server/extensions/soot-data',
    dataPath: '/opt/2server/data/soot-data', imageRepository: 'registry.example/soot-data', lock: '/var/lock/2server-extension-soot-data.lock', secrets: 'app-scoped VM secrets of soot-data' });
  expect(purgePlan(c, extensionFor(c, 'ephemeral')!).dataPath).toBeNull();
  const doc = parseDocument(templateApp('platform-search', 'meilisearch'));
  if (doc.kind !== 'Extension') throw new Error('fixture');
  const search = configSchema.parse({ ...base, extensionApps: { 'platform-search': { template: 'meilisearch', spec: doc.spec, secrets: doc.secrets } } });
  const meili = extensionFor(search, 'platform-search')!, meiliPlan = purgePlan(search, meili);
  expect(meiliPlan).toMatchObject({ containers: ['two-server-platform-search'], extensionRoot: '/opt/2server/extensions/platform-search',
    dataPath: '/opt/2server/data/platform-search', imageRepository: 'getmeili/meilisearch', secrets: 'app-scoped VM secrets of platform-search' });
  expect(statefulPurgeScript(search, meili, meiliPlan)).toContain(`= 'server:platform-search' ] || refuse`);
  const unsafe = configSchema.parse({ ...base, extensions: { services: { bad: { ...svc, dataPath: '/var/lib/bad' } } } });
  expect(() => purgePlan(unsafe, extensionFor(unsafe, 'bad')!)).toThrow('Refusing to purge dataPath /var/lib/bad');
  delete process.env.TEST_PURGE_PG;
});

test('rendered stateful purge checks lock, owner, container absence and marker before removing anything', () => {
  const c = configSchema.parse({ ...base, extensions: { services: { 'soot-data': hardened } } });
  const ext = extensionFor(c, 'soot-data')!, script = statefulPurgeScript(c, ext, purgePlan(c, ext));
  const at = (s: string) => { const i = script.indexOf(s); expect(i).toBeGreaterThanOrEqual(0); return i; };
  const lock = at('exec 7>/var/lock/2server-extension-soot-data.lock\nflock -w 120 7');
  const owner = at(`test "$(cat /opt/2server/edge/owner)" = 'server'`);
  const container = at(`if docker container inspect "$n" >/dev/null 2>&1; then refuse 'a container still exists'; fi`);
  at("--filter label=io.2server.owner=server --filter label=io.2server.app=soot-data");
  at("grep -RqsF -e 'two-server-soot-data:' /opt/2server/edge/current/sites/");
  at(`[ "$(jq -r '.dataPath // ""' "$root/current/extension.json")" = '/opt/2server/data/soot-data' ] || refuse`);
  at(`case "$data" in /opt/2server/?*|/srv/?*) ;; *) refuse 'unsafe data path';; esac`);
  at(`[ "$(readlink -f -- "$data")" = "$data" ]`);
  const marker = at(`[ "$(cat -- "$data/.2server-owner")" = 'server:soot-data' ] || refuse 'data path is owned by another workload'`);
  const remove = at('rm -rf --one-file-system -- "$root"');
  at('rm -rf --one-file-system -- "$data"');
  const images = at(`jq -r --arg repo 'registry.example/soot-data' 'select(.Repository == $repo)`);
  at('if docker image rm "$ref" >/dev/null 2>&1; then');
  const unlock = at('rm -f -- /var/lock/2server-extension-soot-data.lock');
  expect(lock < owner && owner < container && container < marker && marker < remove && remove < images && images < unlock).toBe(true);
  expect(script).not.toMatch(/docker (image )?rm(i)? -f|image rm --force|docker image prune|rm -rf \/(?!.*--)/);
  expect(retainedHistoryScript('soot-data', ['two-server-soot-data'])).toContain(`jq -e --arg app 'soot-data' '(.appSecrets // {}) | has($app)'`);
});

test('purge dry-run prints the plan, refuses unsupported targets and never calls SSH', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'two-purge-'));dirs.push(dir);
  const file = join(dir, 'server.json');
  const original = JSON.stringify(configSchema.parse({ ...base, apps: [{ name: 'api', image: `example/api@sha256:${'a'.repeat(64)}`, port: 80, memoryMb: 64, cpus: 1 }],
    extensions: { postgres: { passwordEnv: 'MISSING' }, services: { 'soot-data': hardened } } }));
  await Bun.write(file, original);
  const cli = async (...args: string[]) => {
    const p = Bun.spawn([process.execPath, '--no-env-file', fileURLToPath(new URL('../src/cli.ts', import.meta.url)), ...args, '-f', file],
      { env: { HOME: dir, PATH: dir }, stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { out, err, code };
  };
  for (const args of [['delete', 'app', 'soot-data', '--purge'], ['app', 'soot-data', 'delete', '--purge'], ['delete', 'extension', 'soot-data', '--purge']]) {
    const r = await cli(...args);
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' });
    expect(JSON.parse(r.out.slice(0, r.out.lastIndexOf('}') + 1)).purge).toMatchObject({ app: 'soot-data', dataPath: '/opt/2server/data/soot-data' });
    expect(r.out).toContain('pass --apply to execute');
  }
  for (const [args, message] of [[['delete', 'app', 'api', '--purge'], 'template apps and services'], [['delete', 'app', 'postgres', '--purge'], 'Purge is unsupported'],
    [['reload', 'app', 'soot-data', '--purge'], '--purge is not valid'], [['delete', 'app', 'soot-data', '--purge', '--purge'], 'Duplicate --purge']] as const) {
    const r = await cli(...args);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(message);
  }
  expect(await Bun.file(file).text()).toBe(original);
});

test('applied purge stops, purges on the VM, drops records and the manifest entry, and reports retained history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'two-purge-'));dirs.push(dir);
  const file = join(dir, 'server.json'), log = join(dir, 'ssh.log'), history = join(dir, '.local/state/2server/server/deployments');
  await Bun.write(file, JSON.stringify(configSchema.parse({ ...base, extensions: { services: { 'soot-data': hardened, keep: { image: 'example/keep:1' } } } })));
  await mkdir(history, { recursive: true });
  await writeFile(join(history, 'a.json'), JSON.stringify({ appliedAt: '2026-01-01T00:00:00Z', document: { kind: 'Service', metadata: { name: 'soot-data' } } }));
  await writeFile(join(history, 'b.json'), JSON.stringify({ appliedAt: '2026-01-01T00:00:00Z', document: { kind: 'Service', metadata: { name: 'keep' } } }));
  await writeFile(join(history, 'c.json'), JSON.stringify({ appliedAt: '2026-01-01T00:00:00Z', document: { kind: 'Domain', metadata: { name: 'soot-data' } } }));
  // Fake transport: records each remote script and answers with one JSON line.
  await writeFile(join(dir, 'ssh'), `#!/bin/sh\n/bin/cat >> '${log}'\nprintf '%s\\n' '----' >> '${log}'\nprintf '%s\\n' '{"ok":true}'\n`);
  await chmod(join(dir, 'ssh'), 0o755);
  const p = Bun.spawn([process.execPath, '--no-env-file', fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'app', 'soot-data', 'delete', '--purge', '--apply', '-f', file],
    { env: { HOME: dir, PATH: dir }, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  expect({ code, err }).toEqual({ code: 0, err: '' });
  const summary = JSON.parse(out);
  expect(summary).toMatchObject({ app: 'soot-data', purged: true, host: { ok: true }, retainedHistory: { ok: true },
    control: { secretKeys: 'unavailable without a connected session', deploymentRecords: 1 } });
  const scripts = (await Bun.file(log).text()).split('----\n').filter(Boolean);
  expect(scripts).toHaveLength(3);
  expect(scripts[0]).toContain('touch /opt/2server/extensions/soot-data/retired');
  expect(scripts[1]).toContain(`= 'server:soot-data' ] || refuse`);
  expect(scripts[2]).toContain('controlRevisionsWithSecrets');
  expect((await readdir(history)).sort()).toEqual(['b.json', 'c.json']);
  const saved = await Bun.file(file).json();
  expect(Object.keys(saved.extensions.services)).toEqual(['keep']);
});

test('purge removes an app secret namespace from the connected session only', () => {
  const session = { 'soot-data': { TOKEN: 'secret-value' }, keep: { TOKEN: 'other' } };
  expect(deleteVmSecrets('soot-data')).toBeUndefined();
  setVmSecrets(session);
  expect(deleteVmSecrets('soot-data')).toEqual(['TOKEN']);
  expect(session).toEqual({ keep: { TOKEN: 'other' } } as typeof session);
  expect(vmSecret('keep', 'TOKEN')).toBe('other');
});

test('soot purge reuses retire guards and hands the host only owned identity', async () => {
  const f = await fixture('assistant');dirs.push(f.dir);
  const ext = extensionFor(f.config, 'assistant')!;
  expect(purgePlan(f.config, ext)).toMatchObject({ containers: ['two-test-assistant'], extensionRoot: '/opt/2server/extensions/assistant', dataPath: '/opt/2server/data/assistant' });
  const calls: Record<string, unknown>[] = [];
  sootOperations.host = async (_c, q) => { calls.push(q); return { purged: true, container: 'removed', root: 'removed', data: 'removed', images: { removed: ['r@sha256:1'], in_use: [] }, lock: 'removed' }; };
  expect(await ext.purge!(f.config)).toEqual({ container: 'removed', extensionRoot: 'removed', dataPath: 'removed', images: { removed: ['r@sha256:1'], inUse: [] }, lock: 'removed' });
  expect(calls).toEqual([{ action: 'purge', image: f.bound.extensions.soot!.image }]);
  const routed = configSchema.parse({ ...f.config, domains: [{ name: 'assistant', zone: 'example.com', hosts: ['a.example.com'], upstream: { kind: 'proxy', target: 'two-test-assistant:7788' } }] });
  expect(() => purgePlan(routed, extensionFor(routed, 'assistant')!)).toThrow('still routes');
  await expect(extensionFor(routed, 'assistant')!.purge!(routed)).rejects.toThrow('Retire or reroute Soot domains');
  expect(calls).toHaveLength(1);
  setVmSecrets({});
  await expect(ext.purge!(f.config)).rejects.toThrow('Missing valid VM secret');
});

test('soot host purge joins the owner, removes owned roots and images, and refuses foreign data', async () => {
  const host = fileURLToPath(new URL('../src/modules/extensions/infrastructure/templates/soot/host.py', import.meta.url));
  const program = String.raw`
import importlib.util, json, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location('soot_host', ${JSON.stringify(host)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp).resolve()
    m.LOCKS = tmp
    root, data = tmp / 'extensions' / 'alpha', tmp / 'data' / 'alpha'
    q = {'root': str(root), 'data': str(data), 'server': 'server', 'instance': 'alpha', 'container': 'two-server-alpha',
         'owner': 'server:alpha:soot', 'network': 'edge', 'action': 'purge', 'image': 'registry.example/soot@sha256:' + 'a' * 64}
    for p in [root / 'config', root / 'transactions', root / 'credentials', root / 'releases' / 'r1', data]:
        p.mkdir(parents=True)
    (root / 'owner').write_text(q['owner'])
    (data / '.2server-owner').write_text(q['owner'])
    (root / 'credentials' / 'operator.env').write_text('TOKEN=x')
    (root / 'releases' / 'r1' / 'release.json').write_text(json.dumps({'image': 'registry.example/soot@sha256:' + 'b' * 64}))
    (tmp / '2server-extension-alpha.lock').write_text('')
    events, running = [], {'value': True}
    m.retirement_routes = lambda q: events.append('routes')
    m.container = lambda q: {'State': {'Running': running['value'], 'ExitCode': 0}}
    def stop_join(q):
        events.append('join'); running['value'] = False
    m.stop_join = stop_join
    m.release_meta = lambda q, p: json.loads((p / 'release.json').read_text())
    m.command = lambda argv, timeout=180: events.append(' '.join(argv)) or ''
    class Done:
        def __init__(self, code): self.returncode = code
    def docker(argv, **kw):
        events.append(' '.join(argv))
        return Done(1 if argv[-1].endswith('b' * 64) else 0)
    m.subprocess.run = docker
    result = m.mutate(q)
    assert events[:3] == ['routes', 'join', 'docker rm two-server-alpha'], events
    assert not root.exists() and not data.exists() and not (tmp / '2server-extension-alpha.lock').exists()
    assert result['images'] == {'removed': [q['image']], 'in_use': ['registry.example/soot@sha256:' + 'b' * 64]}, result
    assert result['root'] == 'removed' and result['data'] == 'removed' and result['container'] == 'removed'
    assert not any('-f' in e.split() or '--force' in e for e in events), events
    # Retry after a completed purge is a no-op; foreign data is never removed.
    events.clear()
    m.subprocess.run = lambda argv, **kw: Done(1)
    assert m.mutate(q)['root'] == 'absent'
    data.mkdir(parents=True)
    (data / '.2server-owner').write_text('server:other:soot')
    try:
        m.mutate(q)
        raise AssertionError('foreign data purged')
    except RuntimeError as e:
        assert str(e) == 'foreign_data'
    assert data.exists()
    # A published route blocks every removal.
    def routed(q): raise RuntimeError('published_route_uses_instance')
    m.retirement_routes = routed
    try:
        m.mutate(q)
        raise AssertionError('routed instance purged')
    except RuntimeError as e:
        assert str(e) == 'published_route_uses_instance'
    assert data.exists()
print('soot purge verified')
`;
  expect((await run(['python3', '-B', '-c', program])).trim()).toBe('soot purge verified');
});
