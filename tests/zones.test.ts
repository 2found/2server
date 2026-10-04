import { expect,test } from 'bun:test';
import { Cloudflare } from '../src/modules/domains/infrastructure/cloudflare';
import { zoneSchema } from '../src/modules/zones/domain/schema';
import { applyZone,inspectZone,rateRules } from '../src/modules/zones/infrastructure/cloudflare';
const raw={zone:'example.com',rateLimit:{scope:'zone',rules:[{name:'images',paths:[{value:'/local-api/jobs'}],requests:5}]}};
function provider(options:{plan?:string;foreign?:boolean;failRates?:boolean}={}){
 let rules:any[]=options.foreign?[{id:'foreign',ref:'manual',expression:'true',description:'Do not touch',enabled:true,action:'block',ratelimit:{}}]:[];
 const calls:{method:string;path:string;body:any}[]=[];
 const cf=new Cloudflare('private-token',(async(url:any,init:any)=>{
  const path=new URL(url).pathname.replace('/client/v4',''),method=init.method,body=init.body?JSON.parse(init.body):undefined;
  calls.push({method,path,body});let result:any;
  if(path==='/zones')result=[{id:'zone',name:'example.com',status:'active'}];
  else if(path==='/zones/zone')result={account:{id:'account'},plan:{name:options.plan??'Free Website'}};
  else if(path.includes('/rulesets/phases/'))result={id:'ruleset',rules};
  else if(path.includes('/rulesets/')){
   if(options.failRates)return Response.json({success:false,errors:[{code:10000,message:'private-provider-error'}]},{status:403});
   const id=method==='PATCH'?path.split('/').at(-1):'rule-'+rules.length;
   rules=method==='PATCH'?rules.map(r=>r.id===id?{...body,id}:r):[...rules,{...body,id}];result={id:'ruleset',rules};
  }else throw Error('Unexpected path '+path);
  return Response.json({success:true,result});
 }) as typeof fetch);
 return {cf,calls,rules:()=>rules};
}
test('zone policy rejects ambiguous scope, expression injection and application-owned Turnstile',()=>{
 const p=zoneSchema.parse(raw);expect(p.rateLimit!.rules[0].period).toBe(10);
 for(const rateLimit of [{...raw.rateLimit,scope:undefined},{...raw.rateLimit,scope:'hosts'},{...raw.rateLimit,hosts:['example.com']},{...raw.rateLimit,rules:[{...raw.rateLimit.rules[0],paths:[{value:'/x" or true'}]}]}])expect(()=>zoneSchema.parse({...raw,rateLimit})).toThrow();
 expect(()=>zoneSchema.parse({zone:'example.com',turnstile:{domains:['example.com']}})).toThrow();
 const rules=rateRules('s'.repeat(48),p);expect(rules[0].ref!.length).toBeLessThan(64);expect(rules[0].expression).not.toContain('http.host');
});
test('read-only plan fails Free capacity without provider writes and preserves foreign rules',async()=>{
 const p=zoneSchema.parse(raw),m=provider({foreign:true});
 await expect(inspectZone(m.cf,'server',p)).rejects.toThrow('1/1 slots occupied');
 await expect(applyZone(m.cf,'server',p)).rejects.toThrow('retained');
 expect(m.calls.every(c=>c.method==='GET')).toBe(true);expect(m.rules()[0].ref).toBe('manual');
});
test('rate apply is narrow, idempotent, updates and disables own rule; never deletes unrelated rules',async()=>{
 const m=provider({plan:'Pro Website',foreign:true});let p=zoneSchema.parse(raw);
 await inspectZone(m.cf,'server',p);expect(m.calls.every(c=>c.method==='GET')).toBe(true);
 await applyZone(m.cf,'server',p);
 const writes=m.calls.filter(c=>c.method!=='GET').length;
 await applyZone(m.cf,'server',p);expect(m.calls.filter(c=>c.method!=='GET')).toHaveLength(writes);
 p.rateLimit!.rules[0].requests=2;p.rateLimit!.rules[0].enabled=false;
 await applyZone(m.cf,'server',p);
 expect(m.rules()).toHaveLength(2);expect(m.rules()[0].description).toBe('Do not touch');expect(m.rules()[1].enabled).toBe(false);expect(m.rules()[1].ratelimit.requests_per_period).toBe(2);
 expect(m.calls.some(c=>c.method==='DELETE'||c.method==='PUT')).toBe(false);
});
test('Free rejects hostname and long durations, paid plan accepts bounded host match',async()=>{
 for(const rateLimit of [{...raw.rateLimit,scope:'hosts',hosts:['example.com']},{...raw.rateLimit,rules:[{...raw.rateLimit.rules[0],period:60}]}]){
  const p=zoneSchema.parse({...raw,rateLimit});await expect(inspectZone(provider().cf,'s',p)).rejects.toThrow();
  const plan=await inspectZone(provider({plan:'Pro Website'}).cf,'s',p);expect(plan.rateLimit!.changes).toHaveLength(1);
 }
});
test('provider permission errors identify WAF permission without secret payloads',async()=>{
 const m=provider({failRates:true}),p=zoneSchema.parse(raw);
 try{await applyZone(m.cf,'s',p);throw Error('Expected failure')}
 catch(e){expect((e as Error).message).toContain('Zone WAF: Edit');expect((e as Error).message).not.toContain('private-')}
});
