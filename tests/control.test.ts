import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { controlCommand, connectedCommand, controlOperations, secretKeys, selectSecrets, findConnection, saveConnection } from '../src/control';
import { configSchema, readConfig } from '../src/config';
import { operatorState } from '../src/operator-state';
import { run } from '../src/process';

const original = {...controlOperations};
let dir: string, vm: string, manifest: string;
let savedToken: string | undefined;
const base = await Bun.file(new URL('../examples/server.json', import.meta.url)).json();
const conn = ['--ssh', 'operator@vm.example'];
async function snapshot() { return JSON.parse(await readFile(join(vm, 'control/current/snapshot.json'), 'utf8')); }
async function publish() { await controlCommand(['server', 'publish', '-f', manifest, '--apply']); }
beforeEach(async () => {
  savedToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_API_TOKEN = 'test-only-control-token';
  dir = await mkdtemp(join(tmpdir(), 'two-control-test-'));
  vm = join(dir, 'vm');
  await mkdir(vm);
  manifest = join(dir, 'server.json');
  const c = configSchema.parse({...base, name: 'control-test', apps: [], domains: [], extensions: {monitoring: false}, ssh: {kind:'ssh', host:'vm.example', user:'operator', identityFile:'/machine-a/key'}});
  await Bun.write(manifest, JSON.stringify(c));
  controlOperations.remote = async (_c, script) => run(['bash', '-se'], script.replace('test \"$(id -u)\" = 0', `test \"$(id -u)\" = ${process.getuid!()}`).replaceAll('/opt/2server', vm).replaceAll('mv -Tf', process.platform === 'darwin' ? 'gmv -Tf' : 'mv -Tf'));
  controlOperations.upload = async (_c, files, target) => {
    target = target.replace('/opt/2server', vm);
    await mkdir(target, {recursive:true, mode:0o700});
    for (const [path, value] of Object.entries(files)) { await Bun.write(join(target,path),value); }
  };
});
afterEach(async () => {
  if (savedToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
  else process.env.CLOUDFLARE_API_TOKEN = savedToken;
  Object.assign(controlOperations, original);
  await rm(dir, {recursive:true, force:true});
});

describe('VM control state, real atomic filesystem scripts', () => {
  test('fresh machine needs only SSH; remote env wins, CRUD persists and session is removed', async () => {
    const old = process.env.CLOUDFLARE_API_TOKEN;
    try {
      process.env.CLOUDFLARE_API_TOKEN = 'machine-a-secret-$literal';
      await publish();
      expect((await snapshot()).config.ssh.identityFile).toBeUndefined();
      process.env.CLOUDFLARE_API_TOKEN = 'stale-machine-b';
      let session = '';
      await connectedCommand(['get','app',...conn], async args => {
        session = args.at(-1)!;
        expect((await readConfig(session)).ssh).toEqual({kind:'ssh',host:'vm.example',user:'operator',port:22});
        expect(process.env.CLOUDFLARE_API_TOKEN).toBe('machine-a-secret-$literal');
      });
      expect(await Bun.file(session).exists()).toBe(false);
      expect(process.env.CLOUDFLARE_API_TOKEN).toBe('stale-machine-b');
      const revision = (await snapshot()).revision;
      await connectedCommand(['deploy','--apply',...conn], async args => {
        const path = args[1];
        const c = await readConfig(path);
        c.originIp = '203.0.113.12';
        await Bun.write(path, JSON.stringify(c));
        await mkdir(join(operatorState(c.name), 'certificates/site'), {recursive:true});
        await Bun.write(join(operatorState(c.name),'certificates/site/pair.json'), '{"private":"cert-state"}');
      });
      const saved = await snapshot();
      expect(saved.config.originIp).toBe('203.0.113.12');
      expect(saved.state['certificates/site/pair.json']).toContain('cert-state');
      expect(saved.revision).not.toBe(revision);
      await connectedCommand(['validate',...conn], async args => {
        expect(await Bun.file(join(operatorState('control-test'),'certificates/site/pair.json')).text()).toContain('cert-state');
        expect((await readConfig(args[1])).originIp).toBe('203.0.113.12');
      });
      expect((await stat(join(vm,'control'))).mode & 0o777).toBe(0o700);
      expect((await stat(join(vm,'control/current/.env'))).mode & 0o777).toBe(0o600);
    } finally { if (old === undefined) delete process.env.CLOUDFLARE_API_TOKEN; else process.env.CLOUDFLARE_API_TOKEN = old; }
  });
  test('dry run, duplicate publication, missing VM and ownership mismatch preserve current state', async () => {
    await expect(connectedCommand(['get','app',...conn], async () => {})).rejects.toThrow('Cannot read VM control config');
    await publish();
    const before = await snapshot();
    await connectedCommand(['reload','app','app',...conn], async () => {});
    expect(await snapshot()).toEqual(before);
    await expect(publish()).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    await mkdir(join(vm,'edge'));
    await Bun.write(join(vm,'edge/owner'), 'other-server');
    await expect(connectedCommand(['get','app',...conn], async () => {})).rejects.toThrow('ownership');
    expect(await snapshot()).toEqual(before);
  });
  test('two operators cannot race; failed apply still saves issued certificate state', async () => {
    await publish();
    await connectedCommand(['deploy','--apply',...conn], async () => {
      await expect(connectedCommand(['get','app',...conn], async () => {})).rejects.toThrow('control lock');
    });
    await expect(connectedCommand(['domains','--apply',...conn], async () => {
      const state = operatorState('control-test');
      await mkdir(join(state,'certificates/site'),{recursive:true});
      await Bun.write(join(state,'certificates/site/pair.json'),'issued-before-DNS-failure');
      throw new Error('DNS failure');
    })).rejects.toThrow('DNS failure');
    expect((await snapshot()).state['certificates/site/pair.json']).toBe('issued-before-DNS-failure');
    // A failed operation releases its own lock and the next operator can resume.
    await connectedCommand(['get','app',...conn], async () => {});
  });
  test('secrets are explicit references; no shell interpolation or local fallback', async () => {
    await publish();
    const env = join(dir, 'secrets.env');
    await Bun.write(env, 'CLOUDFLARE_API_TOKEN="literal-$TOKEN-$(touch /tmp/never)"\n');
    await connectedCommand(['server','env',...conn,'--env-file',env,'--apply'], async () => { throw new Error('unexpected dispatch'); });
    expect((await snapshot()).env.CLOUDFLARE_API_TOKEN).toBe('literal-$TOKEN-$(touch /tmp/never)');
    await Bun.write(env, 'PATH=/evil\n');
    await expect(connectedCommand(['server','env',...conn,'--env-file',env,'--apply'], async () => {})).rejects.toThrow('not referenced');
    const c = await readConfig(manifest);
    expect(selectSecrets(c,{CLOUDFLARE_API_TOKEN:'ok',PATH:'/evil',UNRELATED:'private'})).toEqual({CLOUDFLARE_API_TOKEN:'ok'});
    c.cloudflare.tokenEnv = 'PATH';
    expect(() => secretKeys(c)).toThrow('override process');
  });
  test('untrusted snapshots reject path traversal and never print values', async () => {
    await publish();
    const saved = await snapshot();
    saved.state['../escape'] = 'secret-do-not-log';
    await Bun.write(join(vm,'control/current/snapshot.json'),JSON.stringify(saved));
    await expect(connectedCommand(['get','app',...conn], async () => {})).rejects.toThrow('Invalid server control snapshot; no values logged');
  });
  test('lost commit retains private recovery, current snapshot stays intact', async () => {
    await publish();
    const old = await snapshot();
    const remote = controlOperations.remote;
    controlOperations.remote = async (c, script) => {
      if (script.includes('ln -s revisions/')) throw new Error('connection lost');
      return remote(c, script);
    };
    let recovery = '';
    try {
      await connectedCommand(['deploy','--apply',...conn], async () => {});
    } catch (e) { recovery = (e as Error).message.match(/retained at ([^;]+);/)?.[1] ?? ''; }
    expect(recovery).not.toBe('');
    expect((await stat(recovery)).mode & 0o777).toBe(0o700);
    expect(await Bun.file(join(recovery,'recovery-snapshot.json')).exists()).toBe(true);
    expect(await snapshot()).toEqual(old);
    await rm(recovery,{recursive:true,force:true});
  });
});

// Real age encryption/decryption; no production key or secret is used.
const ageTest = Bun.which('age') && Bun.which('age-keygen') ? test : test.skip;
ageTest('encrypted off-VM recovery round trip, wrong key and populated target rejection', async () => {
  await publish();
  const key = join(dir,'identity.txt');
  await run(['age-keygen','-o',key]);
  const recipient = join(dir,'recipients.txt');
  await Bun.write(recipient, await run(['age-keygen','-y',key]));
  const archive = join(dir,'.2server','backup.age');
  await connectedCommand(['server','backup',...conn,'--output',archive,'--recipient-file',recipient], async () => {});
  expect((await Bun.file(join(dir,'.2server/.gitignore')).text()).trim()).toBe('*');
  expect(await Bun.file(archive).text()).toStartWith('-----BEGIN AGE ENCRYPTED FILE-----');
  expect(await Bun.file(archive).text()).not.toContain('cloudflare');
  const before = await snapshot();
  await expect(controlCommand(['server','restore','-f',manifest,'--backup',archive,'--backup-identity',key,'--apply'])).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
  await rm(join(vm,'control'),{recursive:true});
  const wrong = join(dir,'wrong-key');
  await run(['age-keygen','-o',wrong]);
  await expect(controlCommand(['server','restore','-f',manifest,'--backup',archive,'--backup-identity',wrong,'--apply'])).rejects.toThrow('age failed');
  await controlCommand(['server','restore','-f',manifest,'--backup',archive,'--backup-identity',key,'--apply']);
  const restored = await snapshot();
  expect(restored.config).toEqual(before.config);
  expect(restored.env).toEqual(before.env);
  expect(restored.state).toEqual(before.state);
});

test('project connection is private, gitignored and discoverable from nested directories', async () => {
  const project = join(dir, 'project');
  await mkdir(join(project,'app'),{recursive:true});
  await run(['git','init','--quiet',project]);
  const c = await readConfig(manifest);
  await saveConnection(c.ssh,join(project,'.2server'));
  const file = await findConnection(join(project,'app'));
  expect(file).toBe(join(project,'.2server/connection.json'));
  expect((await stat(file!)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await Bun.file(file!).text())).toEqual(c.ssh);
  expect(await run(['git','-C',project,'check-ignore','.2server/connection.json'])).toContain('connection.json');
  expect(await run(['git','-C',project,'status','--porcelain'])).toBe('');
});

test('control reads refuse writable and symlinked directories', async () => {
  await publish();
  await chmod(join(vm,'control'),0o777);
  await expect(connectedCommand(['get','app',...conn], async () => {})).rejects.toThrow('root ownership and permissions');
  await chmod(join(vm,'control'),0o700);
  await connectedCommand(['get','app',...conn], async () => {});
  await rm(join(vm,'control'),{recursive:true});
  const elsewhere = join(dir,'elsewhere');
  await mkdir(elsewhere);
  await symlink(elsewhere,join(vm,'control'));
  await expect(publish()).rejects.toThrow('control lock');
  expect(await Bun.file(join(elsewhere,'current/snapshot.json')).exists()).toBe(false);
});

test('actual CLI discovers project connection under a different operator username', async () => {
  await publish();
  const project = join(dir,'machine-b');
  await mkdir(join(project,'bin'),{recursive:true});
  await saveConnection({kind:'ssh',host:'vm.example',user:'second-operator',port:22},join(project,'.2server'));
  const fakeSsh = join(project,'bin/ssh');
  await Bun.write(fakeSsh, `#!${process.execPath}
const script = (await Bun.stdin.text()).replace('test "$(id -u)" = 0', 'test "$(id -u)" = ${process.getuid!()}').replaceAll('/opt/2server', ${JSON.stringify(vm)}).replaceAll('mv -Tf', ${JSON.stringify(process.platform === 'darwin' ? 'gmv -Tf' : 'mv -Tf')});
if (!process.argv.includes('second-operator@vm.example')) process.exit(9);
const p = Bun.spawn(['bash','-se'], {stdin:new Blob([script]),stdout:'inherit',stderr:'inherit'});
process.exit(await p.exited);
`);
  await chmod(fakeSsh,0o700);
  const cli = new URL('../src/cli.ts',import.meta.url).pathname;
  for (const args of [['get','app'],['validate'],['deploy','--apply=false']]) {
    const p = Bun.spawn([process.execPath,'--no-env-file',cli,...args],{
      cwd:project, env:{...process.env,PATH:`${join(project,'bin')}:${process.env.PATH}`}, stdout:'pipe',stderr:'pipe',
    });
    const [code,out,err] = await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);
    if (args[0] === 'deploy') { expect(code).toBe(1); expect(err).toContain('optional --apply'); }
    else { expect(code).toBe(0); expect(err).toBe(''); expect(out).toContain(args[0] === 'get' ? '[]' : 'Valid manifest: control-test'); }
  }
});
