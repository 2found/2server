import {expect,test} from 'bun:test';
import {Cloudflare} from '../src/modules/domains/infrastructure/cloudflare';
import {emailTokenPermission} from '../src/modules/extensions/infrastructure/templates/email-routing/permissions';

const account='a'.repeat(32),zone='b'.repeat(32),tokenId='c'.repeat(32),groupId='d'.repeat(32);
const resource=`com.cloudflare.api.account.zone.${zone}`;
const permissionGroups=[
  {id:groupId,name:'Email Routing Rules Write'},
  {id:'e'.repeat(32),name:'Zone Read'},
  {id:'f'.repeat(32),name:'DNS Read'},
  {id:'1'.repeat(32),name:'Zone Settings Write'},
];
function mock() {
  const state={
    token:{name:'existing-token',status:'active',condition:{request_ip:{in:['192.0.2.0/24']}},expires_on:'2027-01-01T00:00:00Z',not_before:'2026-01-01T00:00:00Z',policies:[
      {id:'one',effect:'allow',permission_groups:[{id:'dns',name:'DNS Write'}],resources:{[resource]:'*'}},
      {id:'two',effect:'allow',permission_groups:[{id:'admin',name:'Account API Tokens Write'}],resources:{[`com.cloudflare.api.account.${account}`]:'*'}},
    ]},
    writes:[] as any[],reads:0,concurrent:false,selectable:true,
  };
  const request=(async(input:string|URL,init?:RequestInit)=>{
    const path=new URL(String(input)).pathname,method=init?.method??'GET';
    let result:unknown;
    if(path.endsWith('/verify'))result={id:tokenId,status:'active'};
    else if(path.endsWith('/permission_groups'))result=permissionGroups.map(g=>({...g,scopes:['com.cloudflare.api.account.zone'],is_selectable:state.selectable}));
    else if(path.endsWith(`/${tokenId}`)) {
      if(method==='PUT') {
        const body=JSON.parse(String(init?.body));state.writes.push(body);
        state.token=structuredClone(body);
        for(const policy of state.token.policies)for(const group of policy.permission_groups){const metadata=permissionGroups.find(g=>g.id===group.id);if(metadata)group.name=metadata.name;}
      }
      state.reads++;
      if(state.concurrent&&state.reads===2)state.token.name='changed-by-another-operator';
      result={...state.token,last_used_on:`read-${state.reads}`};
    } else throw new Error(`Unexpected request ${method} ${path}`);
    return Response.json({success:true,result});
  }) as typeof fetch;
  return {state,cf:new Cloudflare('private-token',request)};
}

test('permission plan does not mutate; apply appends to the exact zone and preserves other policies and restrictions',async()=>{
  const m=mock(),original=structuredClone(m.state.token);
  expect(await emailTokenPermission(m.cf,account,zone,false)).toMatchObject({operation:'add',zoneId:zone});
  expect(m.state.writes).toEqual([]);
  m.state.reads=0;
  await emailTokenPermission(m.cf,account,zone,true);
  expect(m.state.writes).toHaveLength(1);
  const body=m.state.writes[0];
  expect(body.policies[0]).toMatchObject({resources:{[resource]:'*'},permission_groups:[{id:'dns'},{id:groupId}]});
  expect(body.policies[1]).toEqual({...original.policies[1],permission_groups:[{id:'admin'}]});
  for(const field of ['name','status','condition','expires_on','not_before'] as const)expect(body[field]).toEqual(original[field]);
  expect(body).not.toHaveProperty('last_used_on');
  expect(await emailTokenPermission(m.cf,account,zone,true)).toMatchObject({operation:'keep'});
  expect(m.state.writes).toHaveLength(1);
});

test('new-zone policy requires a separate opt-in and grants only four minimum rights on exactly the requested zone',async()=>{
  const m=mock();m.state.token.policies.shift();
  const original=structuredClone(m.state.token);
  await expect(emailTokenPermission(m.cf,account,zone,false)).rejects.toThrow('existing allow policy');
  const plan=await emailTokenPermission(m.cf,account,zone,false,true);
  expect(plan).toMatchObject({operation:'create',zoneId:zone});
  expect(plan.permissions).toEqual(['Zone Read','DNS Read','Zone Settings Write','Email Routing Rules Write']);
  expect(m.state.writes).toEqual([]);
  m.state.reads=0;
  await emailTokenPermission(m.cf,account,zone,true,true);
  const body=m.state.writes[0];
  expect(body.policies).toHaveLength(2);
  expect(body.policies[0]).toEqual({...original.policies[0],permission_groups:[{id:'admin'}]});
  expect(body.policies[1]).toEqual({effect:'allow',resources:{[resource]:'*'},permission_groups:[{id:'e'.repeat(32)},{id:'f'.repeat(32)},{id:'1'.repeat(32)},{id:groupId}]});
  expect(body.condition).toEqual(original.condition);
  expect(await emailTokenPermission(m.cf,account,zone,true,true)).toMatchObject({operation:'keep'});
  expect(m.state.writes).toHaveLength(1);
  const denied=mock();denied.state.token.policies.shift();denied.state.token.policies[0].effect='deny';
  await expect(emailTokenPermission(denied.cf,account,zone,true,true)).rejects.toThrow('deny');
  expect(denied.state.writes).toEqual([]);
});

test('permission edits reject broader scope, deny policies, concurrent changes or an ungrantable group before writes',async()=>{
  for(const setup of [
    (m:ReturnType<typeof mock>)=>{m.state.token.policies[0].resources={['com.cloudflare.api.account.zone.*']:'*'};},
    (m:ReturnType<typeof mock>)=>{m.state.token.policies[1].effect='deny';},
    (m:ReturnType<typeof mock>)=>{m.state.concurrent=true;},
    (m:ReturnType<typeof mock>)=>{m.state.selectable=false;},
  ]) {
    const m=mock();setup(m);
    await expect(emailTokenPermission(m.cf,account,zone,true)).rejects.toThrow();
    expect(m.state.writes).toEqual([]);
  }
});
