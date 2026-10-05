import { expect,test } from 'bun:test';
import { mkdir,mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindWorkload } from '../src/modules/apps/application/bind-workload';
import { appSchema } from '../src/modules/apps/domain/schema';
import { instanceEnv } from '../src/modules/apps/domain/workload';
import { composeOperations,deployCompose,rollbackCompose,validateTemplate } from '../src/modules/apps/infrastructure/compose';
import { deployScript } from '../src/modules/apps/infrastructure/runtime';
import { desiredService } from '../src/modules/apps/infrastructure/workload';
import { configSchema } from '../src/modules/config/application/config';
import { parseDocument } from '../src/modules/source/application/documents';
import { assertBindings,authoritativeApp } from '../src/modules/source/domain/app';
import { setSessionState } from '../src/shared/infrastructure/operator-state';
import { run } from '../src/shared/infrastructure/process';
const c=configSchema.parse({version:1,name:'test',ssh:{kind:'ssh',host:'example.com',user:'ops'},edge:{mode:'managed'}});
const digest='example/app@sha256:'+'a'.repeat(64);
const source={apiVersion:'2server.app/v1',kind:'App',metadata:{name:'api'},spec:{image:digest,port:8080,memoryMb:512,cpus:1,env:{NEW:'value'},instanceEnv:{DURABLE:'ingestors-${generation}'},volumeMounts:[{name:'data',mountPath:'/data'}],healthCheck:{command:['wget','--spider','http://localhost:8080/readyz']},preDeploy:{command:['migrate']}}};
const sourceApp=(raw:any=source)=>authoritativeApp(parseDocument(raw) as any,digest);
const old=appSchema.parse({...sourceApp(),env:{STALE:'must-remove'},command:['old-command'],compose:{project:'legacy',services:{blue:'api-blue',green:'api-green'},containers:{blue:'prod-api-blue',green:'prod-api-green'},upstreamFile:'/opt/lohi/caddy/api.caddy',upstreamName:'up_prod-api',migrationRequired:true}});
function template():any {
 return {name:'legacy',services:Object.fromEntries(['blue','green'].map(color=>[`api-${color}`,{container_name:`prod-api-${color}`,image:digest,command:['old-command'],environment:{STALE:'secret-old'},networks:{edge:{}},volumes:[{type:'volume',source:`data-${color}`,target:'/data'}]}])),networks:{edge:{external:true,name:'edge'}},volumes:Object.fromEntries(['blue','green'].map(color=>[`data-${color}`,{name:`legacy_data-${color}`,external:true}])),'x-2server':{owner:c.name,app:old.name,current:'blue',previous:'',specs:{blue:old}}};
}
test('single file accepts app intent and rejects secret collisions and hidden runtime controls',()=>{
 expect(sourceApp().compose).toBeUndefined();
 for(const patch of [{instanceEnv:{NEW:'${generation}'}},{instanceEnv:{X:'${HOME}'}},{volumeMounts:[{name:'data',mountPath:'/data'},{name:'other',mountPath:'/data'}]},{labels:{'io.2server.owner':'evil'}},{volumeMounts:[{name:'data',mountPath:'/../host'}]}])expect(()=>sourceApp({...source,spec:{...source.spec,...patch}})).toThrow();
 expect(instanceEnv(sourceApp(),'blue')).toEqual({DURABLE:'ingestors-blue'});
 const rendered=desiredService(c,{...sourceApp(),compose:old.compose},'green',{SECRET:'literal-$secret'});
 expect(rendered.healthcheck?.test).toEqual(['CMD','wget','--spider','http://localhost:8080/readyz']);
 expect(rendered.environment).toEqual({SECRET:'literal-$secret',DURABLE:'ingestors-green'});
 expect(rendered).not.toHaveProperty('command');
});
test('adopted bindings survive single-file apply and older checkout; active generation is untouched; rollback retains spec',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'two-workload-'));const operations={...composeOperations};setSessionState(dir);
 try {
  const file=join(dir,'compose/api/template.json');await mkdir(join(file,'..'),{recursive:true});const initial=template();await Bun.write(file,JSON.stringify(initial));
  const a=await bindWorkload(c,sourceApp(),old);
  assertBindings(old,a);
  expect(a.env).toEqual({NEW:'value'});expect(a.command).toBeUndefined();
  expect(a.compose?.runtime).toBeUndefined();expect(a.compose?.volumeBindings?.data).toEqual({blue:'legacy_data-blue',green:'legacy_data-green'});
  const scripts:string[]=[];let uploaded:any;
  // deployCompose/rollbackCompose read the live generation first; report the
  // color the fake VM would be serving after each successful roll.
  let liveCur:'blue'|'green'='blue',liveSpec:any=a;
  composeOperations.remote=async(_c,s)=>{if(s.includes('live upstream serves'))return JSON.stringify({current:liveCur,spec:liveSpec});scripts.push(s);return '';};
  composeOperations.upload=async(_c,files)=>{uploaded=JSON.parse(files['compose.json']);};
  await deployCompose(c,a,'NEW=value\nSECRET=literal-$secret\n');
  liveCur='green';liveSpec=a;
  expect(uploaded.services['api-blue']).toEqual(initial.services['api-blue']);
  expect(uploaded.services['api-green'].environment).toEqual({NEW:'value',SECRET:'literal-$$secret',DURABLE:'ingestors-green'});
  expect(uploaded.services['api-green'].command).toBeUndefined();
  expect(uploaded.volumes['claim-data-green'].name).toBe('legacy_data-green');
  expect(scripts[0]).toContain("docker volume inspect 'legacy_data-green'");expect(scripts[0]).not.toContain('volume create');
  // A second checkout can remove fields without inheriting the other user's spec.
  const b=await bindWorkload(c,sourceApp({...source,spec:{image:digest,port:8080,memoryMb:256,cpus:1}}),a);
  await deployCompose(c,b,'');
  liveCur='blue';liveSpec=b;
  expect(uploaded.services['api-blue'].environment).toEqual({});
  expect(uploaded.services['api-blue'].volumes).toEqual([]);expect(uploaded.services['api-blue'].healthcheck).toBeUndefined();
  expect(uploaded.services['api-green'].environment.DURABLE).toBe('ingestors-green');
  expect(b.compose?.volumeBindings?.data.green).toBe('legacy_data-green');
  const restored=await rollbackCompose(c,b);expect(restored.instanceEnv).toEqual(a.instanceEnv);expect(restored.volumeMounts).toEqual(a.volumeMounts);
  const before=await Bun.file(file).text();composeOperations.remote=async()=>{throw Error('missing bound volume');};
  await expect(deployCompose(c,a,'')).rejects.toThrow('missing bound volume');expect(await Bun.file(file).text()).toBe(before);
 } finally {Object.assign(composeOperations,operations);setSessionState();await rm(dir,{recursive:true,force:true});}
});
test('VM binding rejects wrong owner and shared physical volumes under different aliases',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'two-bind-'));setSessionState(dir);
 try {
  const file=join(dir,'compose/api/template.json');await mkdir(join(file,'..'),{recursive:true});const t=template();t.volumes['data-green'].name=t.volumes['data-blue'].name;
  expect(()=>validateTemplate(t,old)).toThrow('share');
  await Bun.write(file,JSON.stringify(t));await expect(bindWorkload(c,sourceApp(),old)).rejects.toThrow('share');
  t['x-2server'].owner='other';await Bun.write(file,JSON.stringify(t));await expect(bindWorkload(c,sourceApp(),old)).rejects.toThrow('ownership');
 }finally{setSessionState();await rm(dir,{recursive:true,force:true});}
});
test('native workload implements the same typed health, labels, instance env and isolated volume contract',async()=>{
 const a=sourceApp({...source,spec:{...source.spec,replicas:2,labels:{autoheal:'true'}}});
 const script=deployScript(c,a,'release');await run(['bash','-n'],script);
 expect(script).toContain("DURABLE=ingestors-blue");expect(script).toContain("DURABLE=ingestors-green");
 expect(script).toContain('two-test-api-data-blue-2');expect(script).toContain('two-test-api-data-green-2');
 expect(script).toContain('--health-cmd');expect(script).toContain("--label 'autoheal=true'");
 expect(script).toContain('deadline=$((SECONDS + 240))');
});

const dockerTest=process.env.DOCKER_TESTS==='1'?test:test.skip;
dockerTest('generated Compose starts isolated healthy containers with literal secrets and per-generation data',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'two-generated-docker-'));
 const id='two-generated-'+crypto.randomUUID().slice(0,8),network=id+'-edge',volumes=[id+'-blue',id+'-green'];
 const file=join(dir,'compose.json');
 const {renderCompose}=await import('../src/modules/apps/infrastructure/compose');
 try {
  await run(['docker','network','create',network]);
  for(const v of volumes)await run(['docker','volume','create',v]);
  const config=configSchema.parse({...c,edge:{...c.edge,network}});
  const a=appSchema.parse({...sourceApp(),command:['sh','-c','printf "%s" "$SECRET/$DURABLE" > /data/value; while true; do sleep 1; done'],healthCheck:{command:['sh','-c','test -s /data/value'],intervalSeconds:1,timeoutSeconds:1,startPeriodSeconds:0,failureThreshold:2},compose:{...old.compose,project:id,containers:{blue:id+'-blue',green:id+'-green'}}});
  const t:any={name:id,services:{},networks:{[network]:{external:true,name:network}},volumes:{},'x-2server':{owner:c.name,app:a.name}};
  for(const [i,color] of (['blue','green'] as const).entries()) {
   t.services[a.compose!.services[color]]={...desiredService(config,a,color,{SECRET:'literal-$DO_NOT_EXPAND'}),image:'caddy:2.10.2-alpine'};
   t.volumes[`claim-data-${color}`]={external:true,name:volumes[i]};
  }
  validateTemplate(t,a);await Bun.write(file,renderCompose(t));
  await run(['docker','compose','-p',id,'-f',file,'up','-d','--wait','--wait-timeout','30']);
  for(const color of ['blue','green'] as const) {
   const name=a.compose!.containers[color];
   expect(await run(['docker','exec',name,'cat','/data/value'])).toBe('literal-$DO_NOT_EXPAND/ingestors-'+color);
   const inspect=JSON.parse(await run(['docker','inspect',name]))[0];
   expect(inspect.State.Health.Status).toBe('healthy');expect(inspect.HostConfig.CapDrop).toContain('ALL');
   expect(inspect.Config.Labels['io.2server.generation']).toBe(color);
  }
 } finally {
  if(await Bun.file(file).exists())await run(['docker','compose','-p',id,'-f',file,'down']).catch(()=>{});
  for(const v of volumes)await run(['docker','volume','rm',v]).catch(()=>{});
  await run(['docker','network','rm',network]).catch(()=>{});await rm(dir,{recursive:true,force:true});
 }
},90000);

test('capabilities allow only an explicit low-port bind permission',()=>{
 const a=sourceApp({...source,spec:{...source.spec,capabilities:['NET_BIND_SERVICE']}});
 expect(desiredService(c,{...a,compose:old.compose},'blue',{}).cap_add).toEqual(['NET_BIND_SERVICE']);
 expect(deployScript(c,a,'release')).toContain("--cap-add 'NET_BIND_SERVICE'");
 expect(()=>sourceApp({...source,spec:{...source.spec,capabilities:['SYS_ADMIN']}})).toThrow();
 const t=template();t.services['api-blue'].cap_add=['SYS_ADMIN'];expect(()=>validateTemplate(t,old)).toThrow();
});
dockerTest('Caddy with file capabilities starts under the declared restricted capability set',async()=>{
 const name='two-caddy-caps-'+crypto.randomUUID().slice(0,8);
 try {
  await run(['docker','run','-d','--name',name,'--init','--cap-drop','ALL','--cap-add','NET_BIND_SERVICE','--security-opt','no-new-privileges:true','caddy:2.11.4-alpine','caddy','file-server','--listen',':8080','--root','/srv']);
  let ready=false;
  for(let n=0;n<20;n++) {try{await run(['docker','exec',name,'wget','-qO-','http://localhost:8080/']);ready=true;break;}catch{await Bun.sleep(250);}}
  // /srv can be empty (404); a running process proves exec passed file-capability checks.
  const state=JSON.parse(await run(['docker','inspect',name]))[0];expect(state.State.Running).toBe(true);
  expect(await run(['docker','exec',name,'caddy','version'])).toContain('v2.11.4');
 }finally{await run(['docker','rm','-f',name]).catch(()=>{});}
},90000);
