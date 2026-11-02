import {afterEach, beforeEach, expect, test} from 'bun:test';
import {chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configSchema} from '../src/modules/config/application/config';
import {extensionFor,extensionSchemas} from '../src/modules/extensions/application/registry';
import {statefulFiles} from '../src/modules/extensions/application/stateful';
import {QUOTA_EVALUATE_JQ} from '../src/modules/extensions/infrastructure/templates/cliproxy/quota-alert';
import {parseDocument} from '../src/modules/source/application/documents';
import {templateApp} from '../src/modules/source/application/templates';
import {setVmSecrets} from '../src/shared/infrastructure/vm-secrets';

const base={version:1,name:'ai-test',ssh:{kind:'ssh',host:'unused.example',user:'operator'},edge:{mode:'managed'}};
const keys={CLIPROXY_CLIENT_KEY:'synthetic-client-key-1234567890',CLIPROXY_MANAGEMENT_KEY:'synthetic-manage-key-1234567890'};
const HOOK='https://discord.com/api/webhooks/123456789012345678/SYNTHETIC_webhook_token_0123456789abcdef';
const secrets={...keys,DISCORD_ALERTS_WEBHOOK_URL:HOOK};
const alert={webhookEnv:'DISCORD_ALERTS_WEBHOOK_URL',models:['gemini-3.8-flash-high'],thresholdPercent:10,intervalMinutes:5,repageMinutes:120};
function entry(spec:Record<string,unknown>={}){
 const d=parseDocument(templateApp('ai','cliproxy'));if(d.kind!=='Extension')throw Error();
 return {template:'cliproxy',spec:{...d.spec,...spec},secrets:{...d.secrets,DISCORD_ALERTS_WEBHOOK_URL:{provider:'vm' as const,key:'DISCORD_ALERTS_WEBHOOK_URL'}}};
}
const config=(spec:Record<string,unknown>={})=>configSchema.parse({...base,extensionApps:{ai:entry(spec)}});
afterEach(()=>setVmSecrets());

test('quotaAlert is opt-in, validated against the secrets and the models quota can report',()=>{
 const c=config();expect(c.extensionApps.ai.spec.quotaAlert).toBeUndefined();
 const on=config({quotaAlert:{webhookEnv:'DISCORD_ALERTS_WEBHOOK_URL'}}).extensionApps.ai.spec.quotaAlert;
 expect(on).toEqual({webhookEnv:'DISCORD_ALERTS_WEBHOOK_URL',thresholdPercent:10,intervalMinutes:5,repageMinutes:120});
 const desired=entry();
 const issues=(q:Record<string,unknown>)=>JSON.stringify(extensionSchemas.cliproxy.safeParse({...desired.spec,quotaAlert:q}).error?.issues);
 expect(issues(alert)).toBeUndefined();
 expect(issues({webhookEnv:'CLIPROXY_MANAGEMENT_KEY'})).toContain('its own secret');
 expect(issues({webhookEnv:'AI_KEY'})).toBeUndefined();
 expect(issues({...alert,models:['gemini-9']})).toContain('has no quota data');
 expect(issues({...alert,intervalMinutes:30,repageMinutes:10})).toContain('must not be shorter');
 for(const bad of [{},{webhookEnv:'lower'},{...alert,thresholdPercent:101},{...alert,thresholdPercent:-1},{...alert,intervalMinutes:0},
  {...alert,models:[]},{...alert,models:['codex-primary','codex-primary']},{...alert,webhook:'https://x'}])
  expect(extensionSchemas.cliproxy.safeParse({...desired.spec,quotaAlert:bad}).success).toBe(false);
});

test('quotaAlert renders a hardened oneshot service and timer with the secrets only in root-only curl configs',async()=>{
 const c=config({quotaAlert:alert});setVmSecrets({ai:secrets});
 const ext=extensionFor(c,'ai')!,files=await statefulFiles(c,ext),ctx=ext.context!(c);
 const unit='two-ai-test-ai-quota-alert';
 expect(files['quota-alert.service']).toContain('Type=oneshot');
 for(const d of ['NoNewPrivileges=true','ProtectSystem=strict','ProtectHome=true','PrivateTmp=true','UMask=0077'])expect(files['quota-alert.service']).toContain(d);
 expect(files['quota-alert.service']).toContain('ExecStart=/bin/bash /opt/2server/extensions/ai/current/quota-alert.sh');
 expect(files['quota-alert.service']).toContain('ReadWritePaths=/opt/2server/extensions/ai/quota-alert.d /opt/2server/metrics /run/lock');
 expect(files['quota-alert.timer']).toContain('OnUnitActiveSec=5min');
 expect(files['quota-alert.timer']).toContain(`Unit=${unit}.service`);
 expect(files['quota-alert.sh']).toContain("flock -n 9");
 expect(files['quota-alert.sh']).toContain('/opt/2server/metrics');
 expect(files['quota-alert.sh']).toContain("nsenter -t \"$pid\" -n curl");
 expect(JSON.parse(files['quota-alert.json'])).toMatchObject({app:'ai',models:['gemini-3.8-flash-high'],thresholdPercent:10,repageSeconds:7200});
 const secretFiles=['quota-alert.mgmt.conf','quota-alert.webhook.conf'];
 expect(files['quota-alert.mgmt.conf']).toBe(`header = "Authorization: Bearer ${keys.CLIPROXY_MANAGEMENT_KEY}"\n`);
 expect(files['quota-alert.webhook.conf']).toBe(`url = "${HOOK}"\n`);
 for(const [name,body] of Object.entries(files))if(!secretFiles.includes(name)&&name!=='verify.conf'&&name!=='config.yaml'){
  expect(body).not.toContain(HOOK);expect(body).not.toContain('SYNTHETIC_webhook');expect(body).not.toContain(keys.CLIPROXY_MANAGEMENT_KEY);expect(body).not.toContain('synthetic-');
 }
 const release=ext.stateful!.prepareRelease!(ctx,'/r');
 for(const f of secretFiles)expect(release).toContain(`chown 0:0 '/r/${f}' && chmod 0400 '/r/${f}'`);
 const install=ext.stateful!.postInstall!(ctx);
 expect(install).toContain(`install -m 644 '/opt/2server/extensions/ai/current/quota-alert.timer' /etc/systemd/system/${unit}.timer`);
 expect(install).toContain(`systemctl enable ${unit}.timer`);expect(install).toContain(`systemctl restart ${unit}.timer`);
 expect(install).toContain("install -d -m 700 '/opt/2server/extensions/ai/quota-alert.d'");
 expect(install+release).not.toContain('SYNTHETIC');
 expect(ext.stateful!.teardown!(ctx)).toContain(`systemctl disable --now ${unit}.timer`);
});

test('without quotaAlert nothing is rendered and a redeploy removes a previously installed alert',async()=>{
 const c=config();setVmSecrets({ai:keys});
 const ext=extensionFor(c,'ai')!,files=await statefulFiles(c,ext),ctx=ext.context!(c);
 expect(Object.keys(files).filter(f=>f.startsWith('quota-'))).toEqual([]);
 expect(ext.stateful!.prepareRelease!(ctx,'/r')).not.toContain('quota-alert');
 const install=ext.stateful!.postInstall!(ctx);
 expect(install).toContain('if [ -e /etc/systemd/system/two-ai-test-ai-quota-alert.timer ]');
 expect(install).toContain('systemctl disable --now two-ai-test-ai-quota-alert.timer');
 expect(install).toContain("rm -f /etc/systemd/system/two-ai-test-ai-quota-alert.service /etc/systemd/system/two-ai-test-ai-quota-alert.timer '/opt/2server/metrics/ai-quota-alert.prom'");
 expect(install).not.toContain('install -m');
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
 expect(Object.keys(await statefulFiles(c,ext))).toContain('quota-alert.sh');
});

// ---- the state machine (jq) ----
let work='';
beforeEach(async()=>{work=await mkdtemp(join(tmpdir(),'quota-alert-'));});
afterEach(()=>process.env.KEEP?undefined:rm(work,{recursive:true,force:true}));
const hasJq=!!Bun.which('jq'),hasBash=!!Bun.which('bash');

type Account={name:string;provider?:string;label?:string|null;status?:string;disabled?:boolean;unavailable?:boolean;cooldowns?:number;error?:string|null;quotas?:Array<{model:string;remainingPercent:number;resetTime?:string|null}>};
const acct=(name:string,rem:number|null,extra:Partial<Account>={},model='gemini-3.8-flash-high',reset='2026-11-02T14:05:00Z'):Account=>
 ({name,provider:'antigravity',label:name.replace('.json',''),status:'active',disabled:false,unavailable:false,cooldowns:0,error:null,
  quotas:rem===null?[]:[{model,remainingPercent:rem,resetTime:reset}],...extra});
async function evaluate(accounts:Account[],state:unknown,now:number,cfg:Record<string,unknown>={}){
 const dir=await mkdtemp(join(work,'e-'));
 await writeFile(join(dir,'p.jq'),QUOTA_EVALUATE_JQ);
 await writeFile(join(dir,'cfg.json'),JSON.stringify({app:'ai',thresholdPercent:10,repageSeconds:7200,...cfg}));
 await writeFile(join(dir,'acc.json'),JSON.stringify(accounts));
 const p=Bun.spawn(['jq','-n','-c','--slurpfile','cfg',join(dir,'cfg.json'),'--slurpfile','accts',join(dir,'acc.json'),'--argjson','state',JSON.stringify(state),'--argjson','now',String(now),'-f',join(dir,'p.jq')],{stdout:'pipe',stderr:'pipe'});
 const [out,err]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text()]);
 if(await p.exited)throw new Error(err);
 return JSON.parse(out) as {state:{keys:Record<string,{low:boolean;at:number;since:number;streak?:number}>};lines:string[];metrics:string};
}
const T0=1_793_000_000;

test.skipIf(!hasJq)('state machine: low alerts once, stays silent, re-pages after the interval, then recovers once',async()=>{
 const low=[acct('a.json',0),acct('b.json',4.5,{},'gemini-3.8-flash-high','2026-11-02T15:00:00.123Z')];
 const r1=await evaluate(low,{},T0);
 expect(r1.lines).toHaveLength(1);
 expect(r1.lines[0]).toContain('**LOW**');expect(r1.lines[0]).toContain('gemini-3.8-flash-high');
 expect(r1.lines[0]).toContain('best remaining 4.5% across 2 account(s), 1 at 0%');
 expect(r1.lines[0]).toContain('Earliest reset 2026-11-02 14:05 UTC / 2026-11-02 21:05 Asia/Ho_Chi_Minh');
 expect(r1.state.keys['model:gemini-3.8-flash-high']).toMatchObject({low:true,at:T0,since:T0});
 const r2=await evaluate(low,r1.state,T0+300);
 expect(r2.lines).toEqual([]);expect(r2.state.keys['model:gemini-3.8-flash-high'].at).toBe(T0);
 const r3=await evaluate(low,r2.state,T0+7199);expect(r3.lines).toEqual([]);
 const r4=await evaluate(low,r3.state,T0+7200);
 expect(r4.lines).toHaveLength(1);expect(r4.lines[0]).toContain('**STILL LOW**');expect(r4.lines[0]).toContain('Low for 120 min');
 expect(r4.state.keys['model:gemini-3.8-flash-high']).toMatchObject({at:T0+7200,since:T0});
 const r5=await evaluate([acct('a.json',0),acct('b.json',80)],r4.state,T0+7500);
 expect(r5.lines).toHaveLength(1);expect(r5.lines[0]).toContain('**RECOVERED**');expect(r5.lines[0]).toContain('best remaining 80%');
 expect(r5.state.keys['model:gemini-3.8-flash-high']).toMatchObject({low:false,at:0});
 expect((await evaluate([acct('a.json',0),acct('b.json',80)],r5.state,T0+7800)).lines).toEqual([]);
 // Relapse after recovery alerts again at once, not after the re-page interval.
 expect((await evaluate(low,r5.state,T0+7900)).lines[0]).toContain('**LOW**');
});

test.skipIf(!hasJq)('state machine: the pool is judged by its best account, at the threshold inclusive, per model',async()=>{
 const two=(g:number,c:number)=>[acct('a.json',g),acct('b.json',50),acct('c.json',c,{provider:'antigravity'},'claude-opus-5-5-high')];
 // One exhausted account is not an alert while another still has quota.
 expect((await evaluate([acct('a.json',0),acct('b.json',50)],{},T0)).lines).toEqual([]);
 expect((await evaluate([acct('a.json',10)],{},T0)).lines[0]).toContain('**LOW**');
 expect((await evaluate([acct('a.json',10.1)],{},T0)).lines).toEqual([]);
 expect((await evaluate([acct('a.json',0)],{},T0,{thresholdPercent:0})).lines).toHaveLength(1);
 // Models are independent: opus recovers while gemini stays low and gets no extra message.
 const r1=await evaluate([acct('a.json',2),acct('c.json',3,{},'claude-opus-5-5-high')],{},T0);
 expect(r1.lines).toHaveLength(2);
 const r2=await evaluate([acct('a.json',2),acct('c.json',60,{},'claude-opus-5-5-high')],r1.state,T0+300);
 expect(r2.lines).toHaveLength(1);expect(r2.lines[0]).toContain('**RECOVERED** `claude-opus-5-5-high`');
 expect(r2.state.keys['model:gemini-3.8-flash-high'].low).toBe(true);
 expect(two(0,0)).toHaveLength(3);
 // A configured model list restricts what is watched.
 const only=await evaluate([acct('a.json',2),acct('c.json',3,{},'claude-opus-5-5-high')],{},T0,{models:['claude-opus-5-5-high']});
 expect(only.lines).toHaveLength(1);expect(only.lines[0]).toContain('claude-opus-5-5-high');
 expect(only.state.keys['model:gemini-3.8-flash-high']).toBeUndefined();
 // Disabled accounts and probes without data neither count nor clear a low pool.
 const kept=await evaluate([acct('a.json',null),acct('b.json',90,{disabled:true})],r1.state,T0+600);
 expect(kept.lines).toEqual([]);expect(kept.state.keys['model:gemini-3.8-flash-high'].low).toBe(true);
 expect(kept.metrics).not.toContain('best_remaining_percent');
});

test.skipIf(!hasJq)('state machine: account trouble pages after two bad runs, ignores quota cooldowns and operator-disabled accounts',async()=>{
 const broken=[acct('a.json',50,{error:'HTTP 401'}),acct('b.json',50,{unavailable:true,cooldowns:0,label:'ops`@x.example\nnext'}),acct('c.json',50,{unavailable:true,cooldowns:2}),acct('d.json',50,{disabled:true,unavailable:true})];
 const r1=await evaluate(broken,{},T0);
 expect(r1.lines).toEqual([]);expect(r1.state.keys.accounts.streak).toBe(1);
 const r2=await evaluate(broken,r1.state,T0+300);
 expect(r2.lines).toHaveLength(1);
 expect(r2.lines[0]).toContain('2 account(s) need attention');
 expect(r2.lines[0]).toContain('(antigravity: HTTP 401)');expect(r2.lines[0]).toContain('(antigravity: unavailable)');
 expect(r2.lines[0]).toContain('1 disabled by the operator');expect(r2.lines[0]).not.toContain('`c`');
 expect(r2.lines[0]).not.toContain('\n');expect(r2.lines[0]).toContain("`ops @x.example next`");
 expect((await evaluate(broken,r2.state,T0+600)).lines).toEqual([]);
 const blip=await evaluate([acct('a.json',50)],r2.state,T0+600);
 expect(blip.lines).toHaveLength(1);expect(blip.lines[0]).toContain('ACCOUNTS RECOVERED');
 // A single clean run between two bad ones does not flap the page.
 const flap=await evaluate(broken,r1.state,T0+300);
 expect(flap.state.keys.accounts.low).toBe(true);
 const once=await evaluate([acct('a.json',50,{error:'HTTP 500'})],{},T0);
 expect((await evaluate([acct('a.json',50)],once.state,T0+300)).lines).toEqual([]);
});

// ---- the whole script against a fake VM ----
const sleepless=!hasJq||!hasBash;
async function vm(){
 const c=config({quotaAlert:alert});setVmSecrets({ai:secrets});
 const ext=extensionFor(c,'ai')!,files=await statefulFiles(c,ext);
 const root=work,rel=(p:string)=>p.replaceAll('/opt/2server',join(root,'opt')).replaceAll('/var/lock',join(root,'lock'));
 const cur=join(root,'opt/extensions/ai/current');
 await mkdir(cur,{recursive:true});await mkdir(join(root,'opt/edge'),{recursive:true});await mkdir(join(root,'lock'));
 await mkdir(join(root,'opt/extensions/ai/quota-alert.d'));await mkdir(join(root,'opt/metrics'));await mkdir(join(root,'bin'));
 await writeFile(join(root,'opt/edge/owner'),'ai-test\n');
 for(const [name,body] of Object.entries(files))if(name.startsWith('quota-')){
  await writeFile(join(cur,name),rel(body));await chmod(join(cur,name),name.endsWith('.conf')?0o400:0o644);
 }
 const shim=async(name:string,body:string)=>{await writeFile(join(root,'bin',name),`#!/bin/bash\n${body}\n`);await chmod(join(root,'bin',name),0o755);};
 await shim('docker','case "$*" in *Labels*) echo ai-test;; *State.Pid*) echo 4242;; *) exit 1;; esac');
 await shim('nsenter','shift 3; exec "$@"');
 await shim('flock','exit 0');
 await shim('date','if [ "$1" = +%s ]; then cat '+join(root,'now')+'; else exec /bin/date "$@"; fi');
 await shim('curl',`out=; fmt=; conf=; data=; url=; method=GET
while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift;; -w) fmt=$2; shift;; -K) conf=$2; shift;; -X) method=$2; shift;; --data-binary) data=\${2#@}; shift;; -H|--max-time) shift;; -*) ;; *) url=$1;; esac; shift; done
code=200
case "$conf" in
 *webhook.conf) n=$(ls ${root}/sent-* 2>/dev/null | wc -l | tr -d " "); cp "$data" ${root}/sent-$n.json; code=$(cat ${root}/webhook_code 2>/dev/null || echo 204);;
 *) grep -q 'Bearer ${keys.CLIPROXY_MANAGEMENT_KEY}' "$conf" || code=401
    path=\${url#http://127.0.0.1:8317/v0/management}
    if [ "$code" = 200 ]; then case "$path" in
     /auth-files) cp ${root}/files.json "$out";;
     /api-call) cat "$data" >> ${root}/api-calls.log; echo >> ${root}/api-calls.log
        idx=$(jq -r .auth_index "$data"); if [ -f ${root}/probe-$idx.json ]; then cp ${root}/probe-$idx.json "$out"; else code=502; fi;;
     *) code=404;; esac; fi;;
esac
[ -z "$fmt" ] || printf '%s' "$code"`);
 const run=async()=>{
  const p=Bun.spawn(['/bin/bash',join(cur,'quota-alert.sh')],{env:{...process.env,PATH:`${join(root,'bin')}:${process.env.PATH}`},stdout:'pipe',stderr:'pipe'});
  const [out,err]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text()]);
  return {code:await p.exited,out,err};
 };
 const sent=async()=>Promise.all((await readdir(root)).filter(f=>f.startsWith('sent-')).sort().map(async f=>JSON.parse(await readFile(join(root,f),'utf8')) as {content:string;allowed_mentions:unknown}));
 const at=(t:number)=>writeFile(join(root,'now'),String(t));
 const fileList=(f:unknown)=>writeFile(join(root,'files.json'),JSON.stringify({files:f}));
 const probe=(idx:string,models:Record<string,[number,string]>)=>writeFile(join(root,`probe-${idx}.json`),JSON.stringify({status_code:200,header:{},body:JSON.stringify({models:Object.fromEntries(Object.entries(models).map(([k,[f,r]])=>[k,{displayName:k,quotaInfo:{remainingFraction:f,resetTime:r}}]))})}));
 return {root,run,sent,at,fileList,probe,statePath:join(root,'opt/extensions/ai/quota-alert.d/state.json')};
}
const gem='gemini-3.8-flash-high';

test.skipIf(sleepless)('script end to end: probes like app quota, alerts once per transition, retries a failed webhook, leaks nothing',async()=>{
 const v=await vm();
 await v.fileList([
  {name:'ag-a.json',provider:'antigravity',label:'a@example.com',auth_index:'1',status:'active',access_token:'LEAKED-ACCESS-TOKEN',project_id:'p1'},
  {name:'ag-b.json',provider:'antigravity',label:'b@example.com',auth_index:'2',status:'active'},
  {name:'off.json',provider:'antigravity',auth_index:'3',disabled:true},
  {name:'xai.json',provider:'xai',auth_index:'4'}]);
 await v.probe('1',{[gem]:[0,'2026-11-02T14:05:00Z'],'claude-opus-5-5-high':[0.9,'2026-11-02T20:00:00Z']});
 await v.probe('2',{[gem]:[0.05,'2026-11-02T15:00:00Z']});
 await v.at(T0);
 const r1=await v.run();
 expect(r1.code).toBe(0);
 let sent=await v.sent();expect(sent).toHaveLength(1);
 expect(sent[0].content).toContain('**LOW** `gemini-3.8-flash-high` on ai: best remaining 5% across 2 account(s), 1 at 0%.');
 expect(sent[0].content).toContain('14:05 UTC / 2026-11-02 21:05 Asia/Ho_Chi_Minh');
 expect(sent[0].content).not.toContain('claude-opus');
 expect(sent[0].allowed_mentions).toEqual({parse:[]});
 const calls=await readFile(join(v.root,'api-calls.log'),'utf8');
 expect(calls).toContain('$TOKEN$');expect(calls).toContain('fetchAvailableModels');expect(calls).not.toContain('off.json');
 expect((calls.match(/fetchAvailableModels/g)??[]).length).toBe(2);
 const prom=await readFile(join(v.root,'opt/metrics/ai-quota-alert.prom'),'utf8');
 expect(prom).toContain(`two_cliproxy_quota_best_remaining_percent{app="ai",model="${gem}"} 5`);
 expect(prom).toContain('two_cliproxy_quota_low{app="ai",model="gemini-3.8-flash-high"} 1');
 expect(prom).toContain('two_cliproxy_quota_alert_probe_ok{app="ai"} 1');expect(prom).toContain('two_cliproxy_quota_alert_notify_ok{app="ai"} 1');
 // Still low: silent.
 await v.at(T0+300);expect((await v.run()).code).toBe(0);expect(await v.sent()).toHaveLength(1);
 // Re-page after repageMinutes.
 await v.at(T0+7300);await v.run();sent=await v.sent();
 expect(sent).toHaveLength(2);expect(sent[1].content).toContain('STILL LOW');
 // Recovery: exactly one message.
 await v.probe('2',{[gem]:[0.8,'2026-11-02T15:00:00Z']});
 await v.at(T0+7600);await v.run();await v.at(T0+7900);await v.run();
 sent=await v.sent();expect(sent).toHaveLength(3);expect(sent[2].content).toContain('**RECOVERED**');
 // A failing webhook keeps the old state, so the next run retries the same transition.
 await v.probe('2',{[gem]:[0.01,'2026-11-02T15:00:00Z']});
 await writeFile(join(v.root,'webhook_code'),'500');
 await v.at(T0+8200);
 const bad=await v.run();expect(bad.code).toBe(1);expect(bad.err).toContain('state kept');
 expect(await v.sent()).toHaveLength(4);
 expect(await readFile(join(v.root,'opt/metrics/ai-quota-alert.prom'),'utf8')).toContain('notify_ok{app="ai"} 0');
 await writeFile(join(v.root,'webhook_code'),'204');
 await v.at(T0+8500);expect((await v.run()).code).toBe(0);
 sent=await v.sent();expect(sent).toHaveLength(5);expect(sent[4].content).toContain('**LOW**');
 // Nothing secret is ever printed or stored outside the two root-only configs.
 const everything=[r1.out,r1.err,bad.out,bad.err,prom,await readFile(v.statePath,'utf8'),JSON.stringify(sent)].join('\n');
 for(const s of [HOOK,'SYNTHETIC_webhook',keys.CLIPROXY_MANAGEMENT_KEY,'LEAKED-ACCESS-TOKEN','discord.com'])expect(everything).not.toContain(s);
});

test.skipIf(sleepless)('script adverse cases: bad management key, unreachable probe and foreign owner publish probe_ok 0 and page nobody',async()=>{
 const v=await vm();await v.at(T0);
 await v.fileList([{name:'ag-a.json',provider:'antigravity',auth_index:'9',status:'active'}]);
 // The probe itself fails for this account: reported as an account problem only after two runs, never as a quota alert.
 const r=await v.run();expect(r.code).toBe(0);expect(await v.sent()).toHaveLength(0);
 await v.at(T0+300);await v.run();
 const sent=await v.sent();expect(sent).toHaveLength(1);expect(sent[0].content).toContain('probe failed (HTTP 502)');
 // Foreign owner: refuses before touching the API.
 await writeFile(join(v.root,'opt/edge/owner'),'another-server\n');
 const foreign=await v.run();expect(foreign.code).toBe(1);expect(foreign.err).toContain('does not own');
 expect(await readFile(join(v.root,'opt/metrics/ai-quota-alert.prom'),'utf8')).toContain('probe_ok{app="ai"} 0');
 expect(await v.sent()).toHaveLength(1);
 // Management API rejects the key.
 await writeFile(join(v.root,'opt/edge/owner'),'ai-test\n');
 await chmod(join(v.root,'opt/extensions/ai/current/quota-alert.mgmt.conf'),0o600);
 await writeFile(join(v.root,'opt/extensions/ai/current/quota-alert.mgmt.conf'),'header = "Authorization: Bearer wrong"\n');
 await chmod(join(v.root,'opt/extensions/ai/current/quota-alert.mgmt.conf'),0o400);
 const denied=await v.run();expect(denied.code).toBe(1);expect(denied.err).toContain('management API answered 401');
 expect(await v.sent()).toHaveLength(1);
});
