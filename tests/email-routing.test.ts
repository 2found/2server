import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '../src/modules/config/application/config';
import { deployAll } from '../src/modules/extensions/application/deploy';
import { extensionForCliName } from '../src/modules/extensions/application/registry';
import { emailRoutingSpecSchema } from '../src/modules/extensions/infrastructure/templates/email-routing/domain/spec';
import { reconcileEmailRouting } from '../src/modules/extensions/infrastructure/templates/email-routing/deploy';
import { parseDocument } from '../src/modules/source/application/documents';
import { templateApp } from '../src/modules/source/application/templates';
import { fileCommand, fileOperations } from '../src/modules/source/cli/command';

const spec=emailRoutingSpecSchema.parse({accountId:'a'.repeat(32),zone:'example.com',routes:[{address:'contact@example.com',destination:'owner@example.net'}]});
const dns=[
  {type:'MX',name:'example.com',content:'route1.mx.cloudflare.net',priority:10},
  {type:'TXT',name:'example.com',content:'v=spf1 include:_spf.mx.cloudflare.net ~all'},
];
const managed=(address='contact@example.com',destination='owner@example.net')=>({
  id:'rule-1',name:`2server:mail:${address}`,enabled:true,
  matchers:[{type:'literal',field:'to',value:address}],actions:[{type:'forward',value:[destination]}],
});
type ApiRule = Omit<ReturnType<typeof managed>,'matchers'> & {matchers:Array<{type:string;field?:string;value?:string}>};
function api() {
  const state={
    account:spec.accountId,settings:{enabled:false,status:'unconfigured'},
    records:[] as Array<(typeof dns)[number]&{id?:string}>,required:structuredClone(dns),
    rules:[] as ApiRule[],
    destinations:[{id:'dest-1',email:'owner@example.net',verified:'2026-01-01T00:00:00Z' as string|null}],
    calls:[] as Array<{method:string;path:string;body:any}>,
    failPath:undefined as string|undefined, notReady:false,
    changeRules:undefined as (()=>void)|undefined,
    changeDns:undefined as (()=>void)|undefined,
    ruleReads:0,dnsReads:0,
  };
  const request=(async (input:string|URL,init?:RequestInit)=>{
    const url=new URL(String(input)),path=url.pathname.replace('/client/v4',''),method=init?.method??'GET';
    const body=init?.body?JSON.parse(String(init.body)):undefined;
    state.calls.push({method,path,body});
    if (path===state.failPath) return Response.json({success:false,errors:[{code:10000,message:'secret-token'}]},{status:403});
    let result:unknown;
    const paginate=(rows:unknown[])=>{
      const page=Number(url.searchParams.get('page')??1),size=Number(url.searchParams.get('per_page')??50);
      return rows.slice((page-1)*size,page*size);
    };
    if (path==='/zones') result=[{id:'zone-1',name:spec.zone,status:'active'}];
    else if(path==='/zones/zone-1') result={account:{id:state.account}};
    else if(path.includes('/dns_records/')&&method==='DELETE') {
      state.records=state.records.filter(r=>r.id!==path.split('/').at(-1));result={id:path.split('/').at(-1)};
    } else if(path.endsWith('/dns_records')) {
      state.dnsReads++;
      if (state.dnsReads===2) state.changeDns?.();
        result=paginate(state.records.filter(r=>r.name===url.searchParams.get('name')));
    } else if(path.endsWith('/email/routing/dns')) {
      if(method==='POST') {
        if(body?.name===spec.zone)return Response.json({success:false,errors:[{code:2007,message:'Invalid Input: must be a subdomain'}]},{status:422});
        state.records.push(...structuredClone(state.required).filter(w=>!state.records.some(r=>JSON.stringify(r)===JSON.stringify(w))));
        state.settings={enabled:true,status:state.notReady?'misconfigured':'ready'};
        result=state.settings;
      } else result=state.required;
    } else if(path.endsWith('/email/routing')) result=state.settings;
    else if(path.includes('/email/routing/rules')) {
      if(method==='GET') {
        state.ruleReads++;
        if (state.ruleReads===2) state.changeRules?.();
        result=paginate(state.rules);
      } else {
        const row={...body,matchers:body.matchers.map((m:any)=>({field:m.field,value:m.value,type:m.type})),id:method==='PUT'?path.split('/').at(-1):`rule-${state.rules.length+1}`};
        if(method==='PUT') state.rules=state.rules.map(r=>r.id===row.id?row:r);
        else state.rules.push(row);
        result=row;
      }
    } else if(path.endsWith('/email/routing/addresses')) {
      if(method==='POST') {
        const row={id:'dest-new',email:body.email,verified:null};state.destinations.push(row);result=row;
      } else result=paginate(state.destinations);
    } else throw Error(`Unexpected request ${method} ${path}`);
    return Response.json({success:true,result:structuredClone(result)});
  }) as typeof fetch;
  return {state,request,writes:()=>state.calls.filter(c=>c.method!=='GET')};
}

test('email template round-trips, validates routes and skips the VM engine',async()=>{
  const doc=templateApp('mail','email-routing');
  expect(parseDocument(Bun.YAML.parse(Bun.YAML.stringify(doc))).kind).toBe('Extension');
  expect(extensionForCliName('email-routing')?.runtimeEngine).toBe('email-routing');
  expect(doc.secrets).toEqual({});
  const c=configSchema.parse({version:1,name:'test',ssh:{kind:'ssh',host:'host.example',user:'operator'},edge:{mode:'managed'},extensionApps:{mail:{template:'email-routing',spec}}});
  await deployAll(c);
  for(const value of [
    {...spec,unknown:true}, {...spec,routes:[]}, {...spec,routes:[{address:'a@other.com',destination:'owner@example.net'}]},
    {...spec,routes:[{address:'a@example.com',destination:'a@example.com'}]},
    {...spec,routes:[spec.routes[0],{...spec.routes[0],address:'CONTACT@example.com'}]},
    {...spec,routes:[{...spec.routes[0],address:'*@example.com'}]},
    {...spec,accountId:undefined,createZoneTokenPolicy:true},
    {...spec,createZoneTokenPolicy:true,manageTokenPermissions:false},
  ]) expect(()=>emailRoutingSpecSchema.parse(value)).toThrow();
  for(const extra of [{domains:[{name:'mail'}]},{requires:[{kind:'App',name:'db'}]},{secrets:{TOKEN:{provider:'vm',key:'TOKEN'}}}])
    expect(()=>parseDocument({...doc,...extra})).toThrow();
});

test('new-zone plan defers protected mail reads; apply bootstraps its policy and stops before DNS until verified',async()=>{
  const m=api();m.state.destinations=[];
  const input={...spec,manageTokenPermissions:true,createZoneTokenPolicy:true};
  let policies:any[]=[];
  const groups=['Zone Read','DNS Read','Zone Settings Write','Email Routing Rules Write'].map((name,i)=>({id:String(i+1).repeat(32),name,scopes:['com.cloudflare.api.account.zone']}));
  const request=(async(url:string|URL,init?:RequestInit)=>{
    const u=new URL(String(url));
    if(!u.pathname.includes('/tokens/'))return m.request(url,init);
    m.state.calls.push({method:init?.method??'GET',path:u.pathname,body:init?.body?JSON.parse(String(init.body)):undefined});
    let result;
    if(u.pathname.endsWith('/verify'))result={id:'c'.repeat(32),status:'active'};
    else if(u.pathname.endsWith('/permission_groups'))result=groups;
    else {
      if(init?.method==='PUT')policies=JSON.parse(String(init.body)).policies.map((p:any,i:number)=>({...p,id:`policy-${i}`,permission_groups:p.permission_groups.map((g:any)=>({...g,name:groups.find(w=>w.id===g.id)?.name}))}));
      result={name:'existing-token',status:'active',policies};
    }
    return Response.json({success:true,result});
  }) as typeof fetch;
  const plan=await reconcileEmailRouting(input,'mail',false,'token',request);
  expect(plan).toMatchObject({preflight:'deferred-until-permission',tokenPermission:{operation:'create'}});
  expect(m.state.calls.some(c=>c.path.includes('/email/routing'))).toBe(false);
  expect(m.writes()).toEqual([]);
  expect((await reconcileEmailRouting(input,'mail',true,'token',request)).status).toBe('pending-verification');
  expect(m.writes().map(c=>c.method)).toEqual(['PUT','POST']);
  expect(m.writes()[1].path).toBe(`/accounts/${spec.accountId}/email/routing/addresses`);
  expect(m.state.records).toEqual([]);expect(m.state.rules).toEqual([]);
});

test('plan reads the account, DNS, rules and destinations without any writes',async()=>{
  const m=api(),plan=await reconcileEmailRouting(spec,'mail',false,'private-token',m.request);
  expect(plan).toMatchObject({status:'planned',enableRouting:true,receiveOnly:true,routes:[{operation:'create'}]});
  expect(m.writes()).toEqual([]);
});

test('account is discovered from the zone when no explicit account pin is declared',async()=>{
  const m=api(),{accountId,...input}=spec;
  const plan=await reconcileEmailRouting(input,'mail',false,'token',m.request);
  expect(plan.accountId).toBe('a'.repeat(32));
  expect(m.state.calls.some(c=>c.path===`/accounts/${accountId}/email/routing/addresses`)).toBe(true);
  expect(m.writes()).toEqual([]);
});

test('apply enables Cloudflare-managed DNS, installs routes and verifies readiness; reapply makes no writes',async()=>{
  const m=api();
  expect((await reconcileEmailRouting(spec,'mail',true,'token',m.request)).status).toBe('ready');
  expect(m.writes().map(c=>`${c.method} ${c.path}`)).toEqual(['POST /zones/zone-1/email/routing/dns','POST /zones/zone-1/email/routing/rules']);
  expect(m.writes()[0].body).toBeUndefined();
  m.state.calls=[];
  expect((await reconcileEmailRouting(spec,'mail',true,'token',m.request)).status).toBe('ready');
  expect(m.writes()).toEqual([]);
});

test('missing destinations request verification once; no DNS/rule writes until the user verifies',async()=>{
  const m=api();m.state.destinations=[];
  const plan=await reconcileEmailRouting(spec,'mail',true,'token',m.request);
  expect(plan).toMatchObject({status:'pending-verification',pending:['owner@example.net']});
  expect(m.writes().map(c=>c.path)).toEqual([`/accounts/${spec.accountId}/email/routing/addresses`]);
  m.state.calls=[];
  expect((await reconcileEmailRouting(spec,'mail',true,'token',m.request)).status).toBe('pending-verification');
  expect(m.writes()).toEqual([]);
  m.state.destinations[0].verified='2026-01-01T00:00:00Z';
  expect((await reconcileEmailRouting(spec,'mail',true,'token',m.request)).status).toBe('ready');
});

test('foreign MX/SPF, wrong account and duplicate/foreign rules fail before mutations',async()=>{
  for(const setup of [
    (m:ReturnType<typeof api>)=>{m.state.records=[{...dns[0],content:'mx.old-provider.net'}];},
    (m:ReturnType<typeof api>)=>{m.state.records=[{...dns[1],content:'v=spf1 include:old.net ~all'}];},
    (m:ReturnType<typeof api>)=>{m.state.account='b'.repeat(32);},
    (m:ReturnType<typeof api>)=>{m.state.rules=[{...managed(),name:'manually-created'}];},
    (m:ReturnType<typeof api>)=>{m.state.rules=[managed(),{...managed(),id:'duplicate'}];},
    (m:ReturnType<typeof api>)=>{m.state.required=[];},
  ]) {
    const m=api();setup(m);
    await expect(reconcileEmailRouting(spec,'mail',true,'token',m.request)).rejects.toThrow();
    expect(m.writes()).toEqual([]);
  }
});

test('an owned rule updates its destination while foreign, catch-all and removed rules remain intact',async()=>{
  const m=api();m.state.records=structuredClone(dns);m.state.settings={enabled:true,status:'ready'};
  const unrelated={...managed('someone@example.com'),id:'foreign',name:'manual'};
  const retained={...managed('old@example.com'),id:'retained'};
  const catchAll={...managed(),id:'catchall',name:'catch-all',matchers:[{type:'all'}]};
  m.state.rules=[managed('contact@example.com','old@example.net'),unrelated,retained,catchAll];
  const plan=await reconcileEmailRouting(spec,'mail',true,'token',m.request);
  expect(plan.retainedRules).toEqual(['2server:mail:old@example.com']);
  expect(m.writes().map(c=>c.method)).toEqual(['PUT']);
  expect(m.state.rules.slice(1)).toEqual([unrelated,retained,catchAll]);
});

test('pagination finds a destination and foreign rule beyond page one',async()=>{
  const m=api();
  m.state.destinations.unshift(...Array.from({length:50},(_,i)=>({id:`d-${i}`,email:`a${i}@example.net`,verified:null})));
  expect((await reconcileEmailRouting(spec,'mail',true,'token',m.request)).status).toBe('ready');
  expect(m.writes().some(c=>c.path.endsWith('/addresses'))).toBe(false);
  const n=api();n.state.rules=Array.from({length:50},(_,i)=>({...managed(`user${i}@example.com`),id:`r-${i}`,name:`foreign-${i}`}));
  n.state.rules.push({...managed(),name:'foreign-on-page-two'});
  await expect(reconcileEmailRouting(spec,'mail',true,'token',n.request)).rejects.toThrow('foreign');
  expect(n.writes()).toEqual([]);
});

test('concurrent DNS/rule edits fail closed and a misconfigured apply is never reported ready',async()=>{
  const dnsChange=api();dnsChange.state.changeDns=()=>{dnsChange.state.records.push({...dns[0],content:'new-provider.net'});};
  await expect(reconcileEmailRouting(spec,'mail',true,'token',dnsChange.request)).rejects.toThrow('conflicts');
  expect(dnsChange.writes()).toEqual([]);
  const rulesChange=api();rulesChange.state.records=structuredClone(dns);rulesChange.state.settings={enabled:true,status:'ready'};
  rulesChange.state.changeRules=()=>{rulesChange.state.rules.push({...managed(),name:'someone-else'});};
  await expect(reconcileEmailRouting(spec,'mail',true,'token',rulesChange.request)).rejects.toThrow('foreign');
  expect(rulesChange.writes()).toEqual([]);
  const notReady=api();notReady.state.notReady=true;
  await expect(reconcileEmailRouting(spec,'mail',true,'token',notReady.request)).rejects.toThrow('not ready');
});

test('permission failures identify the operation without exposing credentials or provider error bodies',async()=>{
  const m=api();m.state.failPath=`/accounts/${spec.accountId}/email/routing/addresses`;
  await expect(reconcileEmailRouting(spec,'mail',true,'private-token',m.request)).rejects.toThrow('Email Routing Addresses: Edit');
  try {await reconcileEmailRouting(spec,'mail',true,'private-token',m.request);} catch(e) {
    expect(String(e)).not.toContain('private-token');expect(String(e)).not.toContain('secret-token');
  }
  expect(m.writes()).toEqual([]);
});

test('source CLI plans without SSH and refuses unsupported retirement and VM options',async()=>{
  const m=api(),dir=await mkdtemp(join(tmpdir(),'email-source-')),file=join(dir,'mail.yaml');
  await Bun.write(file,Bun.YAML.stringify({...templateApp('mail','email-routing'),spec}));
  const previousFetch=globalThis.fetch,previousToken=process.env.CLOUDFLARE_API_TOKEN;
  globalThis.fetch=m.request;process.env.CLOUDFLARE_API_TOKEN='test-token';
  try {
    expect(await fileCommand(['plan','-f',file])).toBe(true);
    for(const args of [['delete','-f',file,'--apply'],['deploy','-f',file,'--port','2222'],['deploy','-f',file,'--image','image:tag']])
      await expect(fileCommand(args)).rejects.toThrow();
    expect(m.writes()).toEqual([]);
  } finally {
    globalThis.fetch=previousFetch;
    if(previousToken===undefined)delete process.env.CLOUDFLARE_API_TOKEN;else process.env.CLOUDFLARE_API_TOKEN=previousToken;
    await rm(dir,{recursive:true,force:true});
  }
});

test('an explicit VM connection reads credentials in a read-only session and never publishes Cloudflare workload state',async()=>{
  const m=api(),dir=await mkdtemp(join(tmpdir(),'email-vm-token-')),file=join(dir,'mail.yaml'),manifest=join(dir,'server.json');
  await Bun.write(file,Bun.YAML.stringify({...templateApp('mail','email-routing'),spec}));
  const c=configSchema.parse({version:1,name:'test',ssh:{kind:'ssh',host:'host.example',user:'operator'},edge:{mode:'managed'},cloudflare:{tokenEnv:'CF_VM_TOKEN'}});
  await Bun.write(manifest,JSON.stringify(c));
  const previousFetch=globalThis.fetch,previousSession=fileOperations.connectedCommand,previousToken=process.env.CF_VM_TOKEN;
  globalThis.fetch=m.request;
  const sessions:string[][]=[];
  fileOperations.connectedCommand=async(args,execute)=>{
    sessions.push(args);
    process.env.CF_VM_TOKEN='vm-token';
    await execute([...args,'-f',manifest]);
    return true;
  };
  try {
    expect(await fileCommand(['deploy','-f',file,'--connection','vm.json','--apply'])).toBe(true);
    expect(sessions).toEqual([['extension-credentials','--connection','vm.json']]);
    expect(JSON.parse(await Bun.file(manifest).text())).toEqual(c);
    expect((await Bun.file(file).text())).not.toContain('vm-token');
    expect(m.writes().length).toBe(2);
  } finally {
    globalThis.fetch=previousFetch;fileOperations.connectedCommand=previousSession;
    if(previousToken===undefined)delete process.env.CF_VM_TOKEN;else process.env.CF_VM_TOKEN=previousToken;
    await rm(dir,{recursive:true,force:true});
  }
});

test('required mail DNS on a DKIM hostname is inspected and verified separately from the apex',async()=>{
  const m=api();m.state.required.push({type:'TXT',name:'cf2026._domainkey.example.com',content:'v=DKIM1; p=public-test-key'});
  expect((await reconcileEmailRouting(spec,'mail',true,'token',m.request)).status).toBe('ready');
  expect(m.state.records.some(r=>r.name==='cf2026._domainkey.example.com')).toBe(true);
});

test('Cloudflare quoted TXT RDATA matches unquoted DNS and detects quoted foreign SPF',async()=>{
  const m=api();m.state.records=structuredClone(dns);m.state.settings={enabled:true,status:'ready'};
  m.state.required[1].content='"v=spf1 " "include:_spf.mx.cloudflare.net ~all"';
  expect((await reconcileEmailRouting(spec,'mail',true,'token',m.request)).status).toBe('ready');
  expect(m.writes().map(c=>c.path)).toEqual(['/zones/zone-1/email/routing/rules']);
  const conflict=api();conflict.state.records=[{...dns[1],content:'"v=spf1 include:other.example ~all"'}];
  await expect(reconcileEmailRouting(spec,'mail',true,'token',conflict.request)).rejects.toThrow('conflicts');
  expect(conflict.writes()).toEqual([]);
});

test('explicit MX replacement is exact, waits for verification and leaves unrelated DNS intact',async()=>{
  const input={...spec,replaceMx:[{content:'inbound.postmarkapp.com',priority:1000}]};
  const old={...dns[0],id:'f'.repeat(32),content:'inbound.postmarkapp.com',priority:1000};
  const m=api();m.state.records=[old,{type:'TXT',name:spec.zone,content:'unrelated-verification'}];m.state.destinations=[];
  expect((await reconcileEmailRouting(input,'mail',false,'token',m.request)).replaceMx).toEqual(input.replaceMx);
  expect(m.writes()).toEqual([]);
  expect((await reconcileEmailRouting(input,'mail',true,'token',m.request)).status).toBe('pending-verification');
  expect(m.state.records).toContainEqual(old);
  m.state.destinations[0].verified='verified';m.state.calls=[];
  expect((await reconcileEmailRouting(input,'mail',true,'token',m.request)).status).toBe('ready');
  expect(m.writes()[0]).toMatchObject({method:'DELETE',path:`/zones/zone-1/dns_records/${old.id}`});
  expect(m.state.records).toContainEqual({type:'TXT',name:spec.zone,content:'unrelated-verification'});
  const n=api();n.state.records=[{...old,priority:999}];
  await expect(reconcileEmailRouting(input,'mail',true,'token',n.request)).rejects.toThrow('conflicts');
  expect(n.writes()).toEqual([]);
});
