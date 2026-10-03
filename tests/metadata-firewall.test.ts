import { expect,test } from 'bun:test';
import { run } from '../src/shared/infrastructure/process';

test('metadata policy denies by default and binds explicit grants to veth plus IP',async()=>{
 const file=new URL('../scripts/metadata-firewall.py',import.meta.url).pathname;
 const output=await run(['python3','-B','-c',`
import importlib.util,json
spec=importlib.util.spec_from_file_location('policy',${JSON.stringify(file)})
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
def container(name,allow=False):
 return {'Name':'/'+name,'Config':{'Labels':{'io.2server.cloud-metadata':'allow'} if allow else {}},'State':{'Running':True},'HostConfig':{'NetworkMode':'edge'}}
def peers(c): return [('172.18.0.2','vethabc123')]
denied=p.rules([container('web')],peers,set())
allowed=p.rules([container('api',True)],peers,set())
legacy=p.rules([container('legacy-api')],peers,{'legacy-api'})
# An unrelated new container reusing this IP never gets an allow rule.
reused=p.rules([container('web')],lambda c:[('172.18.0.2','vethnew456')],set())
explicit_deny=container('legacy-api')
explicit_deny['Config']['Labels']={'cloud-metadata':'deny'}
source_allow=container('api')
source_allow['Config']['Labels']={'cloud-metadata':'allow'}
reserved_deny=container('legacy-api')
reserved_deny['Config']['Labels']={'io.2server.cloud-metadata':'deny','cloud-metadata':'allow'}
print(json.dumps({'denied':denied,'allowed':allowed,'legacy':legacy,'reused':reused,
 'explicitDeny':p.rules([explicit_deny],peers,{'legacy-api'}),
 'sourceAllow':p.rules([source_allow],peers,set()),
 'reservedDeny':p.rules([reserved_deny],peers,{'legacy-api'})}))
`]);
 const policy=JSON.parse(output);
 expect(policy.denied).toEqual(['-A TWO-METADATA -j REJECT --reject-with icmp-port-unreachable']);
 expect(policy.allowed[0]).toBe('-A TWO-METADATA -s 172.18.0.2/32 -m physdev --physdev-in vethabc123 -j ACCEPT');
 expect(policy.legacy).toEqual(policy.allowed);
 expect(policy.reused).toEqual(policy.denied);
 expect(policy.explicitDeny).toEqual(policy.denied);
 expect(policy.reservedDeny).toEqual(policy.denied);
 expect(policy.sourceAllow).toEqual(policy.allowed);
});
