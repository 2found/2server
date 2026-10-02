import {test,expect,afterEach} from 'bun:test';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {configSchema,type Config} from '../src/config';
import {parseDocument} from '../src/documents';
import {templateApp} from '../src/templates';
import {extensionFor} from '../src/extensions';
import {statefulFiles,statefulPreflightScript} from '../src/stateful';
import {setVmSecrets} from '../src/vm-secrets';
import {resolveBindings} from '../src/bindings';
import {setSessionState} from '../src/operator-state';
import {runtimeHealthFiles} from '../src/extensions/monitoring/runtime-health';
import {appCommand} from '../src/app-command';
import {postgresCliOperations} from '../src/extensions/postgres/cli';
import {fileCommand,fileOperations} from '../src/file-command';
import {backupScript} from '../src/extensions/postgres/backups';
import {physicalRestoreScript} from '../src/extensions/postgres/pgbackrest';
import {monitoringCompose} from '../src/extensions/monitoring/hooks';
import {monitoringDomain} from '../src/extensions/monitoring/settings';
const base={version:1,name:'template-test',ssh:{kind:'ssh',host:'unused.example',user:'operator'},edge:{mode:'managed'}};
const original={...fileOperations},pgOriginal={...postgresCliOperations};
afterEach(()=>{setSessionState();setVmSecrets();Object.assign(fileOperations,original);Object.assign(postgresCliOperations,pgOriginal);});
function entry(name:string,template='postgres') {
 const d=parseDocument(templateApp(name,template));if(d.kind!=='Extension')throw Error();
 return {template,spec:d.spec,secrets:d.secrets,webhooks:d.webhooks};
}
function credentials(names:string[]) {
 setVmSecrets(Object.fromEntries(names.map((name,i)=>[name,{POSTGRES_PASSWORD:`${name}-app-password-long-${i}`,POSTGRES_ADMIN_PASSWORD:`${name}-admin-password-long-${i}`,POSTGRES_MIGRATION_PASSWORD:`${name}-migration-password-long-${i}`}])));
}

test('one template creates independent named apps with isolated data, secrets, bindings and scripts',async()=>{
 const c=configSchema.parse({...base,extensionApps:{orders:entry('orders'),billing:entry('billing')}});
 credentials(['orders','billing']);
 const bundles:Record<string,Record<string,string>>={};
 for(const name of ['orders','billing']) {
  const ext=extensionFor(c,name)!;
  const files=await statefulFiles(c,ext);bundles[name]=files;
  const compose=JSON.parse(files['compose.json']);
  expect(Object.keys(compose.services)).toEqual([`two-template-test-${name}`]);
  expect(compose.services[`two-template-test-${name}`].volumes).toContain(`/opt/2server/data/${name}:/var/lib/postgresql`);
  expect(files['app-password']).toContain(name);
  expect(statefulPreflightScript(c,ext)).toContain(`/opt/2server/extensions/${name}/current`);
  const context=ext.context!(c);
  context.extensions.postgres!.backup={engine:'dump',destination:`gs://test-bucket/${name}`} as any;
  expect(backupScript(context)).toContain(`docker exec two-template-test-${name} pg_dump`);
  expect(backupScript(context)).toContain(`/opt/2server/backups/${name}`);
  context.extensions.postgres!.backup!.engine='pgbackrest';
  expect(physicalRestoreScript(context,{name:'review'})).toContain(`two-template-test-${name}-recovery-review`);
 }
 expect(bundles.orders['app-password']).not.toEqual(bundles.billing['app-password']);
 expect(resolveBindings(c,{DATABASE_URL:{extension:'orders',output:'appUrl'}}).DATABASE_URL).toContain('@two-template-test-orders:5432/');
 expect(()=>configSchema.parse({...c,extensionApps:{...c.extensionApps,billing:{...entry('billing'),spec:{...entry('billing').spec,dataPath:'/opt/2server/data/orders'}}}})).toThrow('non-overlapping');
});

test('extension commands are available only for installed apps and the right template',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'template-cli-'));setSessionState(join(dir,'state'));
 try {
  const file=join(dir,'server.json');const c=configSchema.parse({...base,extensionApps:{orders:entry('orders'),cache:entry('cache','redis')}});
  await writeFile(file,JSON.stringify(c));
  const logs:string[]=[];const previous=console.log;console.log=(...args)=>{logs.push(args.join(' '));};
  try {
   await appCommand(['app-action','orders','help','-f',file],async()=>{});
   expect(logs.join('\n')).toContain('app orders backup');logs.length=0;
   await appCommand(['app-action','cache','help','-f',file],async()=>{});
   expect(logs.join('\n')).not.toContain('backup');
  }finally{console.log=previous;}
  let calls=0;postgresCliOperations.remote=async()=>{calls++;return '';};postgresCliOperations.runBackup=async()=>{calls++;return '';};
  await expect(appCommand(['app-action','missing','backup','-f',file,'--apply'],async()=>{})).rejects.toThrow('not installed');
  await expect(appCommand(['app-action','cache','backup','-f',file,'--apply'],async()=>{})).rejects.toThrow('not installed');
  await expect(appCommand(['app-action','orders','backup','-f',file,'--apply'],async()=>{})).rejects.toThrow('not configured');
  expect(calls).toBe(0);
  c.extensionApps.orders.spec.backup={engine:'dump',destination:'gs://test-bucket/orders'};
  await writeFile(file,JSON.stringify(c));
  await appCommand(['app-action','orders','backup','-f',file],async()=>{});expect(calls).toBe(0);
  await appCommand(['app-action','orders','backup','-f',file,'--apply'],async()=>{});expect(calls).toBe(1);
  await expect(appCommand(['app-action','orders','constructor','-f',file],async()=>{})).rejects.toThrow('not installed');
  delete c.extensionApps.orders;await writeFile(file,JSON.stringify(c));
  await expect(appCommand(['app-action','orders','backup','-f',file,'--apply'],async()=>{})).rejects.toThrow('not installed');
  expect(calls).toBe(1);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('template apply records installation only after success and uses app-scoped secrets',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'template-source-'));
 try {
  const file=join(dir,'database.yaml'),server=join(dir,'server.json');
  await writeFile(file,Bun.YAML.stringify(templateApp('orders','postgres')));
  await writeFile(server,JSON.stringify(configSchema.parse(base)));
  fileOperations.connectedCommand=async(args,fn)=>{await fn([...args,'-f',server]);return true;};
  fileOperations.resolveImage=async(_c,ref)=>ref+'@sha256:'+'a'.repeat(64);
  let attempts=0;fileOperations.deployExtension=async(_c,name)=>{attempts++;expect(name).toBe('orders');throw Error('readiness failed');};
  setVmSecrets({});
  await expect(fileCommand(['deploy','-f',file,'--ssh','operator@host','--apply'])).rejects.toThrow('secret set --app orders');
  expect(attempts).toBe(0);
  credentials(['orders']);
  await expect(fileCommand(['deploy','-f',file,'--ssh','operator@host','--apply'])).rejects.toThrow('readiness failed');
  expect((await Bun.file(server).json()).extensionApps).toEqual({});
  fileOperations.deployExtension=async()=>{};
  // Avoid writing history into the operator's real state in this mocked session.
  const {setSessionState}=await import('../src/operator-state');setSessionState(join(dir,'state'));
  try {await fileCommand(['deploy','-f',file,'--ssh','operator@host','--apply']);}finally{setSessionState();}
  expect((await Bun.file(server).json()).extensionApps.orders.template).toBe('postgres');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('monitoring template instances have distinct routes, containers and no competing host ports',()=>{
 const c=configSchema.parse({...base,extensionApps:{metrics:entry('metrics','monitoring')}});
 const context=extensionFor(c,'metrics')!.context!(c);
 const compose=monitoringCompose(context);
 expect(compose.services['two-template-test-metrics-prometheus'].ports).toBeUndefined();
 expect(monitoringDomain(context)?.upstream).toEqual({kind:'proxy',target:'two-template-test-metrics-prometheus:9090'});
 expect(monitoringDomain(context)?.name).toBe('metrics');
 expect(()=>configSchema.parse({...base,extensionApps:{metrics:entry('metrics','monitoring'),other:entry('other','monitoring')}})).toThrow('distinct domain');
 expect(()=>configSchema.parse({...base,extensionApps:{metrics:entry('metrics','monitoring'),'metrics-prometheus':entry('metrics-prometheus','redis')}})).toThrow('containers must not conflict');
});

const integration=process.env.DOCKER_TESTS==='1'?test:test.skip;
integration('two real PostgreSQL template apps isolate credentials and persist their own data',async()=>{
 const {run}=await import('../src/process');
 const {mkdir,chmod}=await import('node:fs/promises');
 const root=await mkdtemp(join(tmpdir(),'two-template-runtime-'));
 const server=`tpl-${crypto.randomUUID().slice(0,8)}`,network=`two-${server}`;
 const c=configSchema.parse({...base,name:server,edge:{mode:'managed',network},extensionApps:{orders:entry('orders'),billing:entry('billing')}});
 credentials(['orders','billing']);
 const bundles:{project:string;file:string}[]=[];
 try {
  await run(['docker','network','create',network]);
  for(const name of ['orders','billing']) {
   const dir=join(root,name);await mkdir(dir);
   const files=await statefulFiles(c,extensionFor(c,name)!);
   const compose=JSON.parse(files['compose.json']),project=`two-${server}-${name}`,file=join(dir,'compose.json');
   compose.volumes={data:{}};compose.services[project].volumes[0]='data:/var/lib/postgresql';
   files['compose.json']=JSON.stringify(compose);bundles.push({project,file});
   for(const [f,value]of Object.entries(files)){await writeFile(join(dir,f),value,{mode:0o600});}
   await run(['docker','volume','create',`${project}_data`]);
   await run(['docker','run','--rm','--user','0:0','--entrypoint','sh','-v',`${project}_data:/data`,'postgres:18.6-bookworm','-ec','chown postgres:postgres /data; chmod 700 /data']);
   await run(['docker','compose','-p',project,'-f',file,'up','-d','--wait','--wait-timeout','60']);
   await run(['docker','exec',project,'psql','-X','-U','two_admin','-d','app','-c',`CREATE TABLE identity(value text); INSERT INTO identity VALUES ('${name}');`]);
  }
  for(const {project,file}of bundles) {
   const name=project.endsWith('orders')?'orders':'billing',other=name==='orders'?'billing':'orders';
   await expect(run(['docker','exec','-e',`PGPASSWORD=${other}-app-password-long-${other==='orders'?0:1}`,project,'psql','-X','-h','127.0.0.1','-U','app','-d','app','-Atc','SELECT 1'])).rejects.toThrow();
   await run(['docker','compose','-p',project,'-f',file,'restart']);
   await run(['docker','compose','-p',project,'-f',file,'up','-d','--wait','--wait-timeout','60']);
   expect((await run(['docker','exec',project,'psql','-X','-U','two_admin','-d','app','-Atc','SELECT value FROM identity'])).trim()).toBe(name);
  }
 }finally{
  for(const {project,file}of bundles)await run(['docker','compose','-p',project,'-f',file,'down','-v','--timeout','1']).catch(()=>{});
  await run(['docker','network','rm',network]).catch(()=>{});
  await rm(root,{recursive:true,force:true});
 }
},180000);

test('public CLI routes app commands and keeps template commands out of root help',async()=>{
 const invocations:string[][]=[];
 const execute=async(args:string[])=>{invocations.push(args);};
 await appCommand(['app','orders','logs'],execute);
 await appCommand(['app','orders','backup','--apply'],execute);
 await appCommand(['app','orders','constructor'],execute);
 expect(invocations).toEqual([['logs','app','orders'],['app-action','orders','backup','--apply'],['app-action','orders','constructor']]);
 const proc=Bun.spawn(['bun','src/cli.ts','--help'],{stdout:'pipe',stderr:'pipe'});
 const out=await new Response(proc.stdout).text();expect(await proc.exited).toBe(0);
 expect(out).not.toContain('check-backup');expect(out).not.toContain('webhook');
 expect(out).toContain('app [NAME]');
});

test('monitoring discovers named template apps from VM releases and emits valid scoped metrics',async()=>{
 const {mkdir,chmod}=await import('node:fs/promises');
 const root=await mkdtemp(join(tmpdir(),'template-observer-'));
 try {
  for(const dir of ['bin','extensions/cache/current','extensions/broker/current'])await mkdir(join(root,dir),{recursive:true});
  for(const [app,template]of [['cache','redis'],['broker','nats']]){
   await writeFile(join(root,`extensions/${app}/current/extension.json`),'{}');
   await writeFile(join(root,`extensions/${app}/current/identity.json`),JSON.stringify({template}));
  }
  await writeFile(join(root,'bin/docker'),`#!/bin/bash
if [ "$1" = inspect ]; then
 echo '{"state":{"Running":true},"restarts":0,"owner":"template-test","networks":{}}'
elif [[ "$*" == *two-template-test-cache* ]]; then
 printf 'used_memory:42\\r\\naof_last_write_status:ok\\r\\n'
elif [[ "$*" == *varz* ]]; then
 echo '{"connections":3,"slow_consumers":0}'
else
 echo '{"config":{"max_storage":100},"storage":9}'
fi
`);await chmod(join(root,'bin/docker'),0o755);
  const c=configSchema.parse({...base,extensionApps:{metrics:entry('metrics','monitoring')}});
  const script=runtimeHealthFiles(extensionFor(c,'metrics')!.context!(c))['runtime-metrics.sh'].replaceAll('/opt/2server',root);
  const proc=Bun.spawn(['bash','-se'],{env:{...process.env,PATH:`${root}/bin:${process.env.PATH}`},stdin:new Blob([script]),stdout:'pipe',stderr:'pipe'});
  const error=await new Response(proc.stderr).text();expect(await proc.exited,error).toBe(0);
  const metrics=await Bun.file(join(root,'metrics/metrics-runtime.prom')).text();
  expect(metrics).toContain('two_redis_used_memory{collector="metrics",app="cache"} 42');
  expect(metrics).toContain('two_nats_connections{collector="metrics",app="broker"} 3');
  expect(metrics).toContain('two_container_running{collector="metrics",container="two-template-test-cache"} 1');
  expect(metrics).toContain('two_runtime_metrics_timestamp_seconds{collector="metrics"}');
 }finally{await rm(root,{recursive:true,force:true});}
});
