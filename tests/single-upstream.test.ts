import { expect,test } from 'bun:test';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appSchema } from '../src/modules/apps/domain/schema';
import { composeUpstreamSnippet } from '../src/modules/apps/infrastructure/compose';
import { upstreamSnippet } from '../src/modules/apps/infrastructure/runtime';
import { run } from '../src/shared/infrastructure/process';
const app=appSchema.parse({name:'api',image:'example/api@sha256:'+'a'.repeat(64),port:8080,memoryMb:64,cpus:1,compose:{project:'test',services:{blue:'api-blue',green:'api-green'},containers:{blue:'api-blue',green:'api-green'},upstreamFile:'/opt/upstreams/api.caddy',upstreamName:'up_api'}});
test('passive eviction requires alternative serving peers, including blue/green Compose',()=>{
 for(const snippet of [upstreamSnippet(app,['api-blue']),composeUpstreamSnippet(app,'api-blue')]) {
  expect(snippet).not.toContain('fail_duration');expect(snippet).not.toContain('max_fails');
  expect(snippet).toContain('health_fails 2');expect(snippet).toContain('health_timeout 2s');
 }
 expect(upstreamSnippet(app,['api-blue','api-blue-2'])).toContain('fail_duration 10s');
 expect(upstreamSnippet(app,['api-blue','api-blue-2'])).toContain('max_fails 1');
 expect(upstreamSnippet(app,[])).toContain('Service scaled to zero');
});
const integration=process.env.DOCKER_TESTS==='1'?test:test.skip;
for(const mode of ['native','compose'] as const) integration(`real Caddy singleton ${mode}: transport error stays local to request; active health still gates traffic`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'two-single-'));const name='two-single-'+crypto.randomUUID();let unready=false,writes=0;
 const backend=Bun.listen({hostname:'0.0.0.0',port:0,socket:{data(socket,data){
  const path=Buffer.from(data).toString().split(' ')[1];
  if(path==='/write'){writes++;socket.end();return;}
  const status=path==='/healthz'&&unready?'503 Unavailable':'200 OK';
  socket.end(`HTTP/1.1 ${status}\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK`);
 },drain(){}}});
 try {
  const a={...app,port:backend.port};const snippet=mode==='native'?upstreamSnippet(a,['host.docker.internal']):composeUpstreamSnippet(a,'host.docker.internal');
  const file=join(dir,'Caddyfile');await Bun.write(file,`{\n admin off\n}\n${snippet}\n:8080 {\n import ${mode==='native'?'up_two_api':'up_api'}\n}\n`);
  await run(['docker','run','-d','--name',name,...(process.platform==='linux'?['--add-host','host.docker.internal:host-gateway']:[]),'-p','127.0.0.1::8080','-v',file+':/etc/caddy/Caddyfile:ro','caddy:2.11.4-alpine']);
  const base='http://'+(await run(['docker','port',name,'8080/tcp'])).trim();
  const request=()=>fetch(base,{signal:AbortSignal.timeout(5000)});
  async function until(status:number,timeout:number){const deadline=Date.now()+timeout;do{try{if((await request()).status===status)return;}catch{}await Bun.sleep(100);}while(Date.now()<deadline);throw Error(`Caddy did not return ${status}`);}
  await until(200,10000);
  expect((await fetch(base+'/write',{method:'POST',body:'one side effect',signal:AbortSignal.timeout(5000)})).status).toBe(502);
  expect(writes).toBe(1); // Never replay a failed mutation.
  expect((await request()).status).toBe(200); // No passive quarantine for the sole peer.
  unready=true;await until(503,15000);
  unready=false;await until(200,15000);
 }finally{await run(['docker','rm','-f',name]).catch(()=>{});backend.stop(true);await rm(dir,{recursive:true,force:true});}
},50000);
