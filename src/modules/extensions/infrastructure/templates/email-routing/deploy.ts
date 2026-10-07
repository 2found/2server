import { Cloudflare, CloudflareError, requireCloudflareToken } from '../../../../domains/infrastructure/cloudflare';
import { emailRoutingSpecSchema, type EmailRoutingSpec } from './domain/spec';
import { emailTokenPermission } from './permissions';

type DnsRecord = {id?:string; type:string; name:string; content:string; priority?:number};
type Destination = {id:string; email:string; verified?:string|null};
type Settings = {enabled:boolean; status?:string};
type Rule = {
  id:string; name?:string; enabled?:boolean; priority?:number;
  matchers:Array<{type:string; field?:string; value?:string}>;
  actions:Array<{type:string; value?:string[]}>;
};
const PAGE = 50;
const rulesPermission = 'Email Routing Rules: Edit';
const addressesPermission = 'Email Routing Addresses: Edit';

async function list<T>(cf:Cloudflare, path:string, permission:string):Promise<T[]> {
  const result:T[] = [];
  for (let page=1; page<=10000; page++) {
    const rows = await cf.call<T[]>('GET', `${path}${path.includes('?')?'&':'?'}per_page=${PAGE}&page=${page}`, undefined, permission);
    if (!Array.isArray(rows)) throw new Error('Unexpected Cloudflare list response');
    result.push(...rows);
    if (rows.length<PAGE) return result;
  }
  throw new Error('Cloudflare pagination exceeded its safety limit');
}
function txtValue(content:string) {
  // Email Routing returns quoted TXT RDATA, while DNS records can return
  // unquoted values. Multiple quoted chunks form one logical TXT value.
  const chunks=content.match(/"(?:[^"\\]|\\.)*"/g);
  if (!chunks || content.replace(/"(?:[^"\\]|\\.)*"/g,'').trim()) return content;
  try { return chunks.map(chunk=>JSON.parse(chunk) as string).join(''); }
  catch { return content; }
}
function sameDns(a:DnsRecord, b:DnsRecord, zone:string) {
  const host = (name:string) => name==='@'?zone:name.toLowerCase().replace(/\.$/, '');
  return a.type===b.type && host(a.name)===host(b.name) &&
    (a.type==='MX'?a.content.toLowerCase().replace(/\.$/, ''):a.type==='TXT'?txtValue(a.content):a.content)===(b.type==='MX'?b.content.toLowerCase().replace(/\.$/, ''):b.type==='TXT'?txtValue(b.content):b.content) &&
    (a.type!=='MX'||a.priority===b.priority);
}
async function mailDns(cf:Cloudflare, zoneId:string, zone:string, required:DnsRecord[]) {
  const names=[...new Set([zone,...required.map(r=>r.name==='@'?zone:r.name)])];
  if (names.some(name=>name!==zone&&!name.endsWith(`.${zone}`)))
    throw new Error('Cloudflare returned DNS records outside the declared email zone');
  return (await Promise.all(names.map(name=>list<DnsRecord>(cf,`/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`,'DNS: Read')))).flat();
}
function assertDns(records:DnsRecord[], required:DnsRecord[], zone:string,replaceMx:EmailRoutingSpec['replaceMx']=[]) {
  if (!required.some(r=>r.type==='MX') || !required.some(r=>r.type==='TXT' && /^v=spf1\b/i.test(txtValue(r.content))))
    throw new Error('Cloudflare did not return the required MX/SPF records; refusing DNS changes');
  const conflicts = records.filter(r=>r.type==='MX'||(r.type==='TXT'&&/^v=spf1\b/i.test(txtValue(r.content))))
    .filter(r=>!required.some(wanted=>sameDns(r,wanted,zone)));
  const approved=conflicts.filter(r=>r.type==='MX'&&r.name===zone&&replaceMx.some(expected=>sameDns(r,{...expected,type:'MX',name:zone},zone)));
  if (conflicts.some(r=>!approved.includes(r)))
    throw new Error(`${zone}: existing MX/SPF conflicts with Email Routing. Review the current mail provider/SPF first; 2server will not replace these records.`);
  return approved;
}
async function routingRules(cf:Cloudflare,base:string,accountId:string,zone:string,allowAccountRead:boolean) {
  try { return await list<Rule>(cf,`${base}/rules`,rulesPermission); }
  catch(e) {
    if(!allowAccountRead||!(e instanceof CloudflareError)||e.status!==403)throw e;
    const rows=await list<Rule&{zone?:{name?:string;tag?:string}}>(cf,`/accounts/${accountId}/email/routing/rules`,'Email Routing Account Rules: Read');
    return rows.filter(r=>r.zone?.name===zone||r.matchers.some(m=>m.type==='literal'&&m.field==='to'&&m.value?.toLowerCase().endsWith(`@${zone}`)));
  }
}
function wantedRule(instance:string, route:EmailRoutingSpec['routes'][number]) {
  return {
    name:`2server:${instance}:${route.address}`, enabled:route.enabled,
    matchers:[{type:'literal',field:'to',value:route.address}],
    actions:[{type:'forward',value:[route.destination]}],
  };
}
function findRule(rules:Rule[], instance:string, route:EmailRoutingSpec['routes'][number]) {
  const wanted = wantedRule(instance,route);
  const matching = rules.filter(r=>r.name===wanted.name||r.matchers.some(m=>m.type==='literal'&&m.field==='to'&&m.value?.toLowerCase()===route.address));
  if (matching.length>1 || matching.some(r=>r.name!==wanted.name))
    throw new Error(`${route.address}: duplicate or foreign routing rule; reconcile it explicitly in Cloudflare`);
  const rule=matching[0];
  // A stale ownership label does not authorize modifying a different address.
  if (rule && (rule.matchers.length!==1||rule.matchers[0].type!=='literal'||rule.matchers[0].field!=='to'||rule.matchers[0].value?.toLowerCase()!==route.address))
    throw new Error(`${route.address}: managed rule matcher changed; inspect it in Cloudflare`);
  return rule;
}
function sameRule(rule:Rule, wanted:ReturnType<typeof wantedRule>) {
  return rule.name===wanted.name && rule.enabled===wanted.enabled &&
    rule.matchers.length===wanted.matchers.length && rule.matchers.every((m,i)=>m.type===wanted.matchers[i].type&&m.field===wanted.matchers[i].field&&m.value===wanted.matchers[i].value) &&
    rule.actions.length===wanted.actions.length && rule.actions.every((a,i)=>a.type===wanted.actions[i].type&&a.value?.length===wanted.actions[i].value.length&&a.value.every((value,j)=>value===wanted.actions[i].value[j]));
}

// `get -f FILE` diagnoses the actual token/API responses without guessing that
// any 403 means a particular permission is absent. Values stay in the client.
export async function inspectEmailRouting(
  input:EmailRoutingSpec,
  token=requireCloudflareToken('CLOUDFLARE_API_TOKEN'),
  request:typeof fetch=fetch,
) {
  const spec=emailRoutingSpecSchema.parse(input),cf=new Cloudflare(token,request);
  const zone=await cf.zone(spec.zone);
  const details=await cf.call<{account:{id:string}}>('GET',`/zones/${zone}`,undefined,'Zone: Read');
  const accountId=details.account.id;
  if(!/^[0-9a-f]{32}$/.test(accountId)||spec.accountId&&spec.accountId!==accountId)throw new Error('Email zone/account mismatch');
  const probe=async<T>(read:()=>Promise<T>)=>{
    try { return {ok:true as const,result:await read()}; }
    catch(e) {
      if(e instanceof CloudflareError)return {ok:false as const,status:e.status,codes:e.codes,operation:e.operation};
      throw e;
    }
  };
  const base=`/zones/${zone}/email/routing`;
  const [settings,records,zoneRules,accountRules,destinations,accountToken]=await Promise.all([
    probe(()=>cf.call<Settings>('GET',base)),
    list<DnsRecord>(cf,`/zones/${zone}/dns_records?name=${encodeURIComponent(spec.zone)}`,'DNS: Read'),
    probe(()=>list<Rule>(cf,`${base}/rules`,rulesPermission)),
    probe(()=>list<Rule>(cf,`/accounts/${accountId}/email/routing/rules`,'Email Routing Account Rules: Read')),
    probe(()=>list<Destination>(cf,`/accounts/${accountId}/email/routing/addresses`,addressesPermission)),
    probe(()=>cf.call<{id:string;status:string}>('GET',`/accounts/${accountId}/tokens/verify`)),
  ]);
  let identity:unknown=accountToken.ok?{kind:'account',status:accountToken.result.status}:accountToken;
  let policies:unknown;
  const describe=async(path:string)=>{
    const result=await probe(()=>cf.call<{policies?:Array<{effect:string;permission_groups:Array<{name?:string}>;resources:Record<string,unknown>}>}>('GET',path));
    return result.ok?result.result.policies?.map(p=>({effect:p.effect,permissionCount:p.permission_groups.length,permissions:p.permission_groups.map(g=>g.name).filter(name=>name&&/Email Routing|API Tokens|^DNS |^Zone |SSL/i.test(name)),resources:p.resources})):result;
  };
  if(accountToken.ok)policies=await describe(`/accounts/${accountId}/tokens/${accountToken.result.id}`);
  else {
    const userToken=await probe(()=>cf.call<{id:string;status:string}>('GET','/user/tokens/verify'));
    if(userToken.ok){identity={kind:'user',status:userToken.result.status};policies=await describe(`/user/tokens/${userToken.result.id}`);}
  }
  const count=(p:typeof zoneRules)=>p.ok?{ok:true,count:p.result.length}:p;
  return {
    zone:spec.zone,accountId,credential:{identity,policies},
    settings:settings.ok?settings.result:settings,
    dns:{mx:records.filter(r=>r.type==='MX'),spf:records.filter(r=>r.type==='TXT'&&/^v=spf1\b/i.test(txtValue(r.content)))},
    zoneRules:count(zoneRules),accountRules:count(accountRules),
    destinations:destinations.ok?{ok:true,addresses:destinations.result.map(d=>({email:d.email,verified:!!d.verified}))}:destinations,
  };
}

// A Cloudflare-managed extension: no VM, Worker, D1 or outbound sending plan.
// Keep account-wide destinations and foreign/catch-all rules intact.
export async function reconcileEmailRouting(
  input:EmailRoutingSpec,
  instance:string,
  apply:boolean,
  token=requireCloudflareToken('CLOUDFLARE_API_TOKEN'),
  request:typeof fetch=fetch,
) {
  const spec=emailRoutingSpecSchema.parse(input);
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(instance)) throw new Error('Invalid Email Routing instance name');
  const cf=new Cloudflare(token,request);
  const zone=await cf.zone(spec.zone);
  const details=await cf.call<{account:{id:string}}>('GET',`/zones/${zone}`,undefined,'Zone: Read');
  if (!/^[0-9a-f]{32}$/.test(details.account?.id)) throw new Error('Cloudflare did not return the zone account');
  if (spec.accountId && details.account.id!==spec.accountId) throw new Error('Cloudflare zone does not belong to the declared account');
  const accountId=details.account.id;
  const base=`/zones/${zone}/email/routing`;
  const account=`/accounts/${accountId}/email/routing/addresses`;
  let bootstrapPermission;
  if(spec.createZoneTokenPolicy) {
    bootstrapPermission=await emailTokenPermission(cf,accountId,zone,false,true);
    if(bootstrapPermission.operation==='create') {
      if(!apply)return {
        instance,zone:spec.zone,accountId,receiveOnly:true,status:'planned' as const,
        tokenPermission:bootstrapPermission,preflight:'deferred-until-permission',
        replaceMx:spec.replaceMx,enableRouting:null,destinations:[],retainedRules:[],
        routes:spec.routes.map(route=>({...route,operation:'inspect-after-permission'})),
        nextStep:'Apply to create the declared exact-zone token policy, then inspect mail DNS/settings/rules and register destinations. No DNS/rule changes occur until destination verification.',
      };
      await emailTokenPermission(cf,accountId,zone,true,true);
    }
  }
  const required=await cf.call<DnsRecord[]>('GET',`${base}/dns`,undefined,'Zone Settings: Read');
  const records=await mailDns(cf,zone,spec.zone,required);
  const replace=assertDns(records,required,spec.zone,spec.replaceMx);
  const tokenPermission=bootstrapPermission?.operation==='create'?bootstrapPermission:spec.manageTokenPermissions?await emailTokenPermission(cf,accountId,zone,false):undefined;
  const settings=await cf.call<Settings>('GET',base,undefined,'Zone Settings: Read');
  const rules=await routingRules(cf,base,accountId,spec.zone,spec.manageTokenPermissions);
  for (const route of spec.routes) findRule(rules,instance,route);
  const addresses=await list<Destination>(cf,account,addressesPermission);
  const destinations=[...new Set(spec.routes.map(r=>r.destination))].map(email=>({
    email, address:addresses.find(a=>a.email.toLowerCase()===email),
  }));
  const plan={
    instance, zone:spec.zone, accountId, receiveOnly:true,
    tokenPermission,replaceMx:replace.map(r=>({content:r.content,priority:r.priority})),
    status:'planned' as 'planned'|'pending-verification'|'ready',
    enableRouting:!settings.enabled||required.some(wanted=>!records.some(r=>sameDns(r,wanted,spec.zone))),
    destinations:destinations.map(d=>({email:d.email,verified:!!d.address?.verified,create:!d.address})),
    routes:spec.routes.map(route=>{
      const existing=findRule(rules,instance,route);
      return {...route,operation:!existing?'create':sameRule(existing,wantedRule(instance,route))?'keep':'update'};
    }),
    retainedRules:rules.filter(r=>r.name?.startsWith(`2server:${instance}:`)&&!spec.routes.some(route=>wantedRule(instance,route).name===r.name)).map(r=>r.name),
  };
  if (!apply) return plan;
  if(spec.manageTokenPermissions)await emailTokenPermission(cf,accountId,zone,true);
  for (const d of destinations) if (!d.address)
    d.address=await cf.call<Destination>('POST',account,{email:d.email},addressesPermission);
  const pending=destinations.filter(d=>!d.address?.verified).map(d=>d.email);
  if (pending.length) return {...plan,status:'pending-verification' as const,pending,
    nextStep:'Open the Cloudflare verification email in each destination inbox, then rerun deploy --apply. DNS and routing rules have not been changed.'};

  // Recheck ownership and mail DNS after verification preflight, before writes.
  const beforeDnsRules=await list<Rule>(cf,`${base}/rules`,rulesPermission);
  for(const route of spec.routes) {
    const now=findRule(beforeDnsRules,instance,route),before=findRule(rules,instance,route);
    if(JSON.stringify(now)!==JSON.stringify(before))throw new Error(`${route.address}: routing rule changed since preflight; inspect and rerun plan`);
  }
  const toReplace=assertDns(await mailDns(cf,zone,spec.zone,required),required,spec.zone,spec.replaceMx);
  if(JSON.stringify(toReplace)!==JSON.stringify(replace))throw new Error('Approved MX changed since preflight; inspect and rerun plan');
  for(const record of toReplace) {
    if(!record.id||!/^[0-9a-f]{32}$/.test(record.id))throw new Error('Cannot replace MX without a valid Cloudflare record ID');
    await cf.call('DELETE',`/zones/${zone}/dns_records/${record.id}`,undefined,'DNS: Edit');
  }
  // Despite the reference calling `name` the zone domain, the live endpoint
  // treats it as a subdomain. Omit it when enabling the declared zone apex.
  if (plan.enableRouting) await cf.call<Settings>('POST',`${base}/dns`,undefined,'Zone Settings: Edit');
  for (const route of spec.routes) {
    const now=findRule(await list<Rule>(cf,`${base}/rules`,rulesPermission),instance,route);
    const before=findRule(rules,instance,route);
    if (JSON.stringify(now)!==JSON.stringify(before)) throw new Error(`${route.address}: routing rule changed since preflight; inspect and rerun plan`);
    const wanted=wantedRule(instance,route);
    if (!now||!sameRule(now,wanted)) await cf.call(now?'PUT':'POST',`${base}/rules${now?`/${now.id}`:''}`,{...wanted,...(now?.priority!==undefined?{priority:now.priority}:{})},rulesPermission);
  }
  const liveSettings=await cf.call<Settings>('GET',base,undefined,'Zone Settings: Read');
  const liveRecords=await mailDns(cf,zone,spec.zone,required);
  const liveRules=await list<Rule>(cf,`${base}/rules`,rulesPermission);
  if (!liveSettings.enabled || liveSettings.status!=='ready' || required.some(wanted=>!liveRecords.some(r=>sameDns(r,wanted,spec.zone))))
    throw new Error('Email Routing applied but DNS/settings are not ready; inspect Cloudflare before retrying');
  for (const route of spec.routes) {
    const live=findRule(liveRules,instance,route);
    if (!live||!sameRule(live,wantedRule(instance,route))) throw new Error(`${route.address}: applied routing rule failed verification`);
  }
  return {...plan,status:'ready' as const};
}
