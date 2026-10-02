import { expect,test } from 'bun:test';
import { chmod,mkdir,mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseResource } from '../src/cli/resources';
import { appSchema } from '../src/modules/apps/domain/schema';
import { adoptCompose,composeOperations,composePods,composeProbe,composeRollScript,confirmComposeMigrations,deployCompose,renderCompose,rollbackCompose,validateTemplate } from '../src/modules/apps/infrastructure/compose';
import { configSchema } from '../src/modules/config/application/config';
import { setSessionState } from '../src/shared/infrastructure/operator-state';
import { run } from '../src/shared/infrastructure/process';
const c=configSchema.parse({version:1,name:'test',ssh:{kind:'ssh',host:'example.com',user:'ops'},edge:{mode:'managed'}});
const a=appSchema.parse({name:'api',image:`example/api@sha256:${'a'.repeat(64)}`,port:8080,memoryMb:512,cpus:1,compose:{project:'test',services:{blue:'api-blue',green:'api-green'},containers:{blue:'prod-api-blue',green:'prod-api-green'},upstreamFile:'/opt/upstreams/api.caddy',upstreamName:'up_prod-api',sourceFiles:['/original/compose.yml'],migrationRequired:true}});
function template():any {return {name:'test',services:{'api-blue':{image:a.image,container_name:'prod-api-blue',environment:{SECRET:'literal-$test'},networks:{edge:null}},'api-green':{image:a.image,container_name:'prod-api-green',networks:{edge:null}}},networks:{edge:{external:true,name:'edge'}},'x-2server':{owner:'test',app:'api',current:'blue',previous:'',specs:{blue:a}}};}
test('Compose contracts preserve isolated generations and reject host access/shared writers',()=>{
  expect(()=>validateTemplate(template(),a)).not.toThrow();
  for(const edit of [(t:any)=>t.services['api-blue'].environment={FOO:null},(t:any)=>t.services['api-blue'].environment=['FOO=bar'],(t:any)=>t.services['api-blue'].environment=null,(t:any)=>t.include=['/private/compose.yaml'],(t:any)=>t.services['api-blue'].extends={file:'/private/compose.yaml',service:'base'},(t:any)=>t.services['api-blue'].volumes_from=['privileged'],(t:any)=>t.services['api-blue'].use_api_socket=true,(t:any)=>t.services['api-blue'].privileged=true,(t:any)=>t.services['api-green'].ports=['80:80'],(t:any)=>t.services['api-green'].volumes=[{type:'bind',source:'/',target:'/host'}],(t:any)=>{t.volumes={data:{name:'data',external:true}};for(const s of Object.values(t.services) as any[])s.volumes=[{type:'volume',source:'data',target:'/data'}];}]) {const t=template();edit(t);expect(()=>validateTemplate(t,a)).toThrow();}
  expect(()=>appSchema.parse({...a,replicas:2})).toThrow();
  expect(parseResource(['deploy','app','api','-f','f','--migrations-applied'])?.options['migrations-applied']).toBe('true');
  expect(()=>parseResource(['get','app','-f','f','--migrations-applied'])).toThrow();
});
test('adoption persists private exact env; migration gate rejects new image before remote mutation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'two-compose-'));const original={...composeOperations};let mutations=0;
 setSessionState(dir);
 try{
  const captured=template();delete captured['x-2server'];captured.color='blue';captured.image=a.image;
  composeOperations.remote=async(_c,script)=>script.includes('import json,subprocess')?JSON.stringify(captured):'';
  composeOperations.upload=async()=>{mutations++};
  const adopted=await adoptCompose(c,a);
  expect(adopted.compose?.sourceFiles).toBeUndefined();
  expect(mutations).toBe(1);
  const file=join(dir,'compose/api/template.json');
  expect((await Bun.file(file).json()).services['api-blue'].environment.SECRET).toBe('literal-$test');
  await expect(deployCompose(c,{...adopted,image:`example/api@sha256:${'b'.repeat(64)}`},'')).rejects.toThrow('requires migrations');
  expect(mutations).toBe(1);
  await deployCompose(c,{...adopted,preDeploy:{command:['migrate'],timeoutSeconds:30},image:`example/api@sha256:${'b'.repeat(64)}`},'');
  expect((await Bun.file(file).json())['x-2server'].current).toBe('green');
 }finally{Object.assign(composeOperations,original);setSessionState();confirmComposeMigrations(false);await rm(dir,{recursive:true,force:true});}
});
const dockerTest=process.env.DOCKER_TESTS === '1' ? test : test.skip;
dockerTest('Compose JSON keeps literal secret dollars in an actual container',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'two-compose-render-'));
 const project='two-escape-'+crypto.randomUUID().slice(0,8);
 const file=join(dir,'compose.json');
 try{
  const t=template();delete t.networks;
  for(const service of Object.values(t.services) as any[]) {delete service.networks;delete service.container_name;service.image='caddy:2.10.2-alpine';}
  await Bun.write(file,renderCompose(t));
  const out=await run(['docker','compose','-p',project,'-f',file,'run','--rm','--no-deps','--entrypoint','sh','api-blue','-c','printf "%s" "$SECRET"']);
  expect(out).toBe('literal-$test');
 }finally{await run(['docker','compose','-p',project,'-f',file,'down']);await rm(dir,{recursive:true,force:true});}
},60000);
test('rollout script parses and preserves the old generation until gate/reload success',async()=>{
 const script=composeRollScript(c,a,'blue','green','/opt/release.json');
 await run(['bash','-n'],script);
 expect(script.indexOf('test "$ready" = true')).toBeLessThan(script.indexOf('switched=true\nprintf'));
 expect(script).toContain('up -d --no-deps');
 expect(script).not.toContain('--remove-orphans');
 expect(script.indexOf('caddy reload')).toBeLessThan(script.lastIndexOf('docker stop -t'));
});

test('failed readiness and failed Caddy validation keep live route; success drains only old container',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'two-compose-roll-'));
 try{
  await mkdir(join(dir,'apps/api'),{recursive:true});await mkdir(join(dir,'upstreams'));
  const file=join(dir,'candidate.json');await Bun.write(file,'{}');
  for(const scenario of ['predeploy-fails','health-fails','transient-ready','caddy-fails','post-switch-fails','reset-recovers','short-tail','success']) {
   const before='(up_prod-api) { reverse_proxy prod-api-blue:8080 }\n';
   await Bun.write(join(dir,'apps/api/owner'),'test');await Bun.write(join(dir,'apps/api/current'),'blue');await Bun.write(join(dir,'upstreams/api.caddy'),before);
   for(const marker of ['edge-held','observation-locked','probe-count','switched-marker','reload-times','stops','clock-skewed','short-probe','stop-after-commit','apps/api/compose.json','apps/api/green.json','apps/api/previous'])await rm(join(dir,marker),{force:true});
   const script=composeRollScript(c,{...a,preDeploy:{command:['migration'],timeoutSeconds:1},compose:{...a.compose!,gateTimeoutSeconds:60}},'blue','green',file).replaceAll('/opt/2server',dir).replaceAll('/opt/upstreams',join(dir,'upstreams')).replaceAll('/var/lock/',dir+'/');
   const stub=`
flock() {
 if [[ "$*" == *' 9' ]]; then
  if [[ "$1" == -u ]]; then rm -f '${dir}/edge-held'; else touch '${dir}/edge-held'; fi
 fi
}
sleep() {
 SECONDS=$((SECONDS + $1))
 if [[ ${scenario} == short-tail ]] && test -f '${dir}/switched-marker' && ! test -f '${dir}/clock-skewed'; then SECONDS=$((SECONDS + 4)); touch '${dir}/clock-skewed'; fi
}
timeout() {
 if [[ "$*" == *--kill-after* ]]; then shift 3; else
  if [[ ${scenario} == short-tail ]] && (( $2 < 2 )); then touch '${dir}/short-probe'; return 124; fi
  shift 2
 fi
 "$@"
}
docker() {
 case "$1" in
 inspect)
   if [[ "$*" == *com.docker.compose.project* ]]; then echo test
   elif [[ "$*" == *com.docker.compose.service* ]]; then [[ "$*" == *prod-api-blue* ]] && echo api-blue || echo api-green
   elif [[ "$*" == *State.Running* ]]; then echo false
   fi;;
 run)
   if [[ "$*" == *--entrypoint* ]]; then [[ ${scenario} != predeploy-fails ]]; return; fi
   if test -f '${dir}/switched-marker' && test -f '${dir}/edge-held'; then touch '${dir}/observation-locked'; fi
   count=$(cat '${dir}/probe-count' 2>/dev/null || echo 0); count=$((count + 1)); echo "$count" > '${dir}/probe-count'
   if [[ ${scenario} == health-fails ]] || { [[ ${scenario} == transient-ready ]] && ((count > 1)); } || { [[ ${scenario} == reset-recovers ]] && ((count == 3)); } || { [[ ${scenario} == post-switch-fails ]] && test -f '${dir}/switched-marker'; }; then echo 503; else echo 200; fi;;
 exec)
   if [[ "$*" == *'caddy validate'* ]] && [[ ${scenario} == caddy-fails ]]; then return 1; fi
   if [[ "$*" == *'caddy reload'* ]]; then touch '${dir}/switched-marker'; echo "$SECONDS" >> '${dir}/reload-times'; fi;;
 stop)
   echo "$*" >> ${JSON.stringify(join(dir,'stops'))}
   if [[ "$*" == *prod-api-blue* ]] && test "$(cat '${dir}/apps/api/current')" = green && test -f '${dir}/apps/api/green.json' && test -f '${dir}/apps/api/compose.json'; then touch '${dir}/stop-after-commit'; fi;;
 esac
 return 0
}
`;
   const p=Bun.spawn(['bash','-s'],{stdin:new Blob([stub+script]),stdout:'pipe',stderr:'pipe'});
   const [code]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);
   expect(await Bun.file(join(dir,'observation-locked')).exists()).toBe(false);
   const succeeds=['success','reset-recovers','short-tail'].includes(scenario);
   expect(code===0).toBe(succeeds);
   const route=await Bun.file(join(dir,'upstreams/api.caddy')).text();
   expect(route).toContain(succeeds?'prod-api-green:8080':'prod-api-blue:8080');
   expect(await Bun.file(join(dir,'apps/api/current')).text()).toBe(succeeds?'green':'blue');
   if(succeeds)expect(await Bun.file(join(dir,'stop-after-commit')).exists()).toBe(true);
   if(scenario==='short-tail')expect(await Bun.file(join(dir,'short-probe')).exists()).toBe(false);
   if(scenario==='transient-ready')expect(await Bun.file(join(dir,'switched-marker')).exists()).toBe(false);
   if(scenario==='post-switch-fails'){
    for(const file of ['compose.json','green.json','previous'])expect(await Bun.file(join(dir,'apps/api',file)).exists()).toBe(false);
    expect((await Bun.file(join(dir,'reload-times')).text()).trim().split('\n')).toHaveLength(2);
    expect(await Bun.file(join(dir,'stops')).text()).toContain('prod-api-green');
    expect(await Bun.file(join(dir,'stops')).text()).not.toContain('prod-api-blue');
   }
   if(scenario==='reset-recovers')expect(Number((await Bun.file(join(dir,'reload-times')).text()).trim().split('\n')[0])).toBeGreaterThanOrEqual(35);
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('source runtime replaces stale env and applies explicit resources without losing per-color public settings',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'two-source-compose-'));const original={...composeOperations};setSessionState(dir);
 try{
  const file=join(dir,'compose/api/template.json');await mkdir(join(dir,'compose/api'),{recursive:true});await Bun.write(file,JSON.stringify(template()));
  const runtime=template();delete runtime['x-2server'];for(const service of Object.values(runtime.services) as any[]){service.environment={};delete service.image;}
  runtime.services['api-green'].environment={DURABLE:'green'};
  const next=appSchema.parse({...a,image:`example/api@sha256:${'b'.repeat(64)}`,memoryMb:768,cpus:0.5,secrets:{SECRET:{provider:'vm',key:'SECRET'}},compose:{...a.compose,sourceFiles:undefined,runtime}});
  let uploaded:any, hookEnv="";
  composeOperations.upload=async(_c,files)=>{uploaded=JSON.parse(files['compose.json']);hookEnv=files['app.env']!;};composeOperations.remote=async()=>'';
  confirmComposeMigrations(true);
  await deployCompose(c,next,'NEW_PUBLIC=value\nSECRET=new-secret \n');
  const service=uploaded.services['api-green'];
  expect(service.environment).toEqual({SECRET:'new-secret ',NEW_PUBLIC:'value',DURABLE:'green'});
  expect(hookEnv).toContain('DURABLE=green\n');expect(hookEnv).toContain('SECRET=new-secret \n');
  expect(service.mem_limit).toBe('768m');expect(service.cpus).toBe(0.5);
  expect(uploaded.services['api-blue'].image).toBe(a.image);
  expect(service.image).toBe(next.image);
  if(Bun.which('docker')){
    const rendered=join(dir,'rendered-compose.json');await Bun.write(rendered,JSON.stringify(uploaded));
    await run(['docker','compose','-f',rendered,'config','--quiet']);
  }
  expect((await Bun.file(file).json())['x-2server'].specs.green.memoryMb).toBe(768);
 }finally{Object.assign(composeOperations,original);setSessionState();confirmComposeMigrations(false);await rm(dir,{recursive:true,force:true});}
});


test('readiness deadline includes a stalled Docker probe and preserves the live route',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'two-gate-deadline-'));
 try{
  await mkdir(join(dir,'apps/api'),{recursive:true});await mkdir(join(dir,'upstreams'));await mkdir(join(dir,'bin'));
  const file=join(dir,'candidate.json');await Bun.write(file,'{}');
  const route='(up_prod-api) { reverse_proxy prod-api-blue:8080 }\n';
  await Bun.write(join(dir,'apps/api/owner'),'test');await Bun.write(join(dir,'apps/api/current'),'blue');await Bun.write(join(dir,'upstreams/api.caddy'),route);
  const docker=join(dir,'bin/docker');
  await Bun.write(docker,`#!/bin/bash
case "$1" in
 inspect)
  if [[ "$*" == *com.docker.compose.project* ]]; then echo test
  elif [[ "$*" == *com.docker.compose.service* ]]; then [[ "$*" == *prod-api-blue* ]] && echo api-blue || echo api-green
  elif [[ "$*" == *State.Running* ]]; then echo false
  fi;;
 run) sleep 10; echo 200;;
 stop) echo "$*" >> "${dir}/stops";;
esac
`);await chmod(docker,0o755);
  const script=composeRollScript(c,{...a,compose:{...a.compose!,gateTimeoutSeconds:1}},'blue','green',file).replaceAll('/opt/2server',dir).replaceAll('/opt/upstreams',join(dir,'upstreams')).replaceAll('/var/lock/',dir+'/');
  const started=performance.now();
  const p=Bun.spawn(['bash','-s'],{env:{...process.env,PATH:join(dir,'bin')+':'+process.env.PATH},stdin:new Blob(['flock() { :; }\n'+script]),stdout:'pipe',stderr:'pipe'});
  const [code]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);
  expect(code).not.toBe(0);expect(performance.now()-started).toBeLessThan(4000);
  expect(await Bun.file(join(dir,'upstreams/api.caddy')).text()).toBe(route);
  expect(await Bun.file(join(dir,'apps/api/current')).text()).toBe('blue');
  expect(await Bun.file(join(dir,'stops')).text()).toContain('prod-api-green');
 }finally{await rm(dir,{recursive:true,force:true});}
},5000);


test('source port changes and rollback verify the active route using the saved generation port',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'two-port-change-'));const original={...composeOperations};setSessionState(dir);
 try{
  const file=join(dir,'compose/api/template.json');await mkdir(join(dir,'compose/api'),{recursive:true});await Bun.write(file,JSON.stringify(template()));
  const scripts:string[]=[];composeOperations.upload=async()=>{};composeOperations.remote=async(_c,script)=>{scripts.push(script);return '';};
  const next=appSchema.parse({...a,port:8090});
  await deployCompose(c,next,'');
  expect(scripts[0]).toContain("grep -F -- 'prod-api-blue:8080'");
  expect(scripts[0]).toContain('http://prod-api-green:8090/healthz');
  expect(scripts[0]).toContain('reverse_proxy prod-api-green:8090');
  const prior=await rollbackCompose(c,next);
  expect(prior.port).toBe(8080);
  expect(scripts[1]).toContain("grep -F -- 'prod-api-green:8090'");
  expect(scripts[1]).toContain('http://prod-api-blue:8080/healthz');
  expect(scripts[1]).toContain('reverse_proxy prod-api-blue:8080');
 }finally{Object.assign(composeOperations,original);setSessionState();await rm(dir,{recursive:true,force:true});}
});


test('Docker startup can exceed two seconds while HTTP health still uses the Caddy two-second limit',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'two-probe-startup-'));
 try{
  const docker=join(dir,'docker'),args=join(dir,'args');
  await Bun.write(docker,`#!/bin/bash
printf '%s\n' "$@" > '${args}'
sleep 2.2
echo 200
`);await chmod(docker,0o755);
  const probe='set -euo pipefail\nremaining=5\n'+composeProbe(c,a,'prod-api-green',true)+'\necho healthy\n';
  const start=performance.now();
  const p=Bun.spawn(['bash','-s'],{env:{...process.env,PATH:dir+':'+process.env.PATH},stdin:new Blob([probe]),stdout:'pipe',stderr:'pipe'});
  const [code,out]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);
  expect(code).toBe(0);expect(out).toContain('healthy');expect(performance.now()-start).toBeGreaterThanOrEqual(2100);
  expect((await Bun.file(args).text()).split('\n')).toContain('--max-time');
  expect(await Bun.file(args).text()).toContain('--max-time\n2\n');
 }finally{await rm(dir,{recursive:true,force:true});}
},7000);


dockerTest('pod inspection handles absent healthchecks and still enforces Compose ownership',async()=>{
 const project='two-pod-inspect-'+crypto.randomUUID().slice(0,8);
 const containers={blue:project+'-blue',green:project+'-green'};
 const app=appSchema.parse({...a,compose:{...a.compose!,project,containers}});
 try {
  const labels=(color:'blue'|'green')=>['--label','com.docker.compose.project='+project,'--label','com.docker.compose.service='+app.compose!.services[color]];
  await run(['docker','create','--name',containers.blue,...labels('blue'),'--no-healthcheck','caddy:2.10.2-alpine']);
  await run(['docker','run','-d','--name',containers.green,...labels('green'),'--health-cmd','true','--health-interval','1s','caddy:2.10.2-alpine','sh','-c','while true; do sleep 1; done']);
  for(let attempt=0;attempt<30;attempt++) {
   if((await run(['docker','inspect','-f','{{.State.Health.Status}}',containers.green])).trim()==='healthy')break;
   await Bun.sleep(200);
  }
  const query=async(value=app)=> (await run(['bash','-se'],composePods(c,value))).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const rows=await query();
  expect(rows).toHaveLength(2);
  expect(rows.find(row=>row.name==='/'+containers.blue)).toMatchObject({app:'api',status:'created',health:'none'});
  expect(rows.find(row=>row.name==='/'+containers.green)).toMatchObject({app:'api',status:'running',health:'healthy'});
  await expect(query({...app,compose:{...app.compose!,project:'foreign-owner'}})).rejects.toThrow();
  await run(['docker','rm','-f',containers.green]);
  expect(await query()).toHaveLength(1);
 } finally {
  for(const name of Object.values(containers))await run(['docker','rm','-f',name]).catch(()=>{});
 }
},30000);
