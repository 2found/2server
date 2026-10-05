import { createHash } from 'node:crypto';
import { Cloudflare,CloudflareError,type Rule } from '../../domains/infrastructure/cloudflare';
import { checkPlan,checkWafPlan,ruleOwner,wafRuleOwner,type Zone,type RateRule,type WafRule } from '../domain/schema';
export function rateRules(server:string,p:Zone):RateRule[]{
 const r=p.rateLimit;if(!r)return [];
 return r.rules.map(rule=>({
  ref:'two_rate_'+createHash('sha256').update(ruleOwner(server,p.zone)+rule.name).digest('hex').slice(0,40),
  description:ruleOwner(server,p.zone)+rule.name,action:'block',enabled:rule.enabled,
  expression:`(${rule.paths.map(x=>x.match==='prefix'?`starts_with(http.request.uri.path, ${JSON.stringify(x.value)})`:`http.request.uri.path eq ${JSON.stringify(x.value)}`).join(' or ')})`+
   (r.scope==='hosts'?` and http.host in {${r.hosts!.map(h=>JSON.stringify(h)).join(' ')}}`:'')+
   (rule.excludeVerifiedBots?' and not cf.client.bot':''),
  ratelimit:{characteristics:['cf.colo.id','ip.src'],period:rule.period,requests_per_period:rule.requests,mitigation_timeout:rule.mitigationSeconds},
 }));
}
export function wafRules(server:string,p:Zone):WafRule[]{
 return (p.wafRules??[]).map(rule=>{
  const owner=wafRuleOwner(server,p.zone);
  const ua=rule.userAgents.map(u=>`lower(http.user_agent) contains ${JSON.stringify(u.toLowerCase())}`).join(' or ');
  const except=rule.exceptPaths.map(path=>`http.request.uri.path eq ${JSON.stringify(path)}`).join(' or ');
  return {
   ref:'two_waf_'+createHash('sha256').update(owner+rule.name).digest('hex').slice(0,40),
   description:owner+rule.name,action:rule.action,enabled:rule.enabled,
   expression:`http.host in {${rule.hosts.map(h=>JSON.stringify(h)).join(' ')}} and (${ua})`+
    (rule.excludeVerifiedBots?' and not cf.client.bot':'')+
    (except?` and not (${except})`:''),
  };
 });
}
type Ruleset={id:string;rules?:RateRule[]};
export type ZonePlan={zone:string;zoneId:string;plan:string;cacheRules?:{occupied:number;changes:{name:string;action:'create'|'update'|'keep';rule:Rule}[]};rateLimit?:{scope:string;occupied:number;changes:{name:string;action:'create'|'update'|'keep';rule:RateRule}[]};wafRules?:{occupied:number;changes:{name:string;action:'create'|'update'|'keep';rule:WafRule}[]}};
type WafRuleset={id:string;rules?:WafRule[]};
const ratePermission='Zone WAF: Edit (rate limiting)';
const wafPermission='Zone WAF: Edit (custom rules)';
async function ruleset(cf:Cloudflare,zone:string):Promise<Ruleset|undefined>{
 try{return await cf.call('GET',`/zones/${zone}/rulesets/phases/http_ratelimit/entrypoint`,undefined,ratePermission)}
 catch(e){if(e instanceof CloudflareError&&e.status===404&&e.codes.includes(10003))return;throw e}
}
function sameRule(a:RateRule,b:RateRule){return a.expression===b.expression&&a.action===b.action&&a.enabled===b.enabled&&a.description===b.description&&Object.entries(b.ratelimit).every(([key,value])=>JSON.stringify(a.ratelimit?.[key])===JSON.stringify(value))}
async function wafRuleset(cf:Cloudflare,zone:string):Promise<WafRuleset|undefined>{
 try{return await cf.call('GET',`/zones/${zone}/rulesets/phases/http_request_firewall_custom/entrypoint`,undefined,wafPermission)}
 catch(e){if(e instanceof CloudflareError&&e.status===404&&e.codes.includes(10003))return;throw e}
}
function sameWafRule(a:WafRule,b:WafRule){return a.expression===b.expression&&a.action===b.action&&a.enabled===b.enabled&&a.description===b.description}
export async function inspectZone(cf:Cloudflare,server:string,p:Zone):Promise<ZonePlan>{
 const zoneId=await cf.zone(p.zone);
 const zone=await cf.call<{plan:{name:string}}>('GET',`/zones/${zoneId}`);
 const result:ZonePlan={zone:p.zone,zoneId,plan:zone.plan.name};
 if(p.rateLimit){
  const current=(await ruleset(cf,zoneId))?.rules??[],desired=rateRules(server,p);
  checkPlan(zone.plan.name,p,current,desired);
  result.rateLimit={scope:p.rateLimit.scope,occupied:current.length,changes:desired.map(rule=>{const old=current.find(r=>r.ref===rule.ref);return {name:rule.description!,action:old?sameRule(old,rule)?'keep':'update':'create',rule}})};
 }
 if(p.cacheRules){
  const current=(await cf.ruleset(zoneId))?.rules??[],desired=cacheRules(server,p);
  checkCachePlan(result.plan,current,desired);
  const ordered=cacheOrderMatches(current,desired);
  result.cacheRules={occupied:current.length,changes:desired.map(rule=>{const old=current.find(r=>r.ref===rule.ref);return {name:rule.description,action:old?sameCacheRule(old,rule)&&ordered?'keep':'update':'create',rule}})};
 }
 if(p.wafRules){
  const current=(await wafRuleset(cf,zoneId))?.rules??[],desired=wafRules(server,p);
  checkWafPlan(result.plan,current,desired);
  result.wafRules={occupied:current.length,changes:desired.map(rule=>{const old=current.find(r=>r.ref===rule.ref);return {name:rule.description,action:old?sameWafRule(old,rule)?'keep':'update':'create',rule}})};
 }
 return result;
}
export async function applyZone(cf:Cloudflare,server:string,p:Zone){
 const plan=await inspectZone(cf,server,p);
 for(const desired of rateRules(server,p)){
  // Re-read before each narrow write; never replace the zone's whole ruleset.
  const current=await ruleset(cf,plan.zoneId),rows=current?.rules??[];
  checkPlan(plan.plan,p,rows,rateRules(server,p));
  const old=rows.find(r=>r.ref===desired.ref);
  if(old&&sameRule(old,desired))continue;
  if(!current)await cf.call('POST',`/zones/${plan.zoneId}/rulesets`,{name:'2server rate limits',kind:'zone',phase:'http_ratelimit',rules:[desired]},ratePermission);
  else await cf.call(old?'PATCH':'POST',`/zones/${plan.zoneId}/rulesets/${current.id}/rules${old?'/'+old.id:''}`,desired,ratePermission);
 }
 for(const desired of wafRules(server,p)){
  // Same narrow-write discipline as rate limits: only owned refs are
  // patched/created; foreign custom rules are preserved.
  const current=await wafRuleset(cf,plan.zoneId),rows=current?.rules??[];
  checkWafPlan(plan.plan,rows,wafRules(server,p));
  const old=rows.find(r=>r.ref===desired.ref);
  if(old&&sameWafRule(old,desired))continue;
  if(!current)await cf.call('POST',`/zones/${plan.zoneId}/rulesets`,{name:'2server custom rules',kind:'zone',phase:'http_request_firewall_custom',rules:[desired]},wafPermission);
  else await cf.call(old?'PATCH':'POST',`/zones/${plan.zoneId}/rulesets/${current.id}/rules${old?'/'+old.id:''}`,desired,wafPermission);
 }
 const desired=cacheRules(server,p);
 const initial=(await (p.cacheRules?cf.ruleset(plan.zoneId):Promise.resolve(undefined)))?.rules??[];
 const ordered=cacheOrderMatches(initial,desired);
 for(const rule of desired){
  const current=await cf.ruleset(plan.zoneId),rows=current?.rules??[];
  checkCachePlan(plan.plan,rows,desired);
  const old=rows.find(r=>r.ref===rule.ref);
  if(old&&sameCacheRule(old,rule)&&ordered)continue;
  if(!current)await cf.call('POST',`/zones/${plan.zoneId}/rulesets`,{name:'2server cache policies',kind:'zone',phase:'http_request_cache_settings',rules:[rule]});
  else await cf.call(old?'PATCH':'POST',`/zones/${plan.zoneId}/rulesets/${current.id}/rules${old?'/'+old.id:''}`,{
   ...rule,...(old&&(ordered||rows.at(-1)?.id===old.id)?{}:{position:{after:''}}),
  });
 }
 return plan;
}

export function cacheRules(server:string,p:Zone):Rule[]{
 return (p.cacheRules??[]).map(rule=>{
  const owner=`2server:${server}:zone:${p.zone}:cache:${rule.name}`;
  const paths=rule.paths.map(path=>'exact' in path?`http.request.uri.path eq ${JSON.stringify(path.exact)}`:
   `(starts_with(http.request.uri.path, ${JSON.stringify(path.prefix)})${path.suffix?` and ends_with(http.request.uri.path, ${JSON.stringify(path.suffix)})`:''})`).join(' or ');
  const scope=`http.host in {${rule.hosts.map(h=>JSON.stringify(h)).join(' ')}} and (${paths})`;
  return {
   ref:'two_zone_cache_'+createHash('sha256').update(owner).digest('hex').slice(0,40),description:owner,
   enabled:rule.enabled,action:'set_cache_settings',
   expression:`(${scope}${rule.mode==='bypass'?'':
    ' and http.request.method in {"GET" "HEAD"} and not any(http.request.headers["authorization"][*] ne "")'+
    (rule.cookies==='bypass'?' and http.cookie eq ""':'')+
    rule.bypassCookies.map(c=>` and not (http.cookie contains ${JSON.stringify(c+'=')})`).join('')})`,
   action_parameters:rule.mode==='bypass'?{cache:false}:{cache:true,edge_ttl:{mode:'respect_origin'},browser_ttl:{mode:'respect_origin'}},
  };
 });
}
function sameCacheRule(a:Rule,b:Rule){return a.expression===b.expression&&a.action===b.action&&a.enabled===b.enabled&&a.description===b.description&&JSON.stringify(a.action_parameters)===JSON.stringify(b.action_parameters)}
function cacheOrderMatches(current:Rule[],desired:Rule[]){return !desired.length||current.slice(-desired.length).map(r=>r.ref).join(',')===desired.map(r=>r.ref).join(',')}
function checkCachePlan(plan:string,current:Rule[],desired:Rule[]){
 const tier=plan.toLowerCase(),limit=tier.includes('free')?10:tier.includes('pro')?25:tier.includes('business')?50:tier.includes('enterprise')?300:undefined;
 if(!limit)throw Error(`Unknown Cloudflare plan: ${plan}; refusing to assume cache-rule entitlements`);
 const count=current.length+desired.filter(d=>!current.some(r=>r.ref===d.ref)).length;
 if(count>limit)throw Error(`Cloudflare ${plan} cache-rule capacity: ${current.length}/${limit} slots occupied; desired total ${count}. Existing rules are retained.`);
 for(const rule of desired){
  const matches=current.filter(r=>r.ref===rule.ref);
  if(matches.length>1||matches.some(r=>r.description!==rule.description))throw Error('Cache-rule ownership conflict');
 }
}
