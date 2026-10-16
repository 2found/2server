import {afterEach, expect, spyOn, test} from 'bun:test';
import {chmod, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configSchema} from '../src/modules/config/application/config';
import {resolveBindings} from '../src/modules/extensions/application/bindings';
import {extensionFor,extensionSchemas} from '../src/modules/extensions/application/registry';
import {statefulFiles} from '../src/modules/extensions/application/stateful';
import {requestScript, run, transport} from '../src/modules/extensions/infrastructure/templates/cliproxy/cli';
import {parseDocument} from '../src/modules/source/application/documents';
import {templateApp} from '../src/modules/source/application/templates';
import {setVmSecrets} from '../src/shared/infrastructure/vm-secrets';

const base={version:1,name:'ai-test',ssh:{kind:'ssh',host:'unused.example',user:'operator'},edge:{mode:'managed'}};
function entry(name:string,spec:Record<string,unknown>={}){
 const d=parseDocument(templateApp(name,'cliproxy'));if(d.kind!=='Extension')throw Error();
 return {template:'cliproxy',spec:{...d.spec,...spec},secrets:d.secrets};
}
const keys={CLIPROXY_CLIENT_KEY:'synthetic-client-key-1234567890',CLIPROXY_MANAGEMENT_KEY:'synthetic-manage-key-1234567890'};
const models=[{alias:'plus',channel:'xai',name:'grok-4.6'},{alias:'plus',channel:'antigravity',name:'claude-sonnet-5-5'},
 {alias:'flash',channel:'antigravity',name:'gemini-3.8-flash',fork:true}];
afterEach(()=>setVmSecrets());

test('cliproxy renders a private, unprivileged runtime whose config carries only a hash of the management key',async()=>{
 const c=configSchema.parse({...base,extensionApps:{ai:entry('ai',{models,excludedModels:[{channel:'antigravity',pattern:'*-image*'}]})}});
 setVmSecrets({ai:keys});
 const ext=extensionFor(c,'ai')!,files=await statefulFiles(c,ext);
 const svc=JSON.parse(files['compose.json']).services['two-ai-test-ai'];
 expect(svc.image).toBe('eceasy/cli-proxy-api:v8.0.29');expect(svc.ports).toBeUndefined();
 expect(svc.user).toBe('65532:65532');expect(svc.read_only).toBe(true);expect(svc.cap_drop).toEqual(['ALL']);
 expect(svc.security_opt).toEqual(['no-new-privileges:true']);expect(svc.mem_limit).toBe('256m');expect(svc.cpus).toBe(0.5);
 expect(svc.environment).toEqual({
  TZ:'UTC',
  HOME:'/data',
  WRITABLE_PATH:'/data',
  MANAGEMENT_STATIC_PATH:'/data/static',
  GOMEMLIMIT:'204MiB',
 });
 expect(svc.volumes).toEqual(['/opt/2server/data/ai:/data','./config.yaml:/run/secrets/config.yaml:ro']);
 expect(svc.command).toEqual(['/CLIProxyAPI/CLIProxyAPI','-config','/run/secrets/config.yaml']);
 expect(svc.healthcheck.test.join(' ')).toContain('/dev/tcp/127.0.0.1/8317');
 for(const f of ['compose.json','extension.json','config.yaml'])expect(files[f]).not.toContain(keys.CLIPROXY_MANAGEMENT_KEY);
 expect(files['compose.json']+files['extension.json']).not.toContain('synthetic-');
 const config=JSON.parse(files['config.yaml']);
 expect(await Bun.password.verify(keys.CLIPROXY_MANAGEMENT_KEY,config.management['secret-key'])).toBe(true);
 expect(config.management).toMatchObject({'allow-remote':true,'disable-control-panel':false,'disable-auto-update-panel':false});
 expect(config.server['trusted-proxies']).toEqual(['127.0.0.1','10.0.0.0/8','172.16.0.0/12','192.168.0.0/16']);
 expect(config.access['api-keys']).toEqual([keys.CLIPROXY_CLIENT_KEY]);
 expect(config.oauth['model-alias']).toEqual({xai:[{name:'grok-4.6',alias:'plus'}],
  antigravity:[{name:'claude-sonnet-5-5',alias:'plus'},{name:'gemini-3.8-flash',alias:'flash',fork:true}]});
 expect(config.oauth['excluded-models']).toEqual({antigravity:['*-image*']});
 expect(config.observability.logs['request-log']).toBe(false);expect(config.plugins.enabled).toBe(false);
 expect(config.routing.cooldown).toEqual({'save-cooldown-status':true});
 expect(config.requests.streaming).toEqual({'keepalive-seconds':15,'bootstrap-retries':1});
 expect(config.server['max-request-body-bytes']).toBe(32*1024*1024);
 expect(files['verify.conf']).toContain(`Bearer ${keys.CLIPROXY_CLIENT_KEY}`);
 const ctx=ext.context!(c),host=ext.stateful!.prepareHost!(ctx),release=ext.stateful!.prepareRelease!(ctx,'/r');
 expect(host).toContain("chmod 0700 '/opt/2server/data/ai/auths' '/opt/2server/data/ai/static'");
 expect(release).toContain("chown 65532:65532 '/r/config.yaml' && chmod 0400");
 expect(release).toContain("chown 0:0 '/r/verify.conf' && chmod 0400");
 expect(ext.stateful!.verify!(ctx)).toContain('nsenter -t "$cliproxy_pid" -n curl --config "$cliproxy_release/verify.conf"');
 expect(resolveBindings(c,{AI_URL:{extension:'ai',output:'endpoint'}}).AI_URL).toBe('http://two-ai-test-ai:8317');
});

test('cliproxy rejects shared or unsafe keys and ambiguous aliases before any remote work',async()=>{
 const c=configSchema.parse({...base,extensionApps:{ai:entry('ai')}});
 setVmSecrets({other:keys});
 await expect(statefulFiles(c,extensionFor(c,'ai')!)).rejects.toThrow('secret set --app ai');
 setVmSecrets({ai:{...keys,CLIPROXY_MANAGEMENT_KEY:keys.CLIPROXY_CLIENT_KEY}});
 await expect(statefulFiles(c,extensionFor(c,'ai')!)).rejects.toThrow('must differ');
 setVmSecrets({ai:{...keys,CLIPROXY_CLIENT_KEY:'synthetic key with spaces 123'}});
 await expect(statefulFiles(c,extensionFor(c,'ai')!)).rejects.toThrow('letters, digits');
 setVmSecrets({ai:{...keys,CLIPROXY_MANAGEMENT_KEY:'k'.repeat(73)}});
 await expect(statefulFiles(c,extensionFor(c,'ai')!)).rejects.toThrow('20-72');
 const desired=entry('ai');
 expect(()=>configSchema.parse({...base,extensionApps:{ai:{...desired,spec:{...desired.spec,clientKeyEnv:['CLIPROXY_MANAGEMENT_KEY']}}}})).toThrow('Invalid template spec');
 const issues=(spec:Record<string,unknown>)=>JSON.stringify(extensionSchemas.cliproxy.safeParse({...desired.spec,...spec}).error?.issues);
 expect(issues({clientKeyEnv:['CLIPROXY_MANAGEMENT_KEY']})).toContain('managementKeyEnv must not');
 expect(issues({models:[models[0],{...models[0],name:'grok-x'}]})).toContain('declared twice');
 expect(()=>configSchema.parse({...base,extensionApps:{ai:{...desired,spec:{...desired.spec,models:[{alias:'x',channel:'openai',name:'y'}]}}}})).toThrow();
});

test('cliproxy commands reach the loopback management API with the key on stdin and validate input locally',async()=>{
 const c=configSchema.parse({...base,extensionApps:{ai:entry('ai')}});
 setVmSecrets({ai:keys});
 const ctx=extensionFor(c,'ai')!.context!(c);
 const script=requestScript(ctx,'PATCH','/v0/management/auth-files/status',true,true);
 expect(script).toContain('exec 7>/var/lock/2server-extension-ai.lock');
 expect(script).toContain("docker inspect -f '{{.State.Pid}}' 'two-ai-test-ai'");
 expect(script).toContain("'http://127.0.0.1:8317/v0/management/auth-files/status'");
 expect(script).not.toContain('synthetic-');
 expect(requestScript(ctx,'GET','/v1/models',false,false)).not.toContain('flock');
 expect(()=>requestScript(ctx,'GET','/x; reboot',false,false)).toThrow('Unsupported request path');

 const calls:Array<{key:string;method:string;path:string;body?:unknown;mutate?:boolean}>=[];
 const files=[{name:'xai-a.json',provider:'xai',label:'a',status:'active',access_token:'secret-token',disabled:false,priority:-10},
  {name:'ag-b.json',provider:'antigravity',status:'active',priority:0}];
 const request=spyOn(transport,'request').mockImplementation(async(_c,key,method,path,body,mutate)=>{
  calls.push({key,method,path,body,mutate});
  if(path==='/v0/management/auth-files'&&method==='GET')return {status:200,body:{files}};
  if(path==='/v1/models')return {status:200,body:{data:[{id:'plus'},{id:'flash'}]}};
  return {status:200,body:{status:'ok'}};
 });
 const log=spyOn(console,'log').mockImplementation(()=>{});
 try {
  await run(ctx,'accounts',[]);
  expect(log.mock.calls.at(-1)![0]).not.toContain('secret-token');
  const listed=JSON.parse(log.mock.calls.at(-1)![0]);
  expect(listed[0]).toMatchObject({name:'xai-a.json',provider:'xai',disabled:false,priority:-10});
  expect(listed[1]).not.toHaveProperty('priority');
  await run(ctx,'models',[]);
  expect(JSON.parse(log.mock.calls.at(-1)![0])).toEqual(['flash','plus']);
  expect(calls.at(-1)!.key).toBe(keys.CLIPROXY_CLIENT_KEY);
  await run(ctx,'disable',['xai-a.json']);
  expect(calls.at(-1)!.method).toBe('GET');
  await run(ctx,'disable',['xai-a.json','--apply']);
  expect(calls.at(-1)).toMatchObject({key:keys.CLIPROXY_MANAGEMENT_KEY,method:'PATCH',path:'/v0/management/auth-files/status',body:{name:'xai-a.json',disabled:true},mutate:true});
  await run(ctx,'priority',['xai-a.json','-10']);
  expect(calls.at(-1)!.method).toBe('GET');
  await run(ctx,'priority',['xai-a.json','-10','--apply']);
  expect(calls.at(-1)).toMatchObject({key:keys.CLIPROXY_MANAGEMENT_KEY,method:'PATCH',path:'/v0/management/auth-files/fields',body:{name:'xai-a.json',priority:-10},mutate:true});
  for(const bad of [['xai-a.json'],['xai-a.json','high'],['xai-a.json','1.5'],['xai-a.json','100000'],['--x','1'],['xai-a.json','1','2']])
   await expect(run(ctx,'priority',bad)).rejects.toThrow('PRIORITY an integer');
  await expect(run(ctx,'priority',['missing.json','5','--apply'])).rejects.toThrow('not found');
  await run(ctx,'remove',['xai-a.json','--apply']);
  expect(calls.at(-1)).toMatchObject({method:'DELETE',body:{name:'xai-a.json'}});
  await expect(run(ctx,'enable',['missing.json','--apply'])).rejects.toThrow('not found');
  await expect(run(ctx,'enable',['../x'])).rejects.toThrow('.json');
  await expect(run(ctx,'login',['gemini','--apply'])).rejects.toThrow('Unsupported provider');
  await expect(run(ctx,'accounts',['extra'])).rejects.toThrow('Use app ai accounts');

  const dir=await mkdtemp(join(tmpdir(),'cliproxy-')),file=join(dir,'codex-a.json');
  try {
   await writeFile(file,JSON.stringify({type:'codex',refresh_token:'r'}));await chmod(file,0o644);
   await expect(run(ctx,'import',['--file',file,'--apply'])).rejects.toThrow('chmod 600');
   await chmod(file,0o600);
   const before=calls.length;await run(ctx,'import',['--file',file]);expect(calls.length).toBe(before);
   await run(ctx,'import',['--file',file,'--apply']);
   expect(calls.at(-1)).toMatchObject({method:'POST',path:'/v0/management/auth-files?name=codex-a.json',mutate:true});
   await writeFile(file,'[1]');
   await expect(run(ctx,'import',['--file',file,'--apply'])).rejects.toThrow('provider "type"');
  } finally {await rm(dir,{recursive:true,force:true});}

  request.mockImplementation(async()=>({status:401,body:{error:'invalid management key'}}));
  await expect(run(ctx,'accounts',[])).rejects.toThrow('redeploy app ai');
 } finally {request.mockRestore();log.mockRestore();}
});

test('device-flow login polls until the runtime stores the account',async()=>{
 const c=configSchema.parse({...base,extensionApps:{ai:entry('ai')}});
 setVmSecrets({ai:keys});
 const ctx=extensionFor(c,'ai')!.context!(c);
 let polls=0;const paths:string[]=[];
 const request=spyOn(transport,'request').mockImplementation(async(_c,_k,_m,path)=>{
  paths.push(path);
  if(path.endsWith('/xai-auth-url'))return {status:200,body:{status:'ok',url:'https://accounts.x.ai/oauth2/device',state:'s1',user_code:'ABCD'}};
  if(path.includes('get-auth-status'))return {status:200,body:{status:++polls<3?'wait':'ok'}};
  return {status:200,body:{files:[{name:'xai-b.json',provider:'xai',status:'active'}]}};
 });
 const sleep=spyOn(transport,'sleep').mockImplementation(async()=>{});
 const log=spyOn(console,'log').mockImplementation(()=>{}),err=spyOn(console,'error').mockImplementation(()=>{});
 try {
  await run(ctx,'login',['xai']);expect(paths).toEqual([]);
  await run(ctx,'login',['xai','--apply']);
  expect(polls).toBe(3);expect(paths).not.toContain('/v0/management/oauth-callback');
  expect(err.mock.calls.flat().join('\n')).toContain('ABCD');
  expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({status:'signed-in',accounts:[{name:'xai-b.json'}]});
 } finally {request.mockRestore();sleep.mockRestore();log.mockRestore();err.mockRestore();}
});

test('redirect-flow login captures the browser callback locally and forwards it to the runtime',async()=>{
 const c=configSchema.parse({...base,extensionApps:{ai:entry('ai')}});
 setVmSecrets({ai:keys});
 const ctx=extensionFor(c,'ai')!.context!(c),port=40000+Math.floor(Math.random()*20000);
 const redirect=encodeURIComponent(`http://localhost:${port}/auth/callback`);
 const calls:Array<{path:string;body?:unknown}>=[];
 const request=spyOn(transport,'request').mockImplementation(async(_c,_k,_m,path,body)=>{
  calls.push({path,body});
  if(path.endsWith('/codex-auth-url')){
   setTimeout(async()=>{
    expect((await fetch(`http://127.0.0.1:${port}/elsewhere?state=s2`)).status).toBe(404);
    expect(await (await fetch(`http://127.0.0.1:${port}/auth/callback?code=c1&state=s2`)).text()).toContain("close this tab");
   },50);
   return {status:200,body:{status:'ok',url:`https://auth.example/authorize?redirect_uri=${redirect}&state=s2`,state:'s2'}};
  }
  if(path.includes('get-auth-status'))return {status:200,body:{status:'error',error:'token exchange failed'}};
  return {status:200,body:{status:'ok'}};
 });
 const err=spyOn(console,'error').mockImplementation(()=>{});
 try {
  await expect(run(ctx,'login',['codex','--apply'])).rejects.toThrow('Sign-in failed: token exchange failed');
  expect(calls.find(x=>x.path==='/v0/management/oauth-callback')!.body).toEqual({redirect_url:`http://localhost:${port}/auth/callback?code=c1&state=s2`});
  await expect(fetch(`http://127.0.0.1:${port}/auth/callback?state=s2`)).rejects.toThrow();
 } finally {request.mockRestore();err.mockRestore();}
});

test('quota and reset-quota commands probe live upstream quotas via /api-call ($TOKEN$) and clear cooldown latches',async()=>{
 const c=configSchema.parse({...base,extensionApps:{ai:entry('ai')}});
 setVmSecrets({ai:keys});
 const ctx=extensionFor(c,'ai')!.context!(c);
 const calls:Array<{method:string;path:string;body?:unknown;mutate?:boolean}>=[];
 const files=[
  {name:'ag-ready.json',provider:'antigravity',label:'ready@example.com',status:'active',auth_index:'idx_ag1',project_id:'proj-1',
   access_token:'secret-ag-1',runtime_only:{requests:{success:120,failed:2},quota:{cooldowns:[{model_key:'claude-opus-5-5-high',reason:'quota',remaining_seconds:3600,retry_at:'2026-10-17T00:00:00Z'}]}}
  },
  {name:'ag-verify.json',provider:'antigravity',label:'verify@example.com',status:'active',auth_index:'idx_ag2',project_id:'proj-2',access_token:'secret-ag-2'},
  {name:'codex-free.json',provider:'codex',label:'codex@example.com',status:'active',auth_index:'idx_cx1',id_token:{chatgpt_account_id:'acc-cx1'},access_token:'secret-cx-1'},
 ];
 const request=spyOn(transport,'request').mockImplementation(async(_c,_k,method,path,body,mutate)=>{
  calls.push({method,path,body,mutate});
  if(path==='/v0/management/auth-files'&&method==='GET')return {status:200,body:{files}};
  if(path==='/v0/management/api-call'&&method==='POST'){
   const b=body as {auth_index?:string;url?:string;header?:Record<string,string>};
   expect(b.header?.Authorization).toBe('Bearer $TOKEN$');
   if(b.auth_index==='idx_ag1'){
    return {status:200,body:{status_code:200,body:JSON.stringify({models:{
     'gemini-3.8-flash-high':{displayName:'Gemini 3.8 Flash',quotaInfo:{remainingFraction:0.6874,resetTime:'2026-10-16T04:41:19Z'}},
     'claude-sonnet-5-5-high':{displayName:'Claude Sonnet 5.5',quotaInfo:{remainingFraction:0.207,resetTime:'2026-10-21T17:06:22Z'}},
    }})}};
   }
   if(b.auth_index==='idx_ag2'){
    return {status:200,body:{status_code:403,body:JSON.stringify({error:{
     code:403,message:'Verify your account to continue.',
     details:[{reason:'VALIDATION_REQUIRED',metadata:{validation_url:'https://accounts.google.com/v3/signin/continue?id=verify'}}]
    }})}};
   }
   if(b.auth_index==='idx_cx1'){
    expect(b.header?.['Chatgpt-Account-Id']).toBe('acc-cx1');
    return {status:200,body:{status_code:200,body:JSON.stringify({
     plan_type:'free',rate_limit:{primary_window:{used_percent:17,reset_at:1792131886}}
    })}};
   }
  }
  if(path==='/v0/management/reset-quota'&&method==='POST')return {status:200,body:{status:'ok'}};
  return {status:200,body:{status:'ok'}};
 });
 const log=spyOn(console,'log').mockImplementation(()=>{});
 try {
  await run(ctx,'accounts',[]);
  const listed=JSON.parse(log.mock.calls.at(-1)![0]);
  expect(listed[0]).toMatchObject({
   name:'ag-ready.json',success:120,failed:2,
   cooldowns:[{model:'claude-opus-5-5-high',reason:'quota',remainingSeconds:3600,retryAt:'2026-10-17T00:00:00Z'}]
  });
  expect(JSON.stringify(listed)).not.toContain('secret-ag-1');

  await run(ctx,'quota',[]);
  const quotas=JSON.parse(log.mock.calls.at(-1)![0]);
  expect(quotas).toHaveLength(3);
  expect(quotas[0].quotas).toEqual([
   {model:'gemini-3.8-flash-high',label:'Gemini 3.8 Flash',remainingPercent:68.7,resetTime:'2026-10-16T04:41:19Z'},
   {model:'claude-sonnet-5-5-high',label:'Claude Sonnet 5.5',remainingPercent:20.7,resetTime:'2026-10-21T17:06:22Z'},
  ]);
  expect(quotas[1]).toMatchObject({
   name:'ag-verify.json',
   validationUrl:'https://accounts.google.com/v3/signin/continue?id=verify',
   error:'Google account verification required (403)',
  });
  expect(quotas[2]).toMatchObject({
   name:'codex-free.json',planType:'free',
   quotas:[{model:'codex-primary',label:'Codex Primary Window (free)',remainingPercent:83}],
  });

  await run(ctx,'quota',['codex-free.json']);
  expect(JSON.parse(log.mock.calls.at(-1)![0])).toHaveLength(1);
  await expect(run(ctx,'quota',['missing.json'])).rejects.toThrow('not found');
  await expect(run(ctx,'quota',['--bad'])).rejects.toThrow('Use app ai quota');

  const beforeReset=calls.filter(x=>x.path==='/v0/management/reset-quota').length;
  await run(ctx,'reset-quota',['ag-ready.json']);
  expect(calls.filter(x=>x.path==='/v0/management/reset-quota').length).toBe(beforeReset);
  await run(ctx,'reset-quota',['--all','--apply']);
  expect(calls.at(-1)).toMatchObject({method:'POST',path:'/v0/management/reset-quota',body:{auth_index:'idx_ag1'},mutate:true});
  expect(JSON.parse(log.mock.calls.at(-1)![0])).toEqual({status:'reset',accounts:['ag-ready.json']});
  await expect(run(ctx,'reset-quota',[])).rejects.toThrow('Use app ai reset-quota');
 } finally {request.mockRestore();log.mockRestore();}
});
test('accounts keep files whose cooldowns are null and quota isolates a failed probe',async()=>{
 const c=configSchema.parse({...base,extensionApps:{ai:entry('ai')}});
 setVmSecrets({ai:keys});
 const ctx=extensionFor(c,'ai')!.context!(c);
 const files=[
  {name:'ag-null.json',provider:'antigravity',status:'active',auth_index:'idx_n1',cooldowns:null,access_token:'secret-n'},
  {name:'ag-ok.json',provider:'antigravity',status:'active',auth_index:'idx_ok',project_id:'p'},
  {name:'disk-only.json',provider:'xai',status:'active',cooldowns:[{reason:'quota'}]},
 ];
 const request=spyOn(transport,'request').mockImplementation(async(_c,_k,method,path,body)=>{
  if(path==='/v0/management/auth-files'&&method==='GET')return {status:200,body:{files}};
  if(path==='/v0/management/api-call'&&method==='POST'){
   const b=body as {auth_index?:string};
   if(b.auth_index==='idx_n1')return {status:502,body:{error:'upstream'}};
   if(b.auth_index==='idx_ok')return {status:200,body:{status_code:200,body:JSON.stringify({models:{
    'gemini-3.8-flash-high':{quotaInfo:{remainingFraction:1}},
   }})}};
  }
  if(path==='/v0/management/reset-quota')return {status:200,body:{status:'ok'}};
  return {status:200,body:{status:'ok'}};
 });
 const log=spyOn(console,'log').mockImplementation(()=>{});
 try {
  await run(ctx,'accounts',[]);
  const listed=JSON.parse(log.mock.calls.at(-1)![0]);
  expect(listed.map((a:{name:string})=>a.name)).toEqual(['ag-null.json','ag-ok.json','disk-only.json']);
  expect(JSON.stringify(listed)).not.toContain('secret-n');

  await run(ctx,'quota',[]);
  const quotas=JSON.parse(log.mock.calls.at(-1)![0]);
  expect(quotas).toHaveLength(3);
  expect(quotas[0]).toMatchObject({name:'ag-null.json',error:'cliproxy answered 502: upstream'});
  expect(quotas[1].quotas).toEqual([{model:'gemini-3.8-flash-high',label:'Gemini 3.8 Flash',remainingPercent:100}]);

  await run(ctx,'reset-quota',['disk-only.json','--apply']);
  expect(JSON.parse(log.mock.calls.at(-1)![0])).toEqual({status:'reset',accounts:[]});
  await run(ctx,'reset-quota',['--all','--apply']);
  expect(JSON.parse(log.mock.calls.at(-1)![0])).toEqual({status:'reset',accounts:[]});
 } finally {request.mockRestore();log.mockRestore();}
});

test('models lists string ids even when a sibling entry has a null id',async()=>{
 const c=configSchema.parse({...base,extensionApps:{ai:entry('ai')}});
 setVmSecrets({ai:keys});
 const ctx=extensionFor(c,'ai')!.context!(c);
 const request=spyOn(transport,'request').mockImplementation(async()=>({status:200,body:{data:[{id:'plus'},{id:null},{id:'flash'}]}}));
 const log=spyOn(console,'log').mockImplementation(()=>{});
 try {
  await run(ctx,'models',[]);
  expect(JSON.parse(log.mock.calls.at(-1)![0])).toEqual(['flash','plus']);
 } finally {request.mockRestore();log.mockRestore();}
});

