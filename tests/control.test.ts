import { afterEach,beforeEach,describe,expect,test } from 'bun:test';
import { chmod,mkdir,mkdtemp,readFile,readdir,rename,rm,stat,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '../src/modules/config/application/config';
import { readConfig } from '../src/modules/config/infrastructure/file';
import { controlOperations } from '../src/modules/control/application/operations';
import { acquire,release } from '../src/modules/control/application/snapshot';
import { fileCommand,fileOperations } from '../src/modules/source/cli/command';
import { connectedCommand,mutatesControl } from '../src/modules/control/application/session';
import { controlCommand } from '../src/modules/control/cli/command';
import { secretKeys,selectSecrets } from '../src/modules/control/domain/secrets';
import { findConnection,saveConnection } from '../src/modules/control/infrastructure/files';
import { controlLockScript } from '../src/modules/control/infrastructure/lock';
import { operatorState } from '../src/shared/infrastructure/operator-state';
import { run } from '../src/shared/infrastructure/process';

const original = {...controlOperations};
let dir: string, vm: string, manifest: string;
let savedToken: string | undefined;
const base = await Bun.file(new URL('../examples/server.json', import.meta.url)).json();
const conn = ['--ssh', 'operator@vm.example'];
async function snapshot() { return JSON.parse(await readFile(join(vm, 'control/current/snapshot.json'), 'utf8')); }
async function concurrentCommit(value:any) {
  value.revision=crypto.randomUUID();
  const target=join(vm,'control/revisions',value.revision);
  await mkdir(target,{mode:0o700});
  await Bun.write(join(target,'snapshot.json'),JSON.stringify(value),{mode:0o600});
  await chmod(join(target,'snapshot.json'),0o600);
  const pointer=join(vm,'control',`test-${value.revision}`);
  await symlink(`revisions/${value.revision}`,pointer);
  await rename(pointer,join(vm,'control/current'));
}
async function publish() { await controlCommand(['server', 'publish', '-f', manifest, '--apply']); }
async function lockStatus() {
  const c = await readConfig(manifest);
  return JSON.parse(await controlOperations.remote(c, controlLockScript(c, 'inspect')));
}
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
      await expect(connectedCommand(['deploy','--apply',...conn], async () => {})).rejects.toThrow('control lock');
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
  const futureSecrets = join(dir,'future.env');
  await Bun.write(futureSecrets, 'REDIS_PASSWORD=kept-for-next-source-revision\n');
  await connectedCommand(['secret','set',...conn,'--env-file',futureSecrets,'--apply'], async () => {});
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
  expect(file).toBe(join(project,'.2server/connection.yaml'));
  expect((await stat(file!)).mode & 0o777).toBe(0o600);
  expect(Bun.YAML.parse(await Bun.file(file!).text())).toEqual(c.ssh);
  expect(await run(['git','-C',project,'check-ignore','.2server/connection.yaml'])).toContain('connection.yaml');
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
  await mkdir(join(vm,'control/lock'));
  await Bun.write(join(vm,'control/lock/token'),'other-operator');
  const before = await snapshot();
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
  for (const args of [['get','app'],['app','get','--apply'],['describe','apps'],['validate'],['server','lock'],['deploy'],['deploy','--apply=false']]) {
    const p = Bun.spawn([process.execPath,'--no-env-file',cli,...args],{
      cwd:project, env:{...process.env,PATH:`${join(project,'bin')}:${process.env.PATH}`}, stdout:'pipe',stderr:'pipe',
    });
    const [code,out,err] = await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);
    if (args.includes('--apply=false')) { expect(code).toBe(1); expect(err).toContain('optional --apply'); }
    else { expect(code).toBe(0); expect(err).toBe(''); expect(out).toContain(args[0] === 'validate' ? 'Valid manifest: control-test' : args[0] === 'deploy' ? 'Pass --apply' : args[0] === 'server' ? '"locked": true' : '[]'); }
  }
  expect(await snapshot()).toEqual(before);
  expect(await Bun.file(join(vm,'control/lock/token')).text()).toBe('other-operator');
});

test('reads and dry runs neither touch a held lock nor persist revisions/history', async () => {
  await publish();
  const before = await snapshot();
  const revisions = await readdir(join(vm,'control/revisions'));
  await mkdir(join(vm,'control/lock'));
  await Bun.write(join(vm,'control/lock/token'),'other-operator');
  const calls: string[] = [];
  const remote = controlOperations.remote;
  controlOperations.remote = async (c, script) => { calls.push(script); return remote(c, script); };
  controlOperations.upload = async () => { throw new Error('Reads must not upload'); };
  controlOperations.run = async () => 'encrypted-test-snapshot';
  const noDispatch = async () => { throw new Error('Unexpected dispatch'); };
  for (const args of [
    ['get','app'], ['app','get','--apply'], ['describe','apps'], ['get-log','app','api'],
    ['logs','extension','redis','--apply'], ['validate'], ['status'], ['verify'], ['plan','--apply'],
    ['deploy'], ['scale','app','api','--replicas','2'], ['file-action'],
  ]) {
    let invoked = false;
    await connectedCommand([...args,...conn], async () => { invoked = true; });
    expect(invoked).toBe(true);
  }
  await connectedCommand(['secret','list',...conn],noDispatch);
  await connectedCommand(['server','config','--output',join(dir,'export.json'),...conn],noDispatch);
  await connectedCommand(['server','backup','--output',join(dir,'backup.age'),'--recipient-file','test',...conn],noDispatch);
  await expect(connectedCommand(['get','app',...conn],async()=>{throw new Error('read failed');})).rejects.toThrow('read failed');
  expect(calls.every(script=>!script.includes('/control/lock'))).toBe(true);
  expect(await snapshot()).toEqual(before);
  expect(await readdir(join(vm,'control/revisions'))).toEqual(revisions);
  expect(await Bun.file(join(vm,'control/lock/token')).text()).toBe('other-operator');
  for (const args of [['deploy','--apply'],['app','reload','api','--apply'],['secret','set','--apply'],['file-action','--apply']]) {
    await expect(connectedCommand([...args,...conn],noDispatch)).rejects.toThrow('control lock');
  }
  await connectedCommand(['file-action',...conn],async()=>{}); // Even image-tag plans need no control lock.
});

test('mutation policy covers aliases, special commands and check-backup restore drills', () => {
  for (const args of [['app','get'],['describe','services'],['get-log','pod'],['extensions','logs'],['plan'],['verify'],['server','config'],['server','backup'],['secret','list']]) {
    expect(mutatesControl([...args,'--apply'])).toBe(false);
  }
  for (const args of [['deploy'],['domains'],['setup'],['extensions'],['apps','reload'],['test','webhook'],['check-backup','postgres'],['backup','postgres'],['restore','postgres'],['server','env'],['secret','set'],['secret','delete'],['file-action']]) {
    expect(mutatesControl(args)).toBe(false);
    expect(mutatesControl([...args,'--apply'])).toBe(true);
  }
});

test('lock inspection is read-only and incomplete bootstrap locks can be archived explicitly', async () => {
  await controlCommand(['server','lock',...conn]);
  expect(await readdir(vm)).toEqual([]);
  await mkdir(join(vm,'control/lock'),{recursive:true,mode:0o700});
  const held = await lockStatus();
  expect(held.locked).toBe(true);
  expect(held.owner).toBeNull();
  await controlCommand(['server','unlock','--lock-id',held.lockId,...conn]);
  expect(await lockStatus()).toEqual(held);
  expect(await readdir(join(vm,'control'))).toEqual(['lock']);
  await expect(controlCommand(['server','unlock','--apply',...conn])).rejects.toThrow('requires --lock-id');
  await expect(controlCommand(['server','unlock','--lock-id','../../lock','--apply',...conn])).rejects.toThrow('Invalid --lock-id');
  await controlCommand(['server','unlock','--lock-id',held.lockId,'--apply','-f',manifest]);
  expect(await lockStatus()).toEqual({locked:false});
  const archive = join(vm,'control/broken-locks',(await readdir(join(vm,'control/broken-locks')))[0]);
  const audit = await Bun.file(join(archive,(await readdir(archive))[0])).json();
  expect(audit.lockId).toBe(held.lockId);
  expect(audit.by.operation).toBe('server unlock');
  expect(audit.brokenAt).toBeString();
});

test('unlock compares exact lock identity, keeps snapshot intact and rejects a second breaker', async () => {
  await publish();
  const before = await snapshot();
  await mkdir(join(vm,'control/lock'));
  await Bun.write(join(vm,'control/lock/token'),'legacy-token');
  const first = await lockStatus();
  await Bun.write(join(vm,'control/lock/token'),'replacement-token');
  await expect(controlCommand(['server','unlock','--lock-id',first.lockId,'--apply',...conn])).rejects.toThrow('Lock changed');
  expect(await Bun.file(join(vm,'control/lock/token')).text()).toBe('replacement-token');
  const held = await lockStatus();
  const results = await Promise.allSettled([1,2].map(()=>controlCommand(['server','unlock','--lock-id',held.lockId,'--apply',...conn])));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
  expect(await readdir(join(vm,'control/broken-locks'))).toHaveLength(1);
  expect(await snapshot()).toEqual(before);
  expect(await lockStatus()).toEqual({locked:false});
  await connectedCommand(['deploy','--apply',...conn],async()=>{});
});

test('revoked writer cannot commit or release a replacement lock', async () => {
  await publish();
  const before = await snapshot();
  const c = await readConfig(manifest);
  const replacement = crypto.randomUUID();
  let recovery = '';
  try {
    await connectedCommand(['deploy','--apply',...conn],async()=>{
      const held = await lockStatus();
      expect(held.owner.operation).toBe('deploy');
      expect(held.owner.pid).toBe(process.pid);
      expect(held.owner.host).toBeString();
      await controlCommand(['server','unlock','--lock-id',held.lockId,'--apply',...conn]);
      await controlOperations.remote(c,controlLockScript(c,'acquire',{token:replacement,operator:{operation:'replacement'}}));
    });
    throw new Error('Revoked writer unexpectedly succeeded');
  } catch (e) {
    expect((e as Error).message).toContain('VM lock release failed');
    recovery = (e as Error).message.match(/retained at (.+)\.$/)?.[1] ?? '';
  }
  try {
    expect(await snapshot()).toEqual(before);
    expect(await Bun.file(join(vm,'control/lock/token')).text()).toBe(replacement);
    expect(recovery).not.toBe('');
    expect(await Bun.file(join(recovery,'recovery-snapshot.json')).exists()).toBe(true);
  } finally { if(recovery) await rm(recovery,{recursive:true,force:true}); }
});

test('unlock refuses symlinked lock directories and foreign manifest ownership', async () => {
  await publish();
  const outside = join(dir,'outside');
  await mkdir(outside);
  await Bun.write(join(outside,'token'),'keep');
  await symlink(outside,join(vm,'control/lock'));
  await expect(controlCommand(['server','lock',...conn])).rejects.toThrow('permissions');
  await expect(controlCommand(['server','unlock','--lock-id','a'.repeat(64),'--apply',...conn])).rejects.toThrow('permissions');
  expect(await Bun.file(join(outside,'token')).text()).toBe('keep');
  await rm(join(vm,'control/lock'));
  await mkdir(join(vm,'control/lock'));
  const held = await lockStatus();
  await mkdir(join(vm,'edge'));
  await Bun.write(join(vm,'edge/owner'),'other-server');
  await expect(controlCommand(['server','unlock','--lock-id',held.lockId,'--apply','-f',manifest])).rejects.toThrow('ownership');
  expect(await readdir(join(vm,'control/lock'))).toEqual([]);
});

test('VM app secrets CRUD is independent of config checkout and never lists values', async () => {
  await publish();
  const file=join(dir,'app.env');await Bun.write(file,'PASSWORD=server-secret-$literal\n');
  await connectedCommand(['secret','set','--app','api','--env-file',file,'--apply',...conn],async()=>{throw Error('not dispatched');});
  expect((await snapshot()).appSecrets.api.PASSWORD).toBe('server-secret-$literal');
  // A subsequent apply from another checkout with no references must retain secrets.
  await connectedCommand(['deploy','--apply',...conn],async()=>{});
  expect((await snapshot()).appSecrets.api.PASSWORD).toBe('server-secret-$literal');
  await connectedCommand(['secret','list','--app','api',...conn],async()=>{});
  await connectedCommand(['secret','delete','--app','api','--key','PASSWORD','--apply',...conn],async()=>{});
  expect((await snapshot()).appSecrets.api.PASSWORD).toBeUndefined();
});

test('a concurrent revision change refuses stale work and releases its lock', async () => {
  await publish();
  const execute=controlOperations.remote;let reads=0;let invoked=false;
  controlOperations.remote=async(c,script)=>{
    const value=await execute(c,script);
    const s=value.trim().startsWith('{')?JSON.parse(value):undefined;
    if(s?.revision&&s.config&&++reads===2) {
      s.revision=crypto.randomUUID();return JSON.stringify(s);
    }
    return value;
  };
  await expect(connectedCommand(['deploy','--apply',...conn],async()=>{invoked=true;})).rejects.toThrow('Server changed');
  expect(invoked).toBe(false);
  expect(await Bun.file(join(vm,'control/lock/token')).exists()).toBe(false);
});


test('partial first source apply retains imported legacy secrets across replacement runtime',async()=>{
 await publish();
 const initial=await snapshot();
 const app={name:'api',image:'example/api@sha256:'+'a'.repeat(64),port:8080,memoryMb:128,cpus:1,compose:{project:'legacy',services:{blue:'api-blue',green:'api-green'},containers:{blue:'prod-api-blue',green:'prod-api-green'},upstreamFile:'/opt/upstreams/api.caddy',upstreamName:'up_api'}};
 initial.config=configSchema.parse({...initial.config,apps:[app]});
 initial.state['compose/api/template.json']=JSON.stringify({'x-2server':{current:'blue'},services:{'api-blue':{environment:{OLD_SECRET:'retained-for-older-checkout'}}}});
 await Bun.write(join(vm,'control/current/snapshot.json'),JSON.stringify(initial));
 await expect(connectedCommand(['deploy','--apply',...conn],async args=>{
  const file=args[1],c=await readConfig(file);
  c.apps[0].env={NEW_PUBLIC:'new-version'};
  await Bun.write(file,JSON.stringify(c));
  await Bun.write(join(operatorState(c.name),'compose/api/template.json'),JSON.stringify({'x-2server':{current:'green'},services:{'api-green':{environment:{NEW_PUBLIC:'new-version'}}}}));
  throw new Error('domain reconciliation failed after app deployment');
 })).rejects.toThrow('domain reconciliation failed');
 expect((await snapshot()).appSecrets.api.OLD_SECRET).toBe('retained-for-older-checkout');
 expect((await snapshot()).config.apps[0].env).toEqual({NEW_PUBLIC:'new-version'});
 await connectedCommand(['get','app',...conn],async()=>{});
 expect((await snapshot()).appSecrets.api.OLD_SECRET).toBe('retained-for-older-checkout');
});

test('bootstrap is offline without apply, then sets up, publishes privately and saves SSH once', async () => {
  let setups=0;
  const profile=join(dir,'project','.2server');
  controlOperations.setup=async()=>{setups++;};
  controlOperations.saveConnection=ssh=>saveConnection(ssh,profile);
  const env=join(dir,'bootstrap.env');
  await Bun.write(env,'CLOUDFLARE_API_TOKEN="vm-owned-$literal"\nUNREFERENCED=ignored\n');
  await controlCommand(['server','bootstrap','-f',manifest,'--env-file',env]);
  expect(setups).toBe(0);
  expect(await Bun.file(join(vm,'control/current/snapshot.json')).exists()).toBe(false);
  expect(await Bun.file(join(profile,'connection.yaml')).exists()).toBe(false);
  await controlCommand(['server','bootstrap','-f',manifest,'--env-file',env,'--apply']);
  expect(setups).toBe(1);
  expect((await snapshot()).env).toEqual({CLOUDFLARE_API_TOKEN:'vm-owned-$literal'});
  expect((await stat(join(profile,'connection.yaml'))).mode & 0o777).toBe(0o600);
  expect(await Bun.file(join(profile,'connection.yaml')).text()).not.toContain('vm-owned');
  await expect(controlCommand(['server','bootstrap','-f',manifest,'--apply'])).rejects.toThrow();
  expect(setups).toBe(1);
});

test('failed bootstrap does not publish or save a connection; retry can recover', async () => {
  let saved=false;
  controlOperations.setup=async()=>{throw new Error('setup failure');};
  controlOperations.saveConnection=async()=>{saved=true;};
  await expect(controlCommand(['server','bootstrap','-f',manifest,'--apply'])).rejects.toThrow('setup failure');
  expect(saved).toBe(false);
  expect(await Bun.file(join(vm,'control/current/snapshot.json')).exists()).toBe(false);
  expect((await lockStatus()).locked).toBe(false);
  controlOperations.setup=async()=>{};
  await controlCommand(['server','bootstrap','-f',manifest,'--apply']);
  expect(saved).toBe(true);
});

test('VM snapshot with widened permissions fails closed before returning secrets', async () => {
  await publish();
  const file=join(vm,'control/current/snapshot.json');
  await chmod(file,0o644);
  await expect(connectedCommand(['get','app',...conn],async()=>{throw Error('must not dispatch');})).rejects.toThrow('permissions');
  await chmod(file,0o600);
  await chmod(join(vm,'control/revisions'),0o755);
  await expect(connectedCommand(['get','app',...conn],async()=>{})).rejects.toThrow('permissions');
});

test('invalid secret file does not disclose its content or create a revision', async () => {
  await publish();
  const before=await snapshot(),file=join(dir,'invalid.env');
  await Bun.write(file,'PASSWORD="secret-first-line\nsecret-second-line"\n');
  let message='';
  try {await connectedCommand(['secret','set',...conn,'--env-file',file,'--apply'],async()=>{});} catch(e) {message=(e as Error).message;}
  expect(message).toContain('Invalid secret file');
  expect(message).not.toContain('secret-first-line');
  expect(await snapshot()).toEqual(before);
});

test('resource reservations coexist, conflict atomically, fence unlock and exclude legacy writers', async()=>{
  await publish();
  const c=await readConfig(manifest), a=crypto.randomUUID(), b=crypto.randomUUID();
  const acquire=async(token:string,resources:string[])=>controlOperations.remote(c,controlLockScript(c,'acquire',{token,resources,operator:{operation:'test'}}));
  expect(await acquire(a,['app:api'])).toBe('');
  expect(await acquire(b,['app:web'])).toBe('');
  let held=await lockStatus();
  expect(held.locks).toHaveLength(2);
  expect(JSON.parse(await acquire(crypto.randomUUID(),['app:api','app:worker'])).error).toBe('Resource is locked');
  expect((await lockStatus()).locks).toHaveLength(2);
  expect(JSON.parse(await acquire(crypto.randomUUID(),['server'])).error).toBe('Resource is locked');
  await expect(run(['mkdir',join(vm,'control/lock')])).rejects.toThrow(); // Old CLI fails closed.
  const victim=held.locks.find((r:any)=>r.resources.includes('app:api'));
  await controlCommand(['server','unlock','--lock-id',victim.lockId,'--apply',...conn]);
  held=await lockStatus();
  expect(held.locks).toHaveLength(1);
  expect(held.locks[0].resources).toEqual(['app:web']);
  await expect(controlOperations.remote(c,controlLockScript(c,'release',{token:a}))).rejects.toThrow();
  await controlOperations.remote(c,controlLockScript(c,'release',{token:b}));
  expect(await lockStatus()).toEqual({locked:false});
  expect(await acquire(a,['server'])).toBe('');
  expect(JSON.parse(await acquire(b,['app:api'])).error).toBe('Resource is locked');
});

test('two independent CLI sessions overlap rollouts and retain both app records and portable state', async()=>{
  const c=await readConfig(manifest);
  c.apps=configSchema.parse({...c,apps:['api','web'].map(name=>({name,image:'example/app@sha256:'+'a'.repeat(64),port:8080,memoryMb:128,cpus:1}))}).apps;
  await Bun.write(manifest,JSON.stringify(c));await publish();
  const worker=join(dir,'worker.ts');
  await Bun.write(worker,`
import {connectedCommand} from ${JSON.stringify(new URL('../src/modules/control/application/session.ts',import.meta.url).pathname)};
import {controlOperations} from ${JSON.stringify(new URL('../src/modules/control/application/operations.ts',import.meta.url).pathname)};
import {run} from ${JSON.stringify(new URL('../src/shared/infrastructure/process.ts',import.meta.url).pathname)};
import {operatorState} from ${JSON.stringify(new URL('../src/shared/infrastructure/operator-state.ts',import.meta.url).pathname)};
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
const vm=${JSON.stringify(vm)}, dir=${JSON.stringify(dir)}, name=process.argv[2];
controlOperations.remote=async(_c,script)=>run(['bash','-se'],script.replace('test "$(id -u)" = 0','test "$(id -u)" = ${process.getuid!()}').replaceAll('/opt/2server',vm).replaceAll('mv -Tf',${JSON.stringify(process.platform==='darwin'?'gmv -Tf':'mv -Tf')}));
controlOperations.upload=async(_c,files,target)=>{target=target.replace('/opt/2server',vm);await mkdir(target,{recursive:true,mode:0o700});for(const [p,v]of Object.entries(files))await Bun.write(join(target,p),v);};
await connectedCommand(['deploy','app',name,'--apply','--ssh','operator@vm.example'],async(args)=>{
 const path=args.at(-1)!,c=await Bun.file(path).json();
 await Bun.write(join(dir,name+'-ready'),'ready');
 while(!await Bun.file(join(dir,name+'-go')).exists())await Bun.sleep(10);
 c.apps.find(a=>a.name===name).image='example/'+name+'@sha256:'+'b'.repeat(64);
 await Bun.write(path,JSON.stringify(c));
 const state=join(operatorState(c.name),'compose',name);await mkdir(state,{recursive:true});
 await Bun.write(join(state,'template.json'),JSON.stringify({app:name}));
});
`);
  const launch=(name:string)=>Bun.spawn([process.execPath,'--no-env-file',worker,name],{stdout:'pipe',stderr:'pipe'});
  const a=launch('api'), b=launch('web');
  try {
    const deadline=Date.now()+10000;
    while(!await Bun.file(join(dir,'api-ready')).exists() || !await Bun.file(join(dir,'web-ready')).exists()) {
      if(Date.now()>deadline)throw Error('Different apps did not enter rollout concurrently');
      await Bun.sleep(20);
    }
    const same=launch('api');expect(await same.exited).not.toBe(0);
    expect(await new Response(same.stderr).text()).toContain('control lock');
    await Bun.write(join(dir,'web-go'),'go');expect(await b.exited).toBe(0);
    await Bun.write(join(dir,'api-go'),'go');expect(await a.exited).toBe(0);
    const saved=await snapshot();
    for(const name of ['api','web']) {
      expect(saved.config.apps.find((app:any)=>app.name===name).image).toBe('example/'+name+'@sha256:'+'b'.repeat(64));
      expect(JSON.parse(saved.state['compose/'+name+'/template.json'])).toEqual({app:name});
    }
    expect(await lockStatus()).toEqual({locked:false});
  } finally {a.kill();b.kill();}
},20000);

test('snapshot compare-and-swap retries only commit, preserving another app update',async()=>{
  await publish();
  const upload=controlOperations.upload;let injected=false,calls=0;
  controlOperations.upload=async(c,files,target)=>{
    await upload(c,files,target);calls++;
    if(!injected){injected=true;const current=await snapshot();current.appSecrets={web:{PASSWORD:'concurrent-secret'}};await concurrentCommit(current);}
  };
  let executions=0;
  await connectedCommand(['file-action','--apply',...conn],async args=>{
    executions++;
    const file=args.at(-1)!,c=await readConfig(file);
    c.apps=configSchema.parse({...c,apps:[{name:'api',image:'example/api@sha256:'+'a'.repeat(64),port:8080,memoryMb:128,cpus:1}]}).apps;
    await Bun.write(file,JSON.stringify(c));
  },{resources:['app:api']});
  expect(calls).toBe(2);expect(executions).toBe(1);
  expect((await snapshot()).appSecrets.web.PASSWORD).toBe('concurrent-secret');
  expect((await snapshot()).config.apps[0].name).toBe('api');
});

test('domain phase starts after app commit, refreshes state and preserves partial failures',async()=>{
  await publish();
  await expect(connectedCommand(['file-action','--apply',...conn],async(args,session)=>{
    const file=args.at(-1)!,c=await readConfig(file);
    const before=await lockStatus();expect(before.locks.flatMap((l:any)=>l.resources)).toEqual(['app:api']);
    c.apps=configSchema.parse({...c,apps:[{name:'api',image:'example/api@sha256:'+'a'.repeat(64),port:8080,memoryMb:128,cpus:1}]}).apps;
    await Bun.write(file,JSON.stringify(c));
    // Simulate another completed domain operation since this app loaded its snapshot.
    const concurrent=await snapshot();concurrent.state['certificates/other/pair.json']='other-cert';
    await concurrentCommit(concurrent);
    await session!.prepareDomains();
    expect((await snapshot()).config.apps[0].name).toBe('api');
    expect(await Bun.file(join(operatorState(c.name),'certificates/other/pair.json')).text()).toBe('other-cert');
    expect((await lockStatus()).locks.flatMap((l:any)=>l.resources).sort()).toEqual(['app:api','domains']);
    await mkdir(join(operatorState(c.name),'certificates/site'),{recursive:true});
    await Bun.write(join(operatorState(c.name),'certificates/site/pair.json'),'issued-before-failure');
    throw Error('DNS failed');
  },{resources:['app:api']})).rejects.toThrow('DNS failed');
  expect((await snapshot()).config.apps[0].name).toBe('api');
  expect((await snapshot()).state['certificates/site/pair.json']).toBe('issued-before-failure');
  expect((await snapshot()).state['certificates/other/pair.json']).toBe('other-cert');
  expect(await lockStatus()).toEqual({locked:false});
});

test('a revoked domain reservation fences commit and still releases the app reservation',async()=>{
  await publish();let recovery='';const before=await snapshot();
  try {
    await connectedCommand(['file-action','--apply',...conn],async(_args,session)=>{
      await session!.prepareDomains();
      const row=(await lockStatus()).locks.find((l:any)=>l.resources.includes('domains'));
      await controlCommand(['server','unlock','--lock-id',row.lockId,'--apply',...conn]);
      await mkdir(join(operatorState(before.config.name),'certificates/site'),{recursive:true});
      await Bun.write(join(operatorState(before.config.name),'certificates/site/pair.json'),'revoked');
    },{resources:['app:api']});
    throw Error('Revoked domain writer succeeded');
  } catch(e) {
    expect((e as Error).message).toContain('VM lock release failed');
    recovery=(e as Error).message.match(/retained at (.+)\.$/)?.[1]??'';
  }
  try {
    expect(recovery).not.toBe('');
    expect(await Bun.file(join(recovery,'recovery-snapshot.json')).exists()).toBe(true);
    expect((await snapshot()).state['certificates/site/pair.json']).toBeUndefined();
    expect(await lockStatus()).toEqual({locked:false});
  } finally {if(recovery)await rm(recovery,{recursive:true,force:true});}
});

test('incomplete scoped gate and holder remain inspectable and explicitly recoverable',async()=>{
  await publish();
  for(const partialHolder of ['gate','missing','malformed']) {
    await mkdir(join(vm,'control/lock'),{mode:0o700});
    await Bun.write(join(vm,'control/lock/scoped'),'true',{mode:0o600});
    if(partialHolder!=='gate') {
      const holder=join(vm,'control/lock',crypto.randomUUID());await mkdir(holder,{mode:0o700});
      if(partialHolder==='malformed')await Bun.write(join(holder,'resources.json'),'{');
    }
    const status=await lockStatus();
    expect(status.locked).toBe(true);
    const lockId=status.lockId??status.locks[0].lockId;
    await controlCommand(['server','unlock','--lock-id',lockId,'--apply',...conn]);
    expect(await lockStatus()).toEqual({locked:false});
  }
});


test('source App downloads without a reservation, then validates fresh locked state',async()=>{
 const originals={...fileOperations};
 try {
  await publish();
  const image='example/api@sha256:'+'a'.repeat(64);
  const input=join(dir,'app.yaml');
  await Bun.write(input,Bun.YAML.stringify({apiVersion:'2server.app/v1',kind:'App',metadata:{name:'api'},spec:{image:'example/api:latest',port:8080,memoryMb:128,cpus:1,secrets:{PASSWORD:{provider:'vm',key:'PASSWORD'}}}}));
  fileOperations.preflightEdge=async()=>'';
  for(const scenario of ['success','secret-changed','registry-failed','identity-changed']) {
   const initial=await snapshot();initial.appSecrets={api:{PASSWORD:'old-secret'}};await concurrentCommit(initial);
   const before=await snapshot();let pulls=0,deploys=0;
   fileOperations.resolveImage=async(_c,ref,pullPinned)=>{
    pulls++;expect(ref).toBe('example/api:latest');expect(pullPinned).toBe(true);
    expect(await lockStatus()).toEqual({locked:false});
    expect((await snapshot()).revision).toBe(before.revision);
    if(scenario==='registry-failed')throw Error('registry unavailable');
    const other=await snapshot();
    // Simulate a completed writer during the download, without holding its lock.
    other.appSecrets.api=scenario==='secret-changed'?{}:{PASSWORD:'fresh-secret'};
    if(scenario==='identity-changed')other.config.name='replacement';
    other.appSecrets.web={OTHER:'independent-secret'};
    await concurrentCommit(other);
    return image;
   };
   fileOperations.deployApp=async(c,a)=>{
    deploys++;expect(a.image).toBe(image);
    expect((await lockStatus()).locks[0].resources).toEqual(['app:api']);
    expect(await fileOperations.resolveEnv(a,c)).toContain('fresh-secret');
   };
   const run=()=>fileCommand(['deploy','-f',input,...conn,'--apply']);
   if(scenario==='success') {
    await run();expect(deploys).toBe(1);
    const saved=await snapshot();expect(saved.config.apps[0].image).toBe(image);
    expect(saved.appSecrets.web).toEqual({OTHER:'independent-secret'});
   } else {
    await expect(run()).rejects.toThrow(scenario==='secret-changed'?'missing':scenario==='registry-failed'?'registry unavailable':'Server identity changed');
    expect(deploys).toBe(0);
   }
   expect(pulls).toBe(1);expect(await lockStatus()).toEqual({locked:false});
  }
 } finally {Object.assign(fileOperations,originals);}
},20000);

test('lock diagnostics distinguish contention and transport failure without exposing tokens',async()=>{
 await publish();const c=await readConfig(manifest);
 const events:Record<string,unknown>[]=[];controlOperations.lockEvent=e=>{events.push(e);};
 const token=await acquire(c,'deploy app',['app:api']);
 try {
  await expect(acquire(c,'deploy app',['app:api'])).rejects.toThrow('VM control lock conflict');
  const blocked=events.find(e=>e.event==='blocked')!;
  expect(blocked.resources).toEqual(['app:api']);
  expect((blocked.blocker as any).lockId).toMatch(/^[a-f0-9]{64}$/);
  expect((blocked.blocker as any).resources).toEqual(['app:api']);
  expect(blocked.waitMs).toBeGreaterThanOrEqual(0);
 } finally {await release(c,token);}
 expect(events.find(e=>e.event==='released')!.heldMs).toBeGreaterThanOrEqual(0);
 expect(JSON.stringify(events)).not.toContain(token);
 controlOperations.remote=async()=>{throw Error('SECRET-SSH-OUTPUT');};
 await expect(acquire(c,'deploy app',['app:api'])).rejects.toThrow('SSH, ownership or control response failed');
 expect(events.at(-1)!.event).toBe('acquire-failed');
 expect(JSON.stringify(events)).not.toContain('SECRET-SSH-OUTPUT');
 for(const response of ['not-json','[]','{}',JSON.stringify({error:'unexpected-private-error'})]) {
  controlOperations.remote=async()=>response;
  await expect(acquire(c,'deploy app',['app:api'])).rejects.toThrow('control response failed');
  expect(events.at(-1)!.event).toBe('acquire-failed');
 }
 expect(JSON.stringify(events)).not.toContain('unexpected-private-error');
});

test('bounded lock wait reports its blocker once and succeeds after release',async()=>{
 await publish();const c=await readConfig(manifest);
 const token=await acquire(c,'first',['domains']);
 const events:Record<string,unknown>[]=[];controlOperations.lockEvent=e=>{events.push(e);};
 const remote=controlOperations.remote;let released=false;
 controlOperations.remote=async(c,script)=>{
  const output=await remote(c,script);
  if(!released && output.includes('Resource is locked')) {
   released=true;await release(c,token);
  }
  return output;
 };
 const next=await acquire(c,'second',['domains'],3000);
 try {
  expect(events.filter(e=>e.event==='waiting')).toHaveLength(1);
  expect(events.filter(e=>e.event==='blocked')).toHaveLength(0);
  expect(events.find(e=>e.event==='acquired')!.waitMs).toBeGreaterThanOrEqual(250);
 } finally {await release(c,next);}
});
