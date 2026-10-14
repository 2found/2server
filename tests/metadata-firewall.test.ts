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

test('metadata policy refreshes once at start and once per container start event, not on a fast poll',async()=>{
 const { metadataPolicyFiles } = await import('../src/modules/server/infrastructure/security');
 const { chmod,mkdtemp,rm } = await import('node:fs/promises');
 const { tmpdir } = await import('node:os');
 const { join } = await import('node:path');
 const files=await metadataPolicyFiles();
 // Polling is only the safety net for a missed event.
 expect(files['2server-metadata.timer']).toContain('OnUnitInactiveSec=60s');
 expect(files['2server-metadata-events.service']).toContain('ExecStart=/bin/bash /opt/2server/security/metadata-events.sh');
 expect(files['2server-metadata-events.service']).toContain('Restart=always');
 expect(files['2server-metadata-events.service']).toContain('PartOf=docker.service');
 const root=await mkdtemp(join(tmpdir(),'two-metadata-events-'));
 try {
  // Three starts arrive in one burst while a slow refresh runs: none is lost.
  await Bun.write(join(root,'docker'),'#!/bin/bash\n[ "$1" = events ] || exit 9\nprintf "a\\nb\\nc\\n"\n');
  await Bun.write(join(root,'policy'),`#!/bin/bash\nsleep 0.1\necho run >> '${root}/runs'\n`);
  for (const f of ['docker','policy']) await chmod(join(root,f),0o755);
  const script=files['metadata-events.sh'].replaceAll('/usr/bin/python3 /opt/2server/security/metadata-firewall.py',join(root,'policy'));
  const p=Bun.spawn(['bash','-c',script],{env:{...process.env,PATH:`${root}:${process.env.PATH}`},stderr:'pipe'});
  expect(await p.exited,await new Response(p.stderr).text()).toBe(0);
  expect((await Bun.file(join(root,'runs')).text()).trim().split('\n')).toHaveLength(4);
 } finally { await rm(root,{recursive:true,force:true}); }
});
