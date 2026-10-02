import { test, expect } from 'bun:test';
import { mkdtemp, rm, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appSchema,configSchema } from '../src/config';
import { validateTemplate,renderCompose,composeRollScript,adoptCompose,composeOperations,deployCompose,confirmComposeMigrations } from '../src/compose-apps';
import { setSessionState } from '../src/operator-state';
import { parseResource,resourceCommand } from '../src/resources';
import { run } from '../src/process';
const c=configSchema.parse({version:1,name:'test',ssh:{kind:'ssh',host:'example.com',user:'ops'},edge:{mode:'managed'}});
const a=appSchema.parse({name:'api',image:`example/api@sha256:${'a'.repeat(64)}`,port:8080,memoryMb:512,cpus:1,compose:{project:'test',services:{blue:'api-blue',green:'api-green'},containers:{blue:'prod-api-blue',green:'prod-api-green'},upstreamFile:'/opt/upstreams/api.caddy',upstreamName:'up_prod-api',sourceFiles:['/original/compose.yml'],migrationRequired:true}});
function template():any {return {name:'test',services:{'api-blue':{image:a.image,container_name:'prod-api-blue',environment:{SECRET:'literal-$test'},networks:{edge:null}},'api-green':{image:a.image,container_name:'prod-api-green',networks:{edge:null}}},networks:{edge:{external:true,name:'edge'}},'x-2server':{owner:'test',app:'api',current:'blue',previous:'',specs:{blue:a}}};}
test('Compose contracts preserve isolated generations and reject host access/shared writers',()=>{
  expect(()=>validateTemplate(template(),a)).not.toThrow();
  for(const edit of [(t:any)=>t.services['api-blue'].privileged=true,(t:any)=>t.services['api-green'].ports=['80:80'],(t:any)=>t.services['api-green'].volumes=[{type:'bind',source:'/',target:'/host'}],(t:any)=>{t.volumes={data:{name:'data',external:true}};for(const s of Object.values(t.services) as any[])s.volumes=[{type:'volume',source:'data',target:'/data'}];}]) {const t=template();edit(t);expect(()=>validateTemplate(t,a)).toThrow();}
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
  confirmComposeMigrations(true);
  await deployCompose(c,{...adopted,image:`example/api@sha256:${'b'.repeat(64)}`},'');
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
  for(const scenario of ['health-fails','caddy-fails','success']) {
   const before='(up_prod-api) { reverse_proxy prod-api-blue:8080 }\n';
   await Bun.write(join(dir,'apps/api/owner'),'test');await Bun.write(join(dir,'apps/api/current'),'blue');await Bun.write(join(dir,'upstreams/api.caddy'),before);
   const script=composeRollScript(c,a,'blue','green',file).replaceAll('/opt/2server',dir).replaceAll('/opt/upstreams',join(dir,'upstreams')).replaceAll('/var/lock/',dir+'/');
   const stub=`
flock() { :; }
sleep() { :; }
docker() {
 case "$1" in
 inspect)
   if [[ "$*" == *com.docker.compose.project* ]]; then echo test
   elif [[ "$*" == *com.docker.compose.service* ]]; then [[ "$*" == *prod-api-blue* ]] && echo api-blue || echo api-green
   elif [[ "$*" == *State.Running* ]]; then echo false
   fi;;
 run) echo ${scenario==='health-fails'?'503':'200'};;
 exec) if [[ "$*" == *'caddy validate'* ]] && [[ ${scenario} == caddy-fails ]]; then return 1; fi;;
 stop) echo "$*" >> ${JSON.stringify(join(dir,'stops'))};;
 esac
 return 0
}
`;
   const p=Bun.spawn(['bash','-s'],{stdin:new Blob([stub+script]),stdout:'pipe',stderr:'pipe'});
   const [code]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);
   expect(code===0).toBe(scenario==='success');
   const route=await Bun.file(join(dir,'upstreams/api.caddy')).text();
   expect(route).toContain(scenario==='success'?'prod-api-green:8080':'prod-api-blue:8080');
   expect(await Bun.file(join(dir,'apps/api/current')).text()).toBe(scenario==='success'?'green':'blue');
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});
