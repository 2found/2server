import { Cloudflare } from '../../../../domains/infrastructure/cloudflare';

type Policy={id:string;effect:'allow'|'deny';permission_groups:Array<{id:string;name?:string}>;resources:Record<string,unknown>};
type Token={name:string;status?:string;policies:Policy[];condition?:unknown;expires_on?:string;not_before?:string};
const permission='Email Routing Rules Write';
function editable(token:Token) {
  const body:Record<string,unknown>={name:token.name,policies:token.policies.map(p=>({id:p.id,effect:p.effect,resources:p.resources,permission_groups:p.permission_groups.map(g=>({id:g.id}))}))};
  for(const field of ['condition','expires_on','not_before','status'] as const)
    if(token[field]!==undefined&&token[field]!==null)body[field]=token[field];
  return body;
}

// Explicit opt-in. Preserve all current token policies and restrictions; append
// only the email rule permission to an existing, exact-zone allow policy.
// A separate opt-in can bootstrap the minimum rights for one new zone.
export async function emailTokenPermission(cf:Cloudflare,accountId:string,zoneId:string,apply:boolean,createZonePolicy=false) {
  const identity=await cf.call<{id:string;status:string}>('GET',`/accounts/${accountId}/tokens/verify`);
  if(identity.status!=='active'||!/^[0-9a-f]{32}$/.test(identity.id))throw new Error('Permission management requires an active account-owned token');
  const path=`/accounts/${accountId}/tokens/${identity.id}`;
  const current=await cf.call<Token>('GET',path,undefined,'Account API Tokens: Read');
  const resource=`com.cloudflare.api.account.zone.${zoneId}`;
  const exact=current.policies.filter(p=>p.effect==='allow'&&Object.keys(p.resources).length===1&&p.resources[resource]==='*');
  if(exact.length>1||(!exact.length&&!createZonePolicy))throw new Error('Permission management requires one existing allow policy scoped to exactly this zone');
  if(current.policies.some(p=>p.effect==='deny'))throw new Error('Token has deny policies; review permissions explicitly');
  const policy=exact[0];
  const permissions=policy?[permission]:['Zone Read','DNS Read','Zone Settings Write',permission];
  const plan={zoneId,permission,permissions,operation:!policy?'create':policy.permission_groups.some(g=>g.name===permission)?'keep':'add'};
  if(plan.operation==='keep')return plan;
  const groups=await Promise.all(permissions.map(async name=>{
    const available=await cf.call<Array<{id:string;name:string;is_selectable?:boolean;scopes?:string[]}>>('GET',`/accounts/${accountId}/tokens/permission_groups?name=${encodeURIComponent(name)}`,undefined,'Account API Tokens: Read');
    const matches=available.filter(g=>g.name===name&&g.scopes?.includes('com.cloudflare.api.account.zone'));
    if(matches.length!==1||matches[0].is_selectable===false)throw new Error(`Zone permission ${name} cannot be granted by this credential`);
    return matches[0];
  }));
  if(!apply)return plan;
  const latest=await cf.call<Token>('GET',path,undefined,'Account API Tokens: Read');
  if(JSON.stringify(editable(latest))!==JSON.stringify(editable(current)))throw new Error('Token policy changed since preflight; inspect and rerun plan');
  const policies:Array<Omit<Policy,'id'> & {id?:string}>=current.policies.map(p=>({...p,permission_groups:[...p.permission_groups.map(g=>({id:g.id})),...(policy&&p.id===policy.id?groups.map(g=>({id:g.id})):[])]}));
  if(!policy)policies.push({effect:'allow',resources:{[resource]:'*'},permission_groups:groups.map(g=>({id:g.id}))});
  const body={...editable(current),policies};
  await cf.call('PUT',path,body,'Account API Tokens: Edit');
  const verified=await cf.call<Token>('GET',path,undefined,'Account API Tokens: Read');
  if(!verified.policies.some(p=>p.effect==='allow'&&Object.keys(p.resources).length===1&&p.resources[resource]==='*'&&groups.every(g=>p.permission_groups.some(existing=>existing.id===g.id))))throw new Error('Email Routing permission update was not verified');
  return plan;
}
