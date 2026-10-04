import {expect,test} from 'bun:test';
import {Cloudflare,applyPolicies,cacheRule} from '../src/modules/domains/infrastructure/cloudflare';
import {zoneSchema} from '../src/modules/zones/domain/schema';
import {applyZone,inspectZone,cacheRules} from '../src/modules/zones/infrastructure/cloudflare';
const raw={zone:'example.com',cacheRules:[{name:'public-images',hosts:['photos.example.com'],paths:[{prefix:'/local-api/templates/',suffix:'/image'}],cookies:'allow',bypassCookies:['__Host-admin']}]};
function provider(count=1){
 let rows:any[]=Array.from({length:count},(_,i)=>({id:'foreign'+i,ref:'foreign'+i,description:'Manual',expression:'false',action:'set_cache_settings',enabled:true,action_parameters:{cache:false}}));
 const calls:any[]=[];
 const cf=new Cloudflare('test',(async(url:any,init:any)=>{
  const path=new URL(url).pathname.replace('/client/v4',''),body=init.body?JSON.parse(init.body):undefined,method=init.method;
  calls.push({path,body,method});let result:any;
  if(path==='/zones')result=[{id:'zone',name:'example.com',status:'active'}];
  else if(path==='/zones/zone')result={plan:{name:'Free'}};
  else if(path.includes('/phases/http_ratelimit/'))result={id:'rates',rules:[]};
  else if(path.includes('/phases/'))result={id:'cache',rules:rows};
  else if(path.includes('/rulesets/cache/rules')){
   const id=method==='PATCH'?path.split('/').at(-1):'managed'+rows.length;
   if(body.position?.after===''&&rows.at(-1)?.id===id)throw Error('Provider rejects already-last movement');
   const {position,...rule}=body;
   if(method==='PATCH'&&!position)rows=rows.map(r=>r.id===id?{...rule,id}:r);
   else {rows=rows.filter(r=>r.id!==id);const index=position?.before?rows.findIndex(r=>r.id===position.before):rows.length;rows.splice(index,0,{...rule,id});}
   result={id:'cache',rules:rows};
  }else throw Error('Unexpected '+method+' '+path);
  return Response.json({success:true,result});
 }) as typeof fetch);
 return {cf,calls,rows:()=>rows};
}
test('cache schema requires explicit in-zone hosts and safe paths; compiles origin-respecting policy',()=>{
 const p=zoneSchema.parse(raw),r=cacheRules('server',p)[0];
 expect(r.expression).toContain('ends_with');expect(r.expression).toContain('__Host-admin=');expect(r.expression).toContain('authorization');
 expect(r.action_parameters).toEqual({cache:true,edge_ttl:{mode:'respect_origin'},browser_ttl:{mode:'respect_origin'}});
 expect(r.action_parameters).not.toHaveProperty('cache_key');expect(r.ref!.length).toBeLessThan(64);
 for(const rule of [{...raw.cacheRules[0],hosts:['evil.com']},{...raw.cacheRules[0],hosts:undefined},{...raw.cacheRules[0],paths:[{exact:'/x?secret=1'}]},{...raw.cacheRules[0],ttl:100}])expect(()=>zoneSchema.parse({...raw,cacheRules:[rule]})).toThrow();
 expect(()=>zoneSchema.parse({...raw,cacheRules:[raw.cacheRules[0],raw.cacheRules[0]]})).toThrow();
 const defaults=zoneSchema.parse({...raw,cacheRules:[{name:'safe',hosts:['example.com'],paths:[{exact:'/logo.png'}]}]});
 expect(cacheRules('server',defaults)[0].expression).toContain('http.cookie eq ""');
 defaults.cacheRules![0].mode='bypass';expect(cacheRules('server',defaults)[0].action_parameters).toEqual({cache:false});
 expect(cacheRules('server',defaults)[0].expression).not.toContain('authorization');
});
test('Free cache capacity preflight prevents ALL mutations, including rate writes',async()=>{
 const m=provider(10),p=zoneSchema.parse({...raw,rateLimit:{scope:'zone',rules:[{name:'submit',paths:[{value:'/jobs'}],requests:5}]}});
 await expect(applyZone(m.cf,'server',p)).rejects.toThrow('10/10');expect(m.calls.every(c=>c.method==='GET')).toBe(true);
});
test('narrow cache writes preserve foreign rules, are idempotent, support disabling and retain omitted rules',async()=>{
 const m=provider(),p=zoneSchema.parse({...raw,cacheRules:[...raw.cacheRules,{name:'private',hosts:['photos.example.com'],paths:[{prefix:'/private/'}],mode:'bypass'}]});
 await inspectZone(m.cf,'server',p);expect(m.calls.every(c=>c.method==='GET')).toBe(true);
 const foreign=structuredClone(m.rows()[0]);await applyZone(m.cf,'server',p);
 const writes=()=>m.calls.filter(c=>c.method!=='GET').length;const before=writes();await applyZone(m.cf,'server',p);expect(writes()).toBe(before);
 expect(m.rows()[0]).toEqual(foreign);expect(m.rows()).toHaveLength(3);
 p.cacheRules![0].enabled=false;await applyZone(m.cf,'server',p);expect(m.rows()[1].enabled).toBe(false);
 await applyZone(m.cf,'server',zoneSchema.parse({zone:'example.com',cacheRules:[]}));expect(m.rows()).toHaveLength(3);
 expect(m.calls.some(c=>['PUT','DELETE'].includes(c.method))).toBe(false);
 m.rows()[1].description='Hijacked';await expect(inspectZone(m.cf,'server',p)).rejects.toThrow('ownership');
});
test('Domain redeploy keeps its baseline before Zone overrides',async()=>{
 for(const cache of ['app','images'] as const){
  const m=provider(),p=zoneSchema.parse(raw);
  await applyZone(m.cf,'server',p);
  const domain={name:'photos',zone:'example.com',hosts:['photos.example.com'],cache,adoptDns:false,requireAuth:false,routes:[],upstream:{kind:'import' as const,name:'up_photos'}};
  const plan={domain,zoneId:'zone',dns:[],sslChange:false,rule:cacheRule('server',domain)};
  await applyPolicies(m.cf,[plan]);await applyPolicies(m.cf,[plan]);
  expect(m.rows().at(-1).ref).toBe(cacheRules('server',p)[0].ref);
  expect(m.rows().at(-2).ref).toBe(plan.rule.ref);
  expect(m.rows()[0].ref).toBe('foreign0');
  const before=m.calls.length;await applyZone(m.cf,'server',p);expect(m.calls.slice(before).every(c=>c.method==='GET')).toBe(true);
 }
});
