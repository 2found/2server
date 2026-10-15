import { afterEach,expect,test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir,mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema,type Config } from '../src/modules/config/application/config';
import { domainChanges,unchangedOperations,verifyUnchanged } from '../src/modules/domains/application/unchanged';
import { domainSchema,type Domain } from '../src/modules/domains/domain/schema';
import { cacheRule,type DomainPlan } from '../src/modules/domains/infrastructure/cloudflare';
import { renderSite } from '../src/modules/domains/infrastructure/render';
import { fileCommand,fileOperations } from '../src/modules/source/cli/command';
import { authoritativeApp } from '../src/modules/source/domain/app';
import { parseDocument } from '../src/modules/source/application/documents';
import { setSessionState } from '../src/shared/infrastructure/operator-state';
import { run } from '../src/shared/infrastructure/process';
import { setVmSecrets } from '../src/shared/infrastructure/vm-secrets';

const domain=domainSchema.parse({name:'api',zone:'example.com',hosts:['api.example.com'],upstream:{kind:'proxy',target:'api:8080'}});
const config=(d:Domain=domain)=>configSchema.parse({version:1,name:'srv',ssh:{kind:'ssh',host:'192.0.2.10',user:'operator'},edge:{mode:'managed'},domains:[d]});
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const originalFiles={...fileOperations};
afterEach(()=>{Object.assign(fileOperations,originalFiles);setSessionState();setVmSecrets();});

async function pair(state:string,days=90) {
  const tmp=await mkdtemp(join(tmpdir(),'unchanged-cert-'));
  try {
    await run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days',String(days),'-keyout',join(tmp,'key'),'-out',join(tmp,'cert'),'-subj','/CN=api.example.com','-addext','subjectAltName=DNS:api.example.com']);
    const value={cert:await Bun.file(join(tmp,'cert')).text(),key:await Bun.file(join(tmp,'key')).text(),requestedValidity:365};
    await mkdir(join(state,'certificates','api'),{recursive:true});
    await writeFile(join(state,'certificates','api','pair.json'),JSON.stringify(value));
    return value;
  } finally {await rm(tmp,{recursive:true,force:true});}
}
// Everything the domain phase would write, already in place.
function current(c:Config,p:{cert:string;key:string},change:Partial<{digests:Record<string,string>;hosts:string[];plan:Partial<DomainPlan>}>={}) {
  const rule={...cacheRule(c.name,domain),id:'managed'};
  const plan:DomainPlan={domain,zoneId:'zone',dns:[{host:'api.example.com',change:false}],sslChange:false,rule:cacheRule(c.name,domain),ruleset:{id:'set',rules:[{id:'manual',ref:'manual',expression:'true',action:'set_cache_settings',action_parameters:{},description:'manual',enabled:true},rule]},...change.plan};
  const reads={edge:0,inspect:0,verify:0};
  const ops={...unchangedOperations,
    auth:async()=>({}),
    readEdge:async()=>{reads.edge++;return {digests:change.digests??{'sites/api.caddy':sha(renderSite(domain)),'tls/api/cert.pem':sha(p.cert),'tls/api/key.pem':sha(p.key)},hosts:change.hosts??['api.example.com','other.example.com']};},
    inspect:async()=>{reads.inspect++;return [plan];},
    verifyOrigin:async()=>{reads.verify++;},
    verifyPublic:async()=>{reads.verify++;},
  };
  return {ops,reads};
}

test('unchanged domains need no reservation; any difference or failed read keeps the locked phase',async()=>{
  const state=await mkdtemp(join(tmpdir(),'unchanged-state-'));
  try {
    const c=config(),p=await pair(state);
    const {ops,reads}=current(c,p);
    const result=await domainChanges(c,[domain],state,ops);
    expect(result).toEqual({auth:{}});
    expect(reads).toEqual({edge:1,inspect:1,verify:0});
    expect(await verifyUnchanged(c,[domain],{},ops)).toBe(true);
    expect(reads.verify).toBe(2);

    const reason=async(c2:Config,ops2:typeof ops,d=domain)=>{const r=await domainChanges(c2,[d],state,ops2);return 'reason' in r?r.reason:'unchanged';};
    // Spec: a new host, or a domain the snapshot does not have yet.
    const wider=domainSchema.parse({...domain,hosts:['api.example.com','www.example.com']});
    expect(await reason(c,ops,wider)).toContain('spec changed');
    expect(await reason(configSchema.parse({...c,domains:[]}),ops)).toContain('spec changed');
    // Edge: a missing or different site, a different certificate, an unpublished host.
    expect(await reason(c,current(c,p,{digests:{'sites/api.caddy':'-','tls/api/cert.pem':sha(p.cert),'tls/api/key.pem':sha(p.key)}}).ops)).toContain('edge sites/api.caddy differs');
    expect(await reason(c,current(c,p,{digests:{'sites/api.caddy':sha(renderSite(domain)),'tls/api/cert.pem':sha('old'),'tls/api/key.pem':sha(p.key)}}).ops)).toContain('tls/api/cert.pem');
    expect(await reason(c,current(c,p,{hosts:['other.example.com']}).ops)).toContain('hosts not published');
    // Cloudflare: DNS, SSL mode, cache rule content and order.
    expect(await reason(c,current(c,p,{plan:{dns:[{host:'api.example.com',change:true}]}}).ops)).toContain('DNS');
    expect(await reason(c,current(c,p,{plan:{sslChange:true}}).ops)).toContain('SSL');
    expect(await reason(c,current(c,p,{plan:{ruleset:{id:'set',rules:[{...cacheRule(c.name,domain),id:'managed',enabled:false}]}}}).ops)).toContain('cache rules');
    expect(await reason(c,current(c,p,{plan:{ruleset:{id:'set',rules:[{...cacheRule(c.name,domain),id:'managed'},{id:'zone',ref:'two_zone_cache_x',expression:'true',action:'set_cache_settings',action_parameters:{},description:'zone',enabled:true}]}}}).ops)).toBe('unchanged');
    expect(await reason(c,current(c,p,{plan:{ruleset:{id:'set',rules:[{id:'zone',ref:'two_zone_cache_x',expression:'true',action:'set_cache_settings',action_parameters:{},description:'zone',enabled:true},{...cacheRule(c.name,domain),id:'managed'}]}}}).ops)).toContain('cache rules');
    expect(await reason(c,current(c,p,{plan:{ruleset:undefined}}).ops)).toContain('cache rules');
    // A read that fails is a reason to take the reservation, not a skip.
    expect(await reason(c,{...ops,readEdge:async()=>{throw Error('ssh down');}})).toBe('check failed: ssh down');
    expect(await reason(c,{...ops,inspect:async()=>{throw Error('Cloudflare 403');}})).toBe('check failed: Cloudflare 403');
    // A failed route check also hands over to the locked phase.
    expect(await verifyUnchanged(c,[domain],{},{...ops,verifyPublic:async()=>{throw Error('502');}})).toBe(false);
  } finally {await rm(state,{recursive:true,force:true});}
});

test('a certificate due for renewal or with a shorter validity keeps the locked phase before any remote read',async()=>{
  const state=await mkdtemp(join(tmpdir(),'unchanged-renew-'));
  try {
    const c=config();
    const {ops,reads}=current(c,await pair(state,20));
    const r=await domainChanges(c,[domain],state,ops);
    expect('reason' in r&&r.reason).toContain('certificate');
    expect(reads).toEqual({edge:0,inspect:0,verify:0});
    const long=domainSchema.parse({...domain,certificate:{validityDays:5475}});
    const p=await pair(state);
    expect('reason' in await domainChanges(config(long),[long],state,current(config(long),p).ops)).toBe(true);
  } finally {await rm(state,{recursive:true,force:true});}
});

test('an App deploy skips the domains reservation only when its domains are unchanged and verified',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'unchanged-deploy-'));
  try {
    const digest='registry:5000/api@sha256:'+'a'.repeat(64);
    const raw={apiVersion:'2server.app/v1',kind:'App',metadata:{name:'api'},spec:{image:digest,port:8080,memoryMb:128,cpus:1},domains:[{name:'api',zone:'example.com',hosts:['api.example.com'],upstream:{kind:'proxy',target:'api:8080'}}]};
    const file=join(dir,'app.yaml'),server=join(dir,'server.json');await writeFile(file,Bun.YAML.stringify(raw));
    const app=authoritativeApp(parseDocument(raw) as any,digest);
    const c=configSchema.parse({...config(),apps:[app]});
    setSessionState(join(dir,'state'));
    let prepared=0;const published:string[][]=[];
    fileOperations.connectedCommand=async(args,fn)=>{await fn([...args,'-f',server],{prepareDomains:async()=>{prepared++;}});return true;};
    fileOperations.resolveImage=async()=>digest;fileOperations.preflightEdge=async()=>'';fileOperations.planSourceDomains=async()=>{};fileOperations.deployApp=async()=>{};
    fileOperations.resourceCommand=async args=>{published.push(args.slice(0,3));return true;};
    const cases:[Awaited<ReturnType<typeof domainChanges>>,boolean,boolean][]=[
      [{auth:{}},true,false],          // unchanged and verified: no reservation, no edge release
      [{auth:{}},false,true],          // unchanged but the routes failed: republish under the lock
      [{reason:'api DNS needs an update'},true,true],
    ];
    for(const [result,verified,locked] of cases) {
      await writeFile(server,JSON.stringify(c));prepared=0;published.length=0;
      fileOperations.domainChanges=async()=>result;fileOperations.verifyUnchanged=async()=>verified;
      await fileCommand(['deploy','-f',file,'--ssh','operator@192.0.2.10','--apply']);
      expect(prepared).toBe(locked?1:0);
      expect(published).toEqual(locked?[['update','domain','api']]:[]);
    }
  } finally {await rm(dir,{recursive:true,force:true});}
});
