import {afterEach, beforeEach, expect, test} from 'bun:test';
import {mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configSchema} from '../src/modules/config/application/config';
import {extensionFor,extensionSchemas} from '../src/modules/extensions/application/registry';
import {deployStateful,statefulFiles} from '../src/modules/extensions/application/stateful';
import {quotaAlertConfig} from '../src/modules/extensions/infrastructure/templates/cliproxy/quota-alert';
import {type Account,type Config as Cfg,type State,accounts,code,cycle,evaluate,targets} from '../src/modules/extensions/infrastructure/templates/cliproxy/quota-alert.runtime';
import {parseDocument} from '../src/modules/source/application/documents';
import {templateApp} from '../src/modules/source/application/templates';
import {setVmSecrets} from '../src/shared/infrastructure/vm-secrets';

const base={version:1,name:'ai-test',ssh:{kind:'ssh',host:'unused.example',user:'operator'},edge:{mode:'managed'}};
const keys={CLIPROXY_CLIENT_KEY:'synthetic-client-key-1234567890',CLIPROXY_MANAGEMENT_KEY:'synthetic-manage-key-1234567890'};
const HOOK='https://discord.com/api/webhooks/123456789012345678/SYNTHETIC_webhook_token_0123456789abcdef';
const secrets={...keys,DISCORD_ALERTS_WEBHOOK_URL:HOOK};
const alert={webhookEnv:'DISCORD_ALERTS_WEBHOOK_URL',models:['gemini-3.8-flash-high'],thresholdPercent:10,intervalMinutes:5,repageMinutes:120};
const SIDECAR='two-ai-test-ai-quota-alert';
function entry(spec:Record<string,unknown>={}){
 const d=parseDocument(templateApp('ai','cliproxy'));if(d.kind!=='Extension')throw Error();
 return {template:'cliproxy',spec:{...d.spec,...spec},secrets:{...d.secrets,DISCORD_ALERTS_WEBHOOK_URL:{provider:'vm' as const,key:'DISCORD_ALERTS_WEBHOOK_URL'}}};
}
const config=(spec:Record<string,unknown>={})=>configSchema.parse({...base,extensionApps:{ai:entry(spec)}});
afterEach(()=>setVmSecrets());
type Service=Record<string,unknown>&{volumes:string[];environment:Record<string,string>};
const compose=(files:Record<string,string>)=>JSON.parse(files['compose.json']) as {services:Record<string,Service>};

test('quotaAlert is opt-in, validated against the secrets and the models quota can report',()=>{
 const c=config();expect(c.extensionApps.ai.spec.quotaAlert).toBeUndefined();
 const on=config({quotaAlert:{webhookEnv:'DISCORD_ALERTS_WEBHOOK_URL'}}).extensionApps.ai.spec.quotaAlert;
 expect(on).toMatchObject({webhookEnv:'DISCORD_ALERTS_WEBHOOK_URL',thresholdPercent:10,intervalMinutes:5,repageMinutes:120});
 expect((on as {image?:string}).image).toMatch(/^oven\/bun:[0-9.]+-distroless@sha256:[a-f0-9]{64}$/);
 const desired=entry();
 const issues=(q:Record<string,unknown>)=>JSON.stringify(extensionSchemas.cliproxy.safeParse({...desired.spec,quotaAlert:q}).error?.issues);
 expect(issues(alert)).toBeUndefined();
 expect(issues({webhookEnv:'CLIPROXY_MANAGEMENT_KEY'})).toContain('its own secret');
 expect(issues({webhookEnv:'AI_KEY'})).toBeUndefined();
 expect(issues({...alert,models:['gemini-9']})).toContain('has no quota data');
 expect(issues({...alert,intervalMinutes:30,repageMinutes:10})).toContain('must not be shorter');
 // An image must be pinned by digest: a moved tag cannot swap the program's runtime.
 for(const bad of [{},{webhookEnv:'lower'},{...alert,thresholdPercent:101},{...alert,thresholdPercent:-1},{...alert,intervalMinutes:0},
  {...alert,models:[]},{...alert,models:['codex-primary','codex-primary']},{...alert,webhook:'https://x'},
  {...alert,image:'oven/bun:1-distroless'},{...alert,image:'oven/bun:latest; rm -rf /'}])
  expect(extensionSchemas.cliproxy.safeParse({...desired.spec,quotaAlert:bad}).success).toBe(false);
});

test('quotaAlert is a hardened sidecar container: nothing runs on the host, the secrets reach only its own uid',async()=>{
 const c=config({quotaAlert:alert});setVmSecrets({ai:secrets});
 const ext=extensionFor(c,'ai')!,files=await statefulFiles(c,ext),ctx=ext.context!(c);
 const services=compose(files).services,s=services[SIDECAR],gateway=services['two-ai-test-ai'];
 expect(Object.keys(services).sort()).toEqual(['two-ai-test-ai',SIDECAR]);
 expect(s).toMatchObject({container_name:SIDECAR,user:'65533:65533',read_only:true,cap_drop:['ALL'],security_opt:['no-new-privileges:true'],
  restart:'unless-stopped',mem_limit:'128m',pids_limit:64,networks:gateway.networks,
  labels:{'io.2server.owner':'ai-test','io.2server.extension':'ai','io.2server.app':'ai'},
  entrypoint:['/usr/local/bin/bun'],command:['/opt/quota-alert/quota-alert.ts']});
 expect(s.image).toBe((c.extensionApps.ai.spec.quotaAlert as {image:string}).image);
 for(const k of ['ports','privileged','pid','network_mode','cap_add','devices'])expect(s[k]).toBeUndefined();
 // Only its own files and its state directory; never the gateway's data or the docker socket.
 expect(s.volumes).toEqual(['./quota-alert.ts:/opt/quota-alert/quota-alert.ts:ro','./quota-alert.json:/etc/quota-alert/config.json:ro',
  './quota-alert.secrets.json:/run/secrets/quota-alert.json:ro','/opt/2server/extensions/ai/quota-alert.d:/state']);
 expect(gateway.user).toBe('65532:65532');
 expect(gateway.volumes.join(' ')).not.toContain('quota-alert');
 expect(JSON.parse(files['quota-alert.json'])).toMatchObject({app:'ai',baseUrl:'http://two-ai-test-ai:8317/v0/management',
  models:['gemini-3.8-flash-high'],thresholdPercent:10,repageSeconds:7200,intervalSeconds:300,gatewayFailures:3});
 expect(files['quota-alert.ts']).toBe(await readFile(join(import.meta.dir,'../src/modules/extensions/infrastructure/templates/cliproxy/quota-alert.runtime.ts'),'utf8'));
 expect(JSON.parse(files['quota-alert.secrets.json'])).toEqual({managementKey:keys.CLIPROXY_MANAGEMENT_KEY,webhookUrl:HOOK});
 for(const [name,body] of Object.entries(files))if(!['quota-alert.secrets.json','verify.conf','config.yaml'].includes(name)){
  expect(body).not.toContain('SYNTHETIC_webhook');expect(body).not.toContain(keys.CLIPROXY_MANAGEMENT_KEY);
 }
 const release=ext.stateful!.prepareRelease!(ctx,'/r');
 expect(release).toContain("chown 65533:65533 '/r/quota-alert.secrets.json' && chmod 0400 '/r/quota-alert.secrets.json'");
 expect(release).toContain("chown 0:0 '/r/quota-alert.ts' '/r/quota-alert.json' && chmod 0444");
 // Host side: only ownership of the state directory, and never through a link.
 const host=ext.stateful!.prepareHost!(ctx);
 expect(host).toContain("install -d -m 700 '/opt/2server/extensions/ai/quota-alert.d'");
 expect(host).toContain("chown -h 65533:65533 '/opt/2server/extensions/ai/quota-alert.d/state.json'");
 expect(host).not.toMatch(/chown (?!-h)[^\n]*quota-alert\.d/);
 expect(host).not.toMatch(/systemctl (enable|start|restart)|install -m 644/);
 expect(ext.stateful!.postInstall).toBeUndefined();
});

test('every deploy and removal deletes the legacy host timer; without quotaAlert there is no sidecar',async()=>{
 const legacy=['systemctl disable --now two-ai-test-ai-quota-alert.timer','rm -f /etc/systemd/system/two-ai-test-ai-quota-alert.service /etc/systemd/system/two-ai-test-ai-quota-alert.timer',
  "rm -f '/opt/2server/metrics/ai-quota-alert.prom' '/var/lock/2server-ai-quota-alert.lock'"];
 for(const spec of [{},{quotaAlert:alert}]){
  const c=config(spec);setVmSecrets({ai:secrets});
  const ext=extensionFor(c,'ai')!,ctx=ext.context!(c);
  for(const line of legacy){expect(ext.stateful!.prepareHost!(ctx)).toContain(line);expect(ext.stateful!.teardown!(ctx)).toContain(line);}
 }
 const c=config();setVmSecrets({ai:keys});
 const ext=extensionFor(c,'ai')!,files=await statefulFiles(c,ext);
 expect(Object.keys(files).filter(f=>f.startsWith('quota-'))).toEqual([]);
 expect(Object.keys(compose(files).services)).toEqual(['two-ai-test-ai']);
 expect(ext.stateful!.prepareRelease!(ext.context!(c),'/r')).not.toContain('quota-alert');
});

test('the rollout removes orphaned sidecars, also when it rolls back',async()=>{
 const c=config({quotaAlert:alert});setVmSecrets({ai:secrets});
 const scripts:string[]=[];
 const process=await import('../src/shared/infrastructure/process');
 const edge=await import('../src/modules/domains/infrastructure/edge');
 const {spyOn}=await import('bun:test');
 const r=spyOn(process,'remote').mockImplementation(async(_c:unknown,s:string)=>{scripts.push(s);return '';});
 const u=spyOn(edge,'upload').mockImplementation(async()=>{});
 try{await deployStateful(extensionFor(c,'ai')!.context!(c),extensionFor(c,'ai')!);}finally{r.mockRestore();u.mockRestore();}
 const rollout=scripts.find(s=>s.includes('compose.json" up'))??scripts.join('\n');
 expect(rollout.match(/up -d --remove-orphans --wait/g)?.length).toBe(2);
});

test('quotaAlert fails closed before any remote work: missing, short or non-Discord webhook secrets',async()=>{
 const c=config({quotaAlert:alert}),ext=extensionFor(c,'ai')!;
 setVmSecrets({ai:keys});
 await expect(statefulFiles(c,ext)).rejects.toThrow('secret set --app ai');
 for(const bad of ['https://example.com/api/webhooks/123456789012345678/SYNTHETIC_webhook_token_0123456789abcdef',
  'http://discord.com/api/webhooks/123456789012345678/SYNTHETIC_webhook_token_0123456789abcdef',
  'https://discord.com/api/webhooks/123456789012345678/short',
  `${HOOK}"\nurl = "https://evil.example`]){
  setVmSecrets({ai:{...keys,DISCORD_ALERTS_WEBHOOK_URL:bad}});
  await expect(statefulFiles(c,ext)).rejects.toThrow(/Discord webhook|at least 20|single-line/);
 }
 setVmSecrets({ai:secrets});
 expect(Object.keys(await statefulFiles(c,ext))).toContain('quota-alert.secrets.json');
});

// ---- the state machine ----
const app0=()=>{const c=config({quotaAlert:alert});return extensionFor(c,'ai')!.context!(c);};
const cfg=(over:Partial<Cfg>={}):Cfg=>({...quotaAlertConfig(app0(),{...alert,image:'x@sha256:'+'0'.repeat(64)},8317),models:undefined,...over});
const acct=(name:string,rem:number|null,extra:Partial<Account>={},model='gemini-3.8-flash-high',reset='2026-11-02T14:05:00Z'):Account=>
 ({name,provider:'antigravity',label:name.replace('.json',''),status:'active',disabled:false,unavailable:false,cooldowns:0,error:null,
  quotas:rem===null?[]:[{model,remainingPercent:rem,resetTime:reset}],...extra});
const T0=1_793_000_000;
const ev=(list:Account[],state:State|object,now:number,over:Partial<Cfg>={})=>evaluate(cfg(over),list,state as State,now);

test('state machine: low alerts once, stays silent, re-pages after the interval, then recovers once',()=>{
 const low=[acct('a.json',0),acct('b.json',4.5,{},'gemini-3.8-flash-high','2026-11-02T15:00:00.123Z')];
 const r1=ev(low,{},T0);
 expect(r1.lines).toEqual(['**LOW** `gemini-3.8-flash-high` on `ai`: best remaining 4.5% across 2 account(s), 1 at 0%. Earliest reset 2026-11-02 14:05 UTC / 2026-11-02 21:05 Asia/Ho_Chi_Minh.']);
 expect(r1.state.keys['model:gemini-3.8-flash-high']).toMatchObject({low:true,at:T0,since:T0});
 const r2=ev(low,r1.state,T0+300);
 expect(r2.lines).toEqual([]);expect(r2.state.keys['model:gemini-3.8-flash-high'].at).toBe(T0);
 expect(ev(low,r2.state,T0+7199).lines).toEqual([]);
 const r4=ev(low,r2.state,T0+7200);
 expect(r4.lines).toHaveLength(1);expect(r4.lines[0]).toContain('**STILL LOW**');expect(r4.lines[0]).toContain('Low for 120 min');
 expect(r4.state.keys['model:gemini-3.8-flash-high']).toMatchObject({at:T0+7200,since:T0});
 const r5=ev([acct('a.json',0),acct('b.json',80)],r4.state,T0+7500);
 expect(r5.lines).toEqual(['**RECOVERED** `gemini-3.8-flash-high` on `ai`: best remaining 80% across 2 account(s).']);
 expect(r5.state.keys['model:gemini-3.8-flash-high']).toMatchObject({low:false,at:0});
 expect(ev([acct('a.json',0),acct('b.json',80)],r5.state,T0+7800).lines).toEqual([]);
 // Relapse after recovery alerts again at once, not after the re-page interval.
 expect(ev(low,r5.state,T0+7900).lines[0]).toContain('**LOW**');
});

test('state machine: the pool is judged by its best account, at the threshold inclusive, per model',()=>{
 expect(ev([acct('a.json',0),acct('b.json',50)],{},T0).lines).toEqual([]);
 expect(ev([acct('a.json',10)],{},T0).lines[0]).toContain('**LOW**');
 expect(ev([acct('a.json',10.1)],{},T0).lines).toEqual([]);
 expect(ev([acct('a.json',0)],{},T0,{thresholdPercent:0}).lines).toHaveLength(1);
 const r1=ev([acct('a.json',2),acct('c.json',3,{},'claude-opus-5-5-high')],{},T0);
 expect(r1.lines).toHaveLength(2);
 const r2=ev([acct('a.json',2),acct('c.json',60,{},'claude-opus-5-5-high')],r1.state,T0+300);
 expect(r2.lines).toHaveLength(1);expect(r2.lines[0]).toContain('**RECOVERED** `claude-opus-5-5-high`');
 expect(r2.state.keys['model:gemini-3.8-flash-high'].low).toBe(true);
 const only=ev([acct('a.json',2),acct('c.json',3,{},'claude-opus-5-5-high')],{},T0,{models:['claude-opus-5-5-high']});
 expect(only.lines).toHaveLength(1);expect(only.lines[0]).toContain('claude-opus-5-5-high');
 expect(only.state.keys['model:gemini-3.8-flash-high']).toBeUndefined();
 // Disabled accounts and probes without data neither count nor clear a low pool.
 const kept=ev([acct('a.json',null),acct('b.json',90,{disabled:true})],r1.state,T0+600);
 expect(kept.lines).toEqual([]);expect(kept.state.keys['model:gemini-3.8-flash-high'].low).toBe(true);
});

test('state machine: account trouble pages after two bad runs, ignores quota cooldowns and operator-disabled accounts',()=>{
 const broken=[acct('a.json',50,{error:'HTTP 401'}),acct('b.json',50,{unavailable:true,cooldowns:0,label:'ops`@x.example\nnext'}),acct('c.json',50,{unavailable:true,cooldowns:2}),acct('d.json',50,{disabled:true,unavailable:true})];
 const r1=ev(broken,{},T0);
 expect(r1.lines).toEqual([]);expect(r1.state.keys.accounts.streak).toBe(1);
 const r2=ev(broken,r1.state,T0+300);
 expect(r2.lines).toEqual(['**ACCOUNTS** `ai`: 2 account(s) need attention: `a` (`antigravity`: HTTP 401), `ops @x.example next` (`antigravity`: unavailable). 1 disabled by the operator.']);
 expect(ev(broken,r2.state,T0+600).lines).toEqual([]);
 const blip=ev([acct('a.json',50)],r2.state,T0+600);
 expect(blip.lines).toEqual(['**ACCOUNTS RECOVERED** `ai`: every enabled account is available again.']);
 expect(ev(broken,r1.state,T0+300).state.keys.accounts.low).toBe(true);
 const once=ev([acct('a.json',50,{error:'HTTP 500'})],{},T0);
 expect(ev([acct('a.json',50)],once.state,T0+300).lines).toEqual([]);
});

// ---- one run against a fake gateway and Discord ----
let work='';
beforeEach(async()=>{work=await mkdtemp(join(tmpdir(),'quota-alert-'));});
afterEach(()=>process.env.KEEP?undefined:rm(work,{recursive:true,force:true}));
const gem='gemini-3.8-flash-high';
const RUNTIME_SECRETS={managementKey:keys.CLIPROXY_MANAGEMENT_KEY,webhookUrl:HOOK};
function gatewayFake(){
 const g={files:[] as unknown[],probes:{} as Record<string,unknown>,auth:200,webhook:204,calls:[] as Array<{url:string;body:string;auth:string|null}>,sent:[] as Array<{content:string;allowed_mentions:unknown;username:string}>};
 const fetcher=async(url:string,init:RequestInit)=>{
  const auth=new Headers(init.headers).get('authorization'),body=typeof init.body==='string'?init.body:'';
  expect(init.redirect).toBe('error');
  if(url===HOOK){g.sent.push(JSON.parse(body));return new Response(null,{status:g.webhook});}
  g.calls.push({url,body,auth});
  if(auth!==`Bearer ${keys.CLIPROXY_MANAGEMENT_KEY}`)return new Response('{}',{status:401});
  if(g.auth!==200)return new Response('down',{status:g.auth});
  if(url.endsWith('/auth-files'))return new Response(JSON.stringify({files:g.files}));
  if(url.endsWith('/api-call')){const idx=String(JSON.parse(body).auth_index);return idx in g.probes?new Response(JSON.stringify(g.probes[idx])):new Response('bad gateway',{status:502});}
  return new Response('',{status:404});
 };
 const probe=(idx:string,models:Record<string,[unknown,string]>)=>{g.probes[idx]={status_code:200,header:{},body:JSON.stringify({models:Object.fromEntries(Object.entries(models).map(([k,[f,r]])=>[k,{displayName:k,quotaInfo:{remainingFraction:f,resetTime:r}}]))})};};
 return {g,fetcher,probe};
}

test('cycle end to end: probes like app quota, alerts once per transition, retries a failed webhook, leaks nothing',async()=>{
 const {g,fetcher,probe}=gatewayFake(),statePath=join(work,'state.json'),c=cfg({models:[gem]});
 let now=T0;const run=()=>cycle(c,RUNTIME_SECRETS,statePath,fetcher,()=>now);
 g.files=[
  {name:'ag-a.json',provider:'antigravity',label:'a@example.com',auth_index:'1',status:'active',access_token:'LEAKED-ACCESS-TOKEN',project_id:'p1'},
  {name:'ag-b.json',provider:'antigravity',label:'b@example.com',auth_index:'2',status:'active'},
  {name:'off.json',provider:'antigravity',auth_index:'3',disabled:true},
  {name:'xai.json',provider:'xai',auth_index:'4'}];
 probe('1',{[gem]:[0,'2026-11-02T14:05:00Z'],'claude-opus-5-5-high':[0.9,'2026-11-02T20:00:00Z']});
 probe('2',{[gem]:[0.05,'2026-11-02T15:00:00Z']});
 const r1=await run();
 expect(r1.notified).toBe(true);expect(g.sent).toHaveLength(1);
 expect(g.sent[0]).toEqual({username:'2server quota alert',allowed_mentions:{parse:[]},
  content:'**LOW** `gemini-3.8-flash-high` on `ai`: best remaining 5% across 2 account(s), 1 at 0%. Earliest reset 2026-11-02 14:05 UTC / 2026-11-02 21:05 Asia/Ho_Chi_Minh.'});
 expect(g.calls.map(x=>x.url)).toEqual(['http://two-ai-test-ai:8317/v0/management/auth-files',...Array(2).fill('http://two-ai-test-ai:8317/v0/management/api-call')]);
 const req=JSON.parse(g.calls[1].body);
 expect(req).toMatchObject({auth_index:'1',method:'POST',url:'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',data:'{"project":"p1"}'});
 expect(req.header.Authorization).toBe('Bearer $TOKEN$');
 // Still low: silent. Re-page after repageMinutes.
 now=T0+300;await run();expect(g.sent).toHaveLength(1);
 now=T0+7300;await run();expect(g.sent).toHaveLength(2);expect(g.sent[1].content).toContain('STILL LOW');
 // Recovery: exactly one message.
 probe('2',{[gem]:[0.8,'2026-11-02T15:00:00Z']});
 now=T0+7600;await run();now=T0+7900;await run();
 expect(g.sent).toHaveLength(3);expect(g.sent[2].content).toContain('**RECOVERED**');
 // A failing webhook keeps the old state, so the next run retries the same transition.
 probe('2',{[gem]:[0.01,'2026-11-02T15:00:00Z']});
 g.webhook=500;now=T0+8200;
 const bad=await run();expect(bad).toMatchObject({notified:false,status:500});
 g.webhook=204;now=T0+8500;await run();
 expect(g.sent).toHaveLength(5);expect(g.sent[4].content).toContain('**LOW**');
 const everything=[await readFile(statePath,'utf8'),JSON.stringify(g.sent),JSON.stringify(r1)].join('\n');
 for(const s of [HOOK,'SYNTHETIC_webhook',keys.CLIPROXY_MANAGEMENT_KEY,'LEAKED-ACCESS-TOKEN','discord.com'])expect(everything).not.toContain(s);
});

test('cycle: an unreachable or rejecting gateway pages after three runs and recovers once, keeping quota state',async()=>{
 const {g,fetcher,probe}=gatewayFake(),statePath=join(work,'state.json'),c=cfg({models:[gem]});
 let now=T0;const run=()=>cycle(c,RUNTIME_SECRETS,statePath,fetcher,()=>now);
 g.files=[{name:'a.json',provider:'antigravity',auth_index:'1',status:'active'}];probe('1',{[gem]:[0.02,'2026-11-02T14:05:00Z']});
 await run();expect(g.sent).toHaveLength(1);
 g.auth=503;
 for(const t of [300,600])(now=T0+t,await run());
 expect(g.sent).toHaveLength(1);
 now=T0+900;await run();
 expect(g.sent[1].content).toBe('**GATEWAY** `ai`: cannot read quota for 3 run(s); the management API answered HTTP 503.');
 const down=JSON.parse(await readFile(statePath,'utf8')) as State;
 expect(down.keys['model:gemini-3.8-flash-high'].low).toBe(true);
 g.auth=200;now=T0+1200;await run();
 expect(g.sent).toHaveLength(3);expect(g.sent[2].content).toBe('**GATEWAY RECOVERED** `ai`: quota can be read again.');
 // A wrong key is the same page, never a quota verdict.
 const wrong=await cycle(c,{...RUNTIME_SECRETS,managementKey:'wrong-key-wrong-key-123'},join(work,'w.json'),fetcher,()=>now);
 expect(wrong.lines).toEqual([]);expect(wrong.summary).toBe('gateway=401');
 const thrown=await cycle(c,RUNTIME_SECRETS,join(work,'t.json'),async()=>{throw new Error(`connect ECONNREFUSED ${HOOK}`);},()=>now);
 expect(thrown.summary).toBe('gateway=unreachable');expect(JSON.stringify(thrown)).not.toContain('SYNTHETIC');
});

// A compromised gateway controls every byte the alert reads. It can lie about
// quota (it could stop serving anyway) but must not get markup, mentions,
// links or extra lines into the ops channel, nor crash or stall the alert.
test('adversarial gateway: hostile account files and probe replies stay inert in Discord',async()=>{
 const {g,fetcher}=gatewayFake(),statePath=join(work,'state.json'),c=cfg();
 const evil='@everyone [click](https://evil.example) `x`\n**FAKE** \u202eredlof\u2028<@123>';
 g.files=[
  {name:'a.json',provider:evil,label:evil,auth_index:'1',status:'error'},
  {name:'b.json',provider:'antigravity',label:'x'.repeat(10_000),auth_index:'2',unavailable:true,cooldowns:'many'},
  {name:'c.json',provider:'codex',auth_index:'3',id_token:'not-an-object'},
  {name:'d.json',provider:'antigravity',auth_index:{evil:true}},
  {name:{toString:'x'}},null,7,'str',
  {name:'e.json',provider:'antigravity',auth_index:'5',antigravity_capability_hints:{endpoint:'http://169.254.169.254/latest'}}];
 g.probes={
  '2':{status_code:'500; @everyone',body:'{"error":{"message":"@everyone [x](https://evil.example)"}}'},
  '3':{status_code:200,body:JSON.stringify({rate_limit:{primary_window:{used_percent:'NaN',reset_at:1e300}}})},
  '5':{status_code:200,body:JSON.stringify({models:{[gem]:{quotaInfo:{remainingFraction:'0.01',resetTime:'@everyone'}},'claude-opus-5-5-high':{quotaInfo:{remainingFraction:1e309}}}})}};
 for(const t of [0,300]){const r=await cycle(c,RUNTIME_SECRETS,statePath,fetcher,()=>T0+t);expect(r.notified).toBe(true);}
 // Never a hand-picked upstream URL: the metadata endpoint is replaced by the default.
 const urls=g.calls.filter(x=>x.url.endsWith('/api-call')).map(x=>JSON.parse(x.body).url);
 expect(urls).not.toContain('http://169.254.169.254/latest/v1internal:fetchAvailableModels');
 // Run 1: a model the forged reply zeroed; run 2: the accounts page.
 expect(g.sent.map(x=>x.content.slice(0,12))).toEqual(['**LOW** `cla','**ACCOUNTS**']);
 for(const sent of g.sent){
  expect(sent.allowed_mentions).toEqual({parse:[]});
  expect(sent.content.length).toBeLessThanOrEqual(1900);
  // Every hostile string sits inside a code span: strip the spans and nothing of it is left.
  const outside=sent.content.replace(/`[^`\n]*`/g,'');
  for(const s of ['@everyone','evil.example','FAKE','<@123>','\u202e','\u2028','xxxxxxxxxx','NaN'])expect(outside).not.toContain(s);
 }
 const accountsLine=g.sent[1].content;
 expect(accountsLine.split('\n')).toHaveLength(1);
 expect(accountsLine).toContain('(`antigravity`: unavailable)');
 expect(accountsLine).toContain('status error');
 expect(accountsLine).not.toContain('500');
 expect(code('a`b\nc\u202ed\u0000')).toBe('`a b c d`');
 expect(code('')).toBe('`?`');
});

test('targets and accounts parse only well-formed values and never echo response bodies',()=>{
 const c=cfg(),files={files:[{name:'c.json',provider:'codex',auth_index:'9',account_id:'acc-1'},{name:'x.json',provider:'xai',auth_index:'1'}]};
 expect(targets(files,c)).toEqual([{name:'c.json',req:{auth_index:'9',method:'GET',url:'https://chatgpt.com/backend-api/wham/usage',
  header:{'Authorization':'Bearer $TOKEN$','User-Agent':'codex_cli_agent/0.1.0','Chatgpt-Account-Id':'acc-1'}}}]);
 expect(targets({files:'nope'},c)).toEqual([]);expect(targets(null,c)).toEqual([]);
 const list=accounts(files,[{name:'c.json',http:200,reply:{status_code:200,body:JSON.stringify({rate_limit:{primary_window:{used_percent:97.5,reset_at:1793000000}}})}}],c);
 expect(list[0]).toMatchObject({quotas:[{model:'codex-primary',remainingPercent:2.5,resetTime:'2026-10-26T07:33:20.000Z'}],error:null});
 const denied=accounts(files,[{name:'c.json',http:200,reply:{status_code:403,body:'{"error":"SECRET-BODY"}'}}],c);
 expect(denied[0].error).toBe('HTTP 403');expect(JSON.stringify(denied)).not.toContain('SECRET-BODY');
 expect(accounts(files,[{name:'c.json',http:502,reply:'<html>'}],c)[0].error).toBe('probe failed (HTTP 502)');
});

test('a planted state file or link is read as data only and replaced, never followed for writing',async()=>{
 const {g,fetcher}=gatewayFake(),statePath=join(work,'state.json'),target=join(work,'victim');
 await writeFile(target,'keep');await symlink(target,statePath);
 g.files=[];
 await cycle(cfg(),RUNTIME_SECRETS,statePath,fetcher,()=>T0);
 expect(await readFile(target,'utf8')).toBe('keep');
 await rm(statePath);await writeFile(statePath,'{"keys":"garbage"');
 expect((await cycle(cfg(),RUNTIME_SECRETS,statePath,fetcher,()=>T0)).lines).toEqual([]);
});
