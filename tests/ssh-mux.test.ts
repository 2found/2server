import { afterEach,expect,test } from 'bun:test';
import { chmod,mkdir,mkdtemp,rm,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '../src/modules/config/application/config';
import { muxDirectory,parseDryRun,sshArgs } from '../src/shared/infrastructure/process';

const gcp=configSchema.parse({version:1,name:'test',ssh:{kind:'gcp',instance:'app',project:'proj',zone:'asia-southeast1-a'},edge:{mode:'managed'}});
const marker='__2server_remote_command__';
const printed=`/usr/bin/ssh -T -i /home/op/.ssh/google_compute_engine -o CheckHostIP=no -o HostKeyAlias=compute.1 -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/home/op/.ssh/google_compute_known_hosts -o "ProxyCommand /usr/bin/python3 /sdk/lib/gcloud.py compute start-iap-tunnel app %p --listen-on-stdin --project=proj --zone=asia-southeast1-a --verbosity=warning" -o ProxyUseFdpass=no op@compute.1 -o BatchMode=yes -o StrictHostKeyChecking=yes -- ${marker}`;

test('gcloud dry-run output becomes the ssh argv it would have run',()=>{
  const argv=parseDryRun(`Updates are available\n${printed}\n`)!;
  expect(argv[0]).toBe('/usr/bin/ssh');
  expect(argv).toContain('ProxyCommand /usr/bin/python3 /sdk/lib/gcloud.py compute start-iap-tunnel app %p --listen-on-stdin --project=proj --zone=asia-southeast1-a --verbosity=warning');
  expect(argv.slice(-2)).toEqual(['--',marker]);
});

test('anything but a plain ssh command with the command slot keeps the gcloud path',()=>{
  expect(parseDryRun('')).toBeUndefined();
  expect(parseDryRun(printed.replace('/usr/bin/ssh','/usr/bin/putty'))).toBeUndefined();
  expect(parseDryRun(printed.replace(`-- ${marker}`,'-- other'))).toBeUndefined();
  expect(parseDryRun(printed.replace(`-- ${marker}`,marker))).toBeUndefined();
  expect(parseDryRun(printed.replace('%p','"%p'))).toBeUndefined();
});

test('connection reuse leaves the logical command, and so the connection digest, unchanged',()=>{
  const logical=sshArgs(gcp,'sudo -n bash -se');
  expect(logical.slice(-4)).toEqual(['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes']);
  expect(logical.join(' ')).not.toContain('Control');
  const reused=sshArgs(gcp,'sudo -n bash -se',['-o','ControlPath=/tmp/x']);
  expect(reused.slice(-2)).toEqual(['-o','ControlPath=/tmp/x']);
  const direct=configSchema.parse({version:1,name:'test',ssh:{kind:'ssh',host:'example.com',user:'ops'},edge:{mode:'managed'}});
  const args=sshArgs(direct,'true',['-o','ControlMaster=auto']);
  expect(args.at(-1)).toBe('true');
  expect(args.indexOf('ControlMaster=auto')).toBeLessThan(args.indexOf('ops@example.com'));
});

const dirs:string[]=[];
afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
test('the socket directory is private to this user or reuse is off',async()=>{
  const uid=process.getuid!();
  const base=await mkdtemp(join(tmpdir(),'two-mux-'));dirs.push(base);
  expect(muxDirectory(base,uid)).toBe(`${base}/2srv-ssh-${uid}`);
  await chmod(`${base}/2srv-ssh-${uid}`,0o755);
  expect(muxDirectory(base,uid)).toBeUndefined();
  const other=await mkdtemp(join(tmpdir(),'two-mux-'));dirs.push(other);
  await mkdir(join(other,'target'),{mode:0o700});
  await symlink(join(other,'target'),`${other}/2srv-ssh-${uid}`);
  expect(muxDirectory(other,uid)).toBeUndefined();
  expect(muxDirectory(other,uid+1)).toBeUndefined();
  const previous=process.env.TWO_SERVER_SSH_MUX;process.env.TWO_SERVER_SSH_MUX='0';
  try{expect(muxDirectory(base,uid)).toBeUndefined();}finally{if(previous===undefined)delete process.env.TWO_SERVER_SSH_MUX;else process.env.TWO_SERVER_SSH_MUX=previous;}
});
