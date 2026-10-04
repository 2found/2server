import { z } from 'zod';
import { hostname,name } from '../../../shared/domain/schema';
const durations=[10,15,20,30,40,45,60,90,120,180,240,300,480,600,900,1200,1800,2400,3600,65535,86400];
const duration=z.number().int().refine(v=>durations.includes(v),'Unsupported Cloudflare duration');
const route=z.string().startsWith('/').max(1024).refine(v=>!/[\x00-\x20"\\?#]/.test(v),'Use a URL path without query, whitespace or expression syntax');
export const zonePolicySchema=z.object({
 cacheRules:z.array(z.object({
  name,
  hosts:z.array(hostname).min(1).max(50),
  paths:z.array(z.union([
   z.object({exact:route}).strict(),
   z.object({prefix:route,suffix:route.optional()}).strict(),
  ])).min(1).max(20),
  mode:z.enum(['respect-origin','bypass']).default('respect-origin'),
  cookies:z.enum(['bypass','allow']).default('bypass'),
  bypassCookies:z.array(z.string().regex(/^[A-Za-z0-9_-]{1,80}$/)).max(20).default([]),
  enabled:z.boolean().default(true),
 }).strict()).max(100).refine(r=>new Set(r.map(x=>x.name)).size===r.length,'Duplicate cache-rule names').optional(),
 rateLimit:z.object({
  // Free cannot match http.host. Zone-wide matching must be explicit.
  scope:z.enum(['zone','hosts']),
  hosts:z.array(hostname).min(1).max(50).optional(),
  rules:z.array(z.object({
   name,
   paths:z.array(z.object({value:route,match:z.enum(['exact','prefix']).default('exact')}).strict()).min(1).max(20),
   requests:z.number().int().min(1).max(1000000),
   period:duration.default(10),
   mitigationSeconds:duration.default(10),
   excludeVerifiedBots:z.boolean().default(true),
   enabled:z.boolean().default(true),
  }).strict()).max(100),
 }).strict().refine(r=>r.scope==='hosts'?!!r.hosts:!r.hosts,'hosts requires scope: hosts; zone scope must omit hosts')
 .refine(r=>new Set(r.rules.map(x=>x.name)).size===r.rules.length,'Duplicate rate-limit names').optional(),
 }).strict();
export const zoneSchema=z.object({zone:hostname,...zonePolicySchema.shape}).strict().superRefine((p,ctx)=>{
 for(const host of [...(p.rateLimit?.hosts??[]),...(p.cacheRules??[]).flatMap(r=>r.hosts)])
  if(host!==p.zone&&!host.endsWith('.'+p.zone))ctx.addIssue({code:'custom',message:`${host} is outside ${p.zone}`});
});
export type Zone=z.infer<typeof zoneSchema>;
export type RateRule={id?:string;ref?:string;description?:string;expression:string;action:string;enabled:boolean;ratelimit:Record<string,unknown>};
export function ruleOwner(server:string,zone:string){return `2server:${server}:zone:${zone}:rate:`}
export function checkPlan(plan:string,p:Zone,current:RateRule[],desired:RateRule[]){
 const tier=plan.toLowerCase();
 const limits=tier.includes('free')?{count:1,period:10,timeout:10,hosts:false}:tier.includes('pro')?{count:2,period:60,timeout:3600,hosts:true}:tier.includes('business')?{count:5,period:600,timeout:86400,hosts:true}:tier.includes('enterprise')?{count:100,period:65535,timeout:86400,hosts:true}:undefined;
 if(!limits)throw Error(`Unknown Cloudflare plan: ${plan}; refusing to assume rate-limit entitlements`);
 if(p.rateLimit?.scope==='hosts'&&!limits.hosts&&desired.length)throw Error('Cloudflare Free cannot match hostname in rate limits. Use explicit scope: zone with unique paths, or upgrade the zone.');
 const count=current.length+desired.filter(d=>!current.some(r=>r.ref===d.ref)).length;
 if(count>limits.count)throw Error(`Cloudflare ${plan} rate-limit capacity: ${current.length}/${limits.count} slots occupied; desired total ${count}. Existing rules are retained. Review them in Cloudflare or upgrade; 2server never replaces foreign rules.`);
 for(const rule of desired){
  if(Number(rule.ratelimit.period)>limits.period||Number(rule.ratelimit.mitigation_timeout)>limits.timeout)throw Error(`Rate-limit duration exceeds Cloudflare ${plan} allowance`);
  const matches=current.filter(r=>r.ref===rule.ref);
  if(matches.length>1||matches.some(r=>r.description!==rule.description))throw Error('Rate-limit ownership conflict');
 }
}
