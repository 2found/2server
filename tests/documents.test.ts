import { afterEach,expect,test } from 'bun:test';
import { mkdir,mkdtemp,readdir,rm,utimes,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseResource } from '../src/cli/resources';
import { resolveEnv } from '../src/modules/apps/application/environment';
import { imageOperations,resolveImage } from '../src/modules/apps/infrastructure/images';
import { configSchema } from '../src/modules/config/application/config';
import { parseDocument } from '../src/modules/source/application/documents';
import { extensionTemplate } from '../src/modules/source/application/templates';
import { fileCommand,fileOperations } from '../src/modules/source/cli/command';
import { authoritativeApp } from '../src/modules/source/domain/app';
import { setSessionState } from '../src/shared/infrastructure/operator-state';
import { parseData } from '../src/shared/infrastructure/serialization';
import { setVmSecrets } from '../src/shared/infrastructure/vm-secrets';
const digest='registry:5000/api@sha256:'+'a'.repeat(64);
const raw={apiVersion:'2server.app/v1',kind:'App',metadata:{name:'api'},spec:{image:'registry:5000/api:latest',port:8080,memoryMb:128,cpus:1,env:{NODE_ENV:'production'},secrets:{PASSWORD:{provider:'vm',key:'PASSWORD'}}}};
const base=configSchema.parse({version:1,name:'server',ssh:{kind:'ssh',host:'host.example',user:'operator'},edge:{mode:'managed'}});
const original={...fileOperations};const imageRemote=imageOperations.remote;
afterEach(()=>{Object.assign(fileOperations,original);imageOperations.remote=imageRemote;setVmSecrets();setSessionState();});
test('strict versioned YAML, templates, unknown fields, runtime requirements',()=>{
 expect(parseDocument(parseData(Bun.YAML.stringify(raw))).metadata.name).toBe('api');
 for(const name of ['postgres','redis','nats','monitoring','image-proxy'])expect(parseDocument(extensionTemplate(name)).kind).toBe('Extension');
 for(const change of [{apiVersion:'2server.app/v2'},{spec:{...raw.spec,typo:true}},{spec:{...raw.spec,image:'bad image'}}])expect(()=>parseDocument({...raw,...change})).toThrow();
});
test('source is authoritative and missing VM secrets cannot use local env',async()=>{
 const doc=parseDocument(raw);if(doc.kind!=='App')throw Error();
 const app=authoritativeApp(doc,digest);
 expect(app.env).toEqual({NODE_ENV:'production'});
 const local=process.env.PASSWORD;process.env.PASSWORD='local-secret';setVmSecrets({api:{}});
 try{await expect(resolveEnv(app)).rejects.toThrow('missing');setVmSecrets({api:{PASSWORD:'server-$literal'}});expect(await resolveEnv(app)).toContain('PASSWORD=server-$literal');}
 finally{if(local===undefined)delete process.env.PASSWORD;else process.env.PASSWORD=local;}
});
test('latest is re-resolved each time; failures never use daemon cache',async()=>{
 let n=0;const scripts:string[]=[];
 imageOperations.remote=async(_c,s)=>{scripts.push(s);return 'sha256:'+String(++n).repeat(64);};
 expect(await resolveImage(base,'registry:5000/api:latest')).toBe('registry:5000/api@sha256:'+'1'.repeat(64));
 expect(await resolveImage(base,'registry:5000/api:latest')).toBe('registry:5000/api@sha256:'+'2'.repeat(64));
 expect(scripts.every(s=>s.includes("'docker','pull'")&&!s.includes('image inspect'))).toBe(true);
 imageOperations.remote=async()=>{throw Error('registry unavailable');};
 await expect(resolveImage(base,'registry:5000/api:latest')).rejects.toThrow('no cached image fallback');
 expect(await resolveImage(base,digest)).toBe(digest);
});
test('source plans do not mutate control; applied image apps declare their resource scope',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'document-lock-'));
 try {
  const file=join(dir,'source.yaml');
  let resources:string[]|undefined;
  let applied=false;
  fileOperations.connectedCommand=async(args,_fn,options)=>{
   resources=options?.resources;applied=args.includes('--apply');return true;
  };
  for(const doc of [raw,extensionTemplate('redis')]) {
   await writeFile(file,Bun.YAML.stringify(doc));
   await fileCommand(['get','-f',file,'--ssh','operator@vm']);
   expect(applied).toBe(false);
   await fileCommand(['plan','-f',file,'--ssh','operator@vm']);
   expect(applied).toBe(false);
   await writeFile(file,Bun.YAML.stringify({...doc,spec:{...doc.spec,image:digest}}));
   await fileCommand(['plan','-f',file,'--ssh','operator@vm']);
   expect(applied).toBe(false);
   await fileCommand(['apply','-f',file,'--ssh','operator@vm','--apply']);
   expect(applied).toBe(true);expect(resources).toEqual(doc.kind==='App'?[`app:${doc.metadata.name}`]:undefined);
  }
 } finally {await rm(dir,{recursive:true,force:true});}
});
test('file apply replaces current config, uses override, preserves source, failed deploy does not save desired state',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'document-test-'));
 try {
  const file=join(dir,'app.yaml'),server=join(dir,'server.json');await writeFile(file,Bun.YAML.stringify(raw));const source=await Bun.file(file).text();
  const old={...authoritativeApp(parseDocument(raw) as any,digest),env:{OBSOLETE:'remove'}};
  const c={...base,apps:[old]};await writeFile(server,JSON.stringify(c));setSessionState(join(dir,'state'));setVmSecrets({api:{PASSWORD:'vm-secret'}});
  fileOperations.connectedCommand=async(args,fn)=>{expect(args).toContain('--apply');await fn([...args,'-f',server]);return true;};
  fileOperations.resolveImage=async(_c,ref)=>{expect(ref).toBe('registry:5000/api:override');return digest;};
  fileOperations.preflightEdge=async()=>"";
  fileOperations.deployApp=async(_c,a)=>{expect(a.env).toEqual({NODE_ENV:'production'});};
  await fileCommand(['apply','-f',file,'--image','registry:5000/api:override','--ssh','operator@host.example','--apply']);
  expect((await Bun.file(server).json()).apps[0].env).toEqual({NODE_ENV:'production'});
  expect(await Bun.file(file).text()).toBe(source);
  await writeFile(server,JSON.stringify(c));fileOperations.deployApp=async()=>{throw Error('unhealthy');};
  await expect(fileCommand(['deploy','-f',file,'--image','registry:5000/api:override','--ssh','operator@host.example','--apply'])).rejects.toThrow('unhealthy');
  expect((await Bun.file(server).json()).apps[0].env).toEqual({OBSOLETE:'remove'});
 } finally{await rm(dir,{recursive:true,force:true});}
});
test('template init never overwrites source, invalid CLI override rejected',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'template-test-'));const file=join(dir,'redis.yaml');
 try{await fileCommand(['init','extension','redis','-o',file]);await expect(fileCommand(['init','extension','redis','-o',file])).rejects.toThrow();await expect(fileCommand(['deploy','-f',file,'--image',digest])).rejects.toThrow('only valid');}
 finally{await rm(dir,{recursive:true,force:true});}
});

test('dependencies use public extension names and do not prevent inspection or retirement',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dependency-file-'));
 try {
  const f=join(dir,'app.yaml'),server=join(dir,'server.json');
  await writeFile(f,Bun.YAML.stringify({...raw,requires:[{kind:'Extension',name:'image-proxy'}]}));
  const configured=configSchema.parse({...base,extensions:{imageProxy:{allowedSources:['https://example.com/'],keyEnv:'IMGPROXY_KEY',saltEnv:'IMGPROXY_SALT'}}});
  await writeFile(server,JSON.stringify(configured));
  fileOperations.connectedCommand=async(args,fn)=>{await fn([...args,'-f',server]);return true;};
  fileOperations.resolveImage=async()=>digest;
  setVmSecrets({api:{PASSWORD:'vm-secret'}});
  await fileCommand(['plan','-f',f,'--ssh','operator@vm']);
  await writeFile(server,JSON.stringify(base));
  await expect(fileCommand(['plan','-f',f,'--ssh','operator@vm'])).rejects.toThrow('Missing dependency Extension/image-proxy');
  const calls:string[]=[];
  fileOperations.resourceCommand=async args=>{calls.push(args[0]);return true;};
  await fileCommand(['get','-f',f,'--ssh','operator@vm']);
  await fileCommand(['delete','-f',f,'--ssh','operator@vm','--apply']);
  expect(calls).toEqual(['get','delete']);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('extension file replaces settings and explicitly binds server secrets',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'extension-file-'));const key='REDIS_PASSWORD';const prior=process.env[key];
 try {
  const d=extensionTemplate('redis');const f=join(dir,'redis.yaml');await writeFile(f,Bun.YAML.stringify(d));const server=join(dir,'server.json');await writeFile(server,JSON.stringify(base));setSessionState(join(dir,'state'));
  fileOperations.connectedCommand=async(args,fn)=>{await fn([...args,'-f',server]);return true;};
  let invoked=false;
  fileOperations.resourceCommand=async args=>{invoked=true;expect(args.slice(0,3)).toEqual(['create','extension','redis']);const spec=await Bun.file(args[args.indexOf('--spec')+1]).json();expect(spec.image).toContain('@sha256:');return true;};
  fileOperations.resolveImage=async()=>`redis@sha256:${'a'.repeat(64)}`;
  delete process.env[key];await expect(fileCommand(['apply','-f',f,'--ssh','a@vm','--apply'])).rejects.toThrow('Missing VM secret');expect(invoked).toBe(false);
  process.env[key]='vm-secret';await fileCommand(['apply','-f',f,'--ssh','a@vm','--apply']);expect(invoked).toBe(true);
 } finally {if(prior===undefined)delete process.env[key];else process.env[key]=prior;await rm(dir,{recursive:true,force:true});}
});


test('image-proxy files retain the public name when dispatching resource operations',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'image-proxy-file-'));
 const previous=[process.env.IMGPROXY_KEY,process.env.IMGPROXY_SALT];
 try {
  const f=join(dir,'image-proxy.yaml'),server=join(dir,'server.json');
  await writeFile(f,Bun.YAML.stringify(extensionTemplate('image-proxy')));
  await writeFile(server,JSON.stringify(base));setSessionState(join(dir,'state'));
  process.env.IMGPROXY_KEY='test-key';process.env.IMGPROXY_SALT='test-salt';
  fileOperations.connectedCommand=async(args,fn)=>{await fn([...args,'-f',server]);return true;};
  fileOperations.resolveImage=async()=>`darthsim/imgproxy@sha256:${'a'.repeat(64)}`;
  const operations:string[]=[];
  fileOperations.resourceCommand=async args=>{const request=parseResource(args)!;expect(request.name).toBe('imageProxy');operations.push(request.verb);return true;};
  await fileCommand(['get','-f',f,'--ssh','operator@vm']);
  await fileCommand(['plan','-f',f,'--ssh','operator@vm']);
  await fileCommand(['apply','-f',f,'--ssh','operator@vm','--apply']);
  await fileCommand(['delete','-f',f,'--ssh','operator@vm','--apply']);
  expect(operations).toEqual(['get','create','create','delete']);
 } finally {
  for(const [i,key]of ['IMGPROXY_KEY','IMGPROXY_SALT'].entries())if(previous[i]===undefined)delete process.env[key];else process.env[key]=previous[i];
  await rm(dir,{recursive:true,force:true});
 }
});


test('missing app secrets fail before registry downloads',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'preflight-file-'));
 try {
  const file=join(dir,'app.yaml'),server=join(dir,'server.json');
  await writeFile(file,Bun.YAML.stringify(raw));await writeFile(server,JSON.stringify(base));
  fileOperations.connectedCommand=async(args,fn)=>{await fn([...args,'-f',server]);return true;};
  let pulls=0;fileOperations.resolveImage=async()=>{pulls++;return digest;};
  setVmSecrets({api:{}});
  await expect(fileCommand(['plan','-f',file,'--ssh','operator@vm'])).rejects.toThrow('missing');
  expect(pulls).toBe(0);
 }finally{await rm(dir,{recursive:true,force:true});}
});


test('deployment retention follows persisted appliedAt rather than snapshot hydration mtimes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'history-retention-'));
 try{
  const f=join(dir,'app.yaml'),server=join(dir,'server.json'),state=join(dir,'state'),history=join(state,'deployments');
  await mkdir(history,{recursive:true});await writeFile(f,Bun.YAML.stringify(raw));await writeFile(server,JSON.stringify(base));
  const names=[];
  for(let i=1;i<=20;i++){
   const name=crypto.randomUUID()+'.json';names.push(name);
   await writeFile(join(history,name),JSON.stringify({appliedAt:new Date(Date.UTC(2020,0,i)).toISOString()}));
   // A restored snapshot may materialize its newest record first.
   await utimes(join(history,name),1000+20-i,1000+20-i);
  }
  setSessionState(state);setVmSecrets({api:{PASSWORD:'secret'}});
  fileOperations.connectedCommand=async(args,fn)=>{await fn([...args,'-f',server]);return true;};
  fileOperations.resolveImage=async()=>digest;fileOperations.preflightEdge=async()=>'';fileOperations.deployApp=async()=>{};
  await fileCommand(['apply','-f',f,'--ssh','operator@vm','--apply']);
  const retained=await readdir(history);
  expect(retained).toHaveLength(20);expect(retained).not.toContain(names[0]);expect(retained).toContain(names[19]);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('bootstrap/app templates round trip through their actual parsers; init refuses overwrite',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'two-dx-template-'));
 try {
  for(const kind of ['server','app']) {
   const file=join(dir,kind+'.json');
   await fileCommand(['init',kind,'demo','-o',file]);
   const raw=await Bun.file(file).json();
   if(kind==='server')expect(configSchema.parse(raw).apps).toEqual([]);
   else expect(parseDocument(raw).kind).toBe('App');
   await expect(fileCommand(['init',kind,'demo','-o',file])).rejects.toThrow();
  }
 } finally{await rm(dir,{recursive:true,force:true});}
});

test('App domain preflight failure prevents image pull and rollout for plan and apply',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'two-dx-domain-'));
 try {
  const file=join(dir,'app.yaml'),server=join(dir,'server.json');
  const domain={name:'api',zone:'example.com',hosts:['api.example.com'],upstream:{kind:'import',name:'up_two_api'}};
  await writeFile(file,Bun.YAML.stringify({...raw,domains:[domain]}));
  await writeFile(server,JSON.stringify(base));
  fileOperations.connectedCommand=async(args,fn)=>{await fn([...args,'-f',server]);return true;};
  setVmSecrets({api:{PASSWORD:'vm-secret'}});
  let calls=0,pulls=0,deploys=0;
  fileOperations.planSourceDomains=async(_c,domains)=>{calls++;expect(domains[0].hosts).toEqual(['api.example.com']);throw Error('DNS conflict');};
  fileOperations.resolveImage=async()=>{pulls++;return digest;};
  fileOperations.deployApp=async()=>{deploys++;};
  for(const flags of [[],['--apply']])await expect(fileCommand(['deploy','-f',file,'--ssh','operator@vm',...flags])).rejects.toThrow('DNS conflict');
  expect(calls).toBe(2);expect(pulls).toBe(0);expect(deploys).toBe(0);
  expect((await Bun.file(server).json()).apps).toEqual([]);
 } finally{await rm(dir,{recursive:true,force:true});}
});

test('Domain source plan validates raw VM config even when monitoring adds its own domain',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'two-dx-monitor-domain-'));
 try {
  const file=join(dir,'domain.yaml'),server=join(dir,'server.json');
  const spec={zone:'example.com',hosts:['api.example.com'],upstream:{kind:'import',name:'up_two_api'}};
  const c=configSchema.parse({...base,domains:[{name:'api',...spec}],extensions:{monitoring:true}});
  await writeFile(server,JSON.stringify(c));
  await writeFile(file,Bun.YAML.stringify({apiVersion:'2server.app/v1',kind:'Domain',metadata:{name:'api'},spec}));
  fileOperations.connectedCommand=async(args,fn)=>{await fn([...args,'-f',server]);return true;};
  let inspected=false;
  fileOperations.planSourceDomains=async c=>{configSchema.parse(c);inspected=true;};
  fileOperations.resourceCommand=async()=>true;
  await fileCommand(['plan','-f',file,'--ssh','operator@vm']);
  expect(inspected).toBe(true);
 } finally {await rm(dir,{recursive:true,force:true});}
});
