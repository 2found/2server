import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {appSchema,configSchema} from '../src/config';
import {preDeployScript} from '../src/pre-deploy';
import {deployScript} from '../src/apps';
import {run} from '../src/process';
const c=configSchema.parse({version:1,name:'test',ssh:{kind:'ssh',host:'example.com',user:'ops'},edge:{mode:'managed'}});
const a=appSchema.parse({name:'api',image:'example/api@sha256:'+'a'.repeat(64),port:8080,memoryMb:512,cpus:1,preDeploy:{command:['bun','run','scripts/migrate.ts'],timeoutSeconds:1}});
test('preDeploy validates command and deadline; native rollout runs it before stopping workers',async()=>{
 for(const preDeploy of [{command:[]},{command:['']},{command:['bad\0command']},{command:['migrate'],timeoutSeconds:0},{command:['migrate'],privileged:true}])expect(()=>appSchema.parse({...a,preDeploy})).toThrow();
 const script=deployScript(c,{...a,kind:'worker'},'release');
 expect(script.indexOf('Running preDeploy')).toBeLessThan(script.indexOf('then stop_generation'));
 expect(script).toContain('--entrypoint \'bun\'');
 expect(preDeployScript(c,{...a,replicas:0},'/private/app.env')).toBe('');
 await run(['bash','-n'],script);
});
test('hook success, failure and timeout clean container; failure blocks continuation and output stays private',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pre-deploy-'));
 try{
  await mkdir(join(dir,'bin'));
  const docker=join(dir,'bin/docker');
  await Bun.write(docker,`#!/bin/bash
if [ "$1" = rm ]; then echo cleanup >> "$CALLS"; exit 0; fi
echo run >> "$CALLS"
echo private-secret
case "$CASE" in fail) exit 7;; timeout) sleep 10;; esac
`);await Bun.$`chmod 755 ${docker}`.quiet();
  for(const scenario of ['success','fail','timeout']){
   const calls=join(dir,'calls-'+scenario);
   const script='set -Eeuo pipefail\n'+preDeployScript(c,a,join(dir,'app.env'))+'echo continued\n';
   const start=Date.now();
   const p=Bun.spawn(['bash','-s'],{stdin:new Blob([script]),env:{...process.env,PATH:join(dir,'bin')+':'+process.env.PATH,CASE:scenario,CALLS:calls},stdout:'pipe',stderr:'pipe'});
   const [code,out,err]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);
   expect(code===0).toBe(scenario==='success');expect(out.includes('continued')).toBe(scenario==='success');
   expect(out+err).not.toContain('private-secret');expect(await Bun.file(calls).text()).toBe('run\ncleanup\n');
   expect((await stat(join(dir,'pre-deploy.log'))).mode&0o777).toBe(0o600);
   if(scenario==='timeout')expect(Date.now()-start).toBeLessThan(5000);
  }
 }finally{await rm(dir,{recursive:true,force:true});}
},15000);
