import { afterEach,expect,test } from 'bun:test';
import { chmod,rm,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sootSourceDeployment } from '../src/modules/extensions/infrastructure/templates/soot/source';
import { sootOperations,ready } from '../src/modules/extensions/infrastructure/templates/soot/deploy';
import { checkPlan,differencePreimage,goJSON,makePlan,RuntimeError,sha256,type DeployState } from '../src/modules/extensions/infrastructure/templates/soot/protocol';
import { fileCommand,fileOperations } from '../src/modules/source/cli/command';
import { extensionForCliName } from '../src/modules/extensions/application/registry';
import { setVmSecrets } from '../src/shared/infrastructure/vm-secrets';
import { setSshTransport } from '../src/shared/infrastructure/process';
import { fixture,runtimeState } from './fixtures/soot/helpers';
import { run as sootCommand } from '../src/modules/extensions/infrastructure/templates/soot/cli';
const original={...sootOperations},fileOriginal={...fileOperations},dirs:string[]=[];
const installed={phase:'installed' as const,control_revision:'revisions/11111111-1111-4111-8111-111111111111',current:'22222222-2222-4222-8222-222222222222',image:'registry.example/soot@sha256:35c9af6ab29b4ffea7374a1233b677afef1a79188b8188eba1d0642451f24f23',running:true};
afterEach(async()=>{Object.assign(sootOperations,original);Object.assign(fileOperations,fileOriginal);setVmSecrets();setSshTransport();for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
test('plan reads only runtime facts; since-D drift requires exact decision across every binding',async()=>{
  const f=await fixture();dirs.push(f.dir);const state=runtimeState(f.bound),calls:string[]=[];
  sootOperations.inspect=async()=>{calls.push('inspect');return installed;};sootOperations.state=async()=>{calls.push('state');return state;};
  sootOperations.host=async()=>{throw new Error('plan mutation');};sootOperations.api=async()=>{throw new Error('plan prepare');};
  const {artifact}=await sootSourceDeployment.plan(f.input);expect(calls).toEqual(['inspect','state']);
  const plan=(artifact as any).plan;expect(()=>checkPlan(state,plan)).toThrow('deploy_drift');
  plan.reviewed_replacement={kind:'initial_source_review',bindings:structuredClone(plan.bindings)};expect(()=>checkPlan(state,plan)).not.toThrow();
  for(const key of Object.keys(plan.bindings)) {
    const changed=structuredClone(plan);changed.reviewed_replacement.bindings[key]=key==='baseline_generation'?1:'changed';
    expect(()=>checkPlan(state,changed)).toThrow();
  }
  const drift={...state,baseline:{id:'deploy-1',generation:1,receipt_digest:'c'.repeat(64),persisted_revision:'old',active_revision:'old',fingerprints:'d'.repeat(64),source_digest:'e'.repeat(64),package_digest:'f'.repeat(64)}};
  const refreshed=makePlan(drift,'1'.repeat(64),'2'.repeat(64));expect(()=>checkPlan(drift,refreshed)).toThrow('deploy_drift');
  expect(differencePreimage(state,'1'.repeat(64),'2'.repeat(64))).toBe('{"Old":{"id":"","generation":0,"receipt_digest":"","persisted_revision":"","active_revision":"","fingerprints":"","source_digest":"","package_digest":""},"Current":"'+state.persisted_digest+'","Source":"'+'1'.repeat(64)+'","Package":"'+'2'.repeat(64)+'"}');
});

test('template guarded restore rechecks private artifact, repeats the same request after code handoff and publishes only after acknowledgment',async()=>{
  const f=await fixture();dirs.push(f.dir);const initial=runtimeState(f.bound),prior='f'.repeat(64);
  let state:DeployState={...initial,deploy_drift:false,prior_revision:'prior-saved',prior_package_digest:prior,
    baseline:{id:'deploy-2',generation:2,receipt_digest:'c'.repeat(64),persisted_revision:initial.persisted_revision,active_revision:initial.active_revision,
      fingerprints:initial.fingerprints,source_digest:'e'.repeat(64),package_digest:initial.runtime_package_pins[0]}};
  const originalState=structuredClone(state),actions:string[]=[],requests:any[]=[];
  sootOperations.inspect=async()=>installed;sootOperations.state=async()=>state;sootOperations.pause=async()=>{};
  sootOperations.host=async(_c,q)=>{actions.push(String(q.action));if(q.action==='handoff')state={...state,runtime_package_pins:[prior]};return {release:'33333333-3333-4333-8333-333333333333'};};
  sootOperations.api=async(_c,path,body:any)=>{
    actions.push(path);if(path==='/readyz')return {ready:true};
    if(path.endsWith('/rollback')){
      requests.push(structuredClone(body));if(requests.length===1)throw new RuntimeError('config_busy','restart_required');
      state={...state,persisted_revision:'restored',active_revision:'restored',baseline:{...state.baseline!,active_revision:'restored',persisted_revision:'restored',package_digest:prior}};
      return {transaction_id:crypto.randomUUID(),request_id:body.request_id,state:'applied',reason_code:'',saved_revision:'restored',active_revision:'restored',config_digest:state.persisted_digest};
    }throw new Error('Unexpected restore API');
  };
  const path=join(f.dir,'restore.json');await sootCommand(f.bound,'restore-release',['--plan-output',path]);expect(actions).toEqual([]);
  const artifact=await Bun.file(path).json();
  await expect(sootCommand(f.bound,'restore-release',['--plan-file',path,'--apply'])).rejects.toThrow('unreviewed');
  artifact.reviewed_restore=true;await writeFile(path,JSON.stringify(artifact),{mode:0o600});
  state={...state,active_revision:'competing-active'};await expect(sootCommand(f.bound,'restore-release',['--plan-file',path,'--apply'])).rejects.toThrow('changed');expect(actions).toEqual([]);
  state={...originalState,deploy_drift:true};await expect(sootCommand(f.bound,'restore-release',['--plan-file',path,'--apply'])).rejects.toThrow('edits');
  state=originalState;await sootCommand(f.bound,'restore-release',['--plan-file',path,'--apply']);expect(requests[0]).toEqual(requests[1]);
  expect(actions.indexOf('handoff')).toBeGreaterThan(actions.indexOf('/v1/settings/deploy/rollback'));
  expect(actions.indexOf('publish')).toBeGreaterThan(actions.lastIndexOf('/v1/settings/deploy/rollback'));
});
test('local bytes, receipt, control and runtime plan/apply races abort before staging',async()=>{
  const f=await fixture();dirs.push(f.dir);let state=runtimeState(f.bound),host={...installed},effects=0;
  sootOperations.inspect=async()=>host;sootOperations.state=async()=>state;sootOperations.host=async(_c,q)=>{if(q.action==='lease')return {lease:null};effects++;throw new Error('should not stage');};
  const {artifact}=await sootSourceDeployment.plan(f.input);const reviewed=artifact as any;reviewed.plan.reviewed_replacement={kind:'initial_source_review',bindings:{...reviewed.plan.bindings}};
  state={...state,active_revision:'changed'};await expect(sootSourceDeployment.apply({...f.input,artifact})).rejects.toThrow('plan_stale');
  state=runtimeState(f.bound);host={...host,control_revision:'revisions/33333333-3333-4333-8333-333333333333'};
  await expect(sootSourceDeployment.apply({...f.input,artifact})).rejects.toThrow('plan_stale');host={...installed};
  setSshTransport({kind:'ssh',user:'operator',host:'changed.example',port:22});
  await expect(sootSourceDeployment.apply({...f.input,artifact})).rejects.toThrow('plan_stale');setSshTransport();
  await writeFile(join(f.dir,'bundle/soot/soots/helper/mission.md'),'operator edit');
  await expect(sootSourceDeployment.apply({...f.input,artifact})).rejects.toThrow('digest mismatch');expect(effects).toBe(0);
});
test('bootstrap requires explicit review and cannot approve source or traffic',async()=>{
  const f=await fixture();dirs.push(f.dir);const host={...installed,phase:'absent' as const,current:'',image:'',running:false},actions:string[]=[];
  sootOperations.inspect=async()=>host;sootOperations.state=async()=>runtimeState(f.bound);sootOperations.api=async()=>({ready:true});
  sootOperations.host=async(_c,q)=>{actions.push(String(q.action));expect((q.bootstrap as any)?.soots).toEqual(['bootstrap/soot.json']);expect((q.bootstrap as any)?.model).toEqual({});return {};};
  const {artifact}=await sootSourceDeployment.plan(f.input);
  await expect(sootSourceDeployment.apply({...f.input,artifact})).rejects.toThrow('initialization');expect(actions).toEqual([]);
  (artifact as any).reviewed_initialization=true;
  expect((await sootSourceDeployment.apply({...f.input,artifact})).status).toBe('initialized');expect(actions).toEqual(['initialize']);
});
test('same package config update stages exact bytes, commits C3 and verifies receipt before pointer publication',async()=>{
  const f=await fixture();dirs.push(f.dir);let state=runtimeState(f.bound),lease:any,actions:string[]=[];
  sootOperations.inspect=async()=>installed;sootOperations.state=async()=>state;sootOperations.pause=async()=>{};
  sootOperations.host=async(_c,q)=>{actions.push(String(q.action));if(q.action==='lease')return {lease:null};if(q.action==='stage')expect(sha256(q.staging_bytes as string)).toBe(String(q.staging_digest));return {};};
  sootOperations.api=async(_c,path,body:any)=>{
    actions.push(path);if(path==='/readyz')return {ready:true};
    if(path.endsWith('/prepare')){lease={transaction_id:crypto.randomUUID(),fence:crypto.randomUUID(),plan:body};return lease;}
    if(path.endsWith('/commit')){
      const b=body.plan.bindings;state={...state,deploy_drift:false,persisted_revision:'saved-2',active_revision:'saved-2',baseline:{id:lease.transaction_id,generation:1,receipt_digest:'f'.repeat(64),persisted_revision:'saved-2',active_revision:'saved-2',fingerprints:state.fingerprints,source_digest:b.source_digest,package_digest:b.package_digest}};
      return {transaction_id:lease.transaction_id,request_id:body.plan.request_id,state:'applied',reason_code:'',saved_revision:'saved-2',active_revision:'saved-2',config_digest:state.persisted_digest};
    }throw new Error('unexpected API');
  };
  const {artifact}=await sootSourceDeployment.plan(f.input);(artifact as any).plan.reviewed_replacement={kind:'initial_source_review',bindings:structuredClone((artifact as any).plan.bindings)};
  expect((await sootSourceDeployment.apply({...f.input,artifact})).status).toBe('applied');
  expect(actions).toEqual(['lease','stage','/v1/settings/deploy/prepare','verify-stage','/v1/settings/deploy/commit','/readyz','publish']);
});
test('readiness cannot report success from startup or a basic HTTP 200',async()=>{
  const f=await fixture();dirs.push(f.dir);sootOperations.api=async()=>({ready:true});sootOperations.state=async()=>runtimeState(f.bound);sootOperations.pause=async()=>{};
  await expect(ready(f.bound,{source:'1'.repeat(64),pkg:'2'.repeat(64)})).rejects.toThrow('readiness failed');
});
test('staged-source change after prepare aborts the exact lease before any commit',async()=>{
  const f=await fixture();dirs.push(f.dir);const state=runtimeState(f.bound),actions:string[]=[];let lease:any;
  sootOperations.inspect=async()=>installed;sootOperations.state=async()=>state;
  sootOperations.host=async(_c,q)=>{actions.push(String(q.action));if(q.action==='lease')return {lease:null};if(q.action==='verify-stage')throw new Error('staged_files_changed');return {};};
  sootOperations.api=async(_c,path,body:any)=>{actions.push(path);if(path.endsWith('/prepare'))return lease={transaction_id:crypto.randomUUID(),fence:crypto.randomUUID(),plan:body};
    if(path.endsWith('/abort')){expect(body).toEqual(lease);return {};}throw new Error('Commit must not be issued');};
  const {artifact}=await sootSourceDeployment.plan(f.input);(artifact as any).plan.reviewed_replacement={kind:'initial_source_review',bindings:{...(artifact as any).plan.bindings}};
  await expect(sootSourceDeployment.apply({...f.input,artifact})).rejects.toThrow('lease aborted');
  expect(actions).toEqual(['lease','stage','/v1/settings/deploy/prepare','verify-stage','/v1/settings/deploy/abort']);
});
test('generic source CLI transports private plan, dispatches fake third native capability and keeps initialization off domains',async()=>{
  const f=await fixture();dirs.push(f.dir);const ext=extensionForCliName('soot')!,saved=ext.sourceDeployment;const calls:string[]=[];
  const server=join(f.dir,'server.json');await writeFile(server,JSON.stringify(f.config));
  ext.sourceDeployment={validate:async()=>{calls.push('validate');},plan:async({config})=>{expect(config.instance?.name).toBe('helper');calls.push('plan');return {artifact:{version:1},summary:{safe:true}};},
    apply:async({artifact})=>{expect(artifact).toBe('{"version":1}\n');calls.push('apply');return {status:'initialized',spec:f.doc.spec,summary:{status:'initialized'}};}};
  fileOperations.connectedCommand=async(args,fn)=>{await fn([...args,'-f',server]);return true;};fileOperations.preflightEdge=async()=>'';fileOperations.planSourceDomains=async()=>{};
  fileOperations.deployExtension=async()=>{throw new Error('bypassed capability');};fileOperations.resourceCommand=async()=>{throw new Error('initialization must not publish traffic');};
  try {
    const plan=join(f.dir,'review.json');await fileCommand(['plan','-f',f.input.path,'--ssh','operator@test','--plan-output',plan]);
    expect((await Bun.file(plan).json()).version).toBe(1);await writeFile(plan,'{"version":1}\n',{mode:0o600});
    await fileCommand(['deploy','-f',f.input.path,'--ssh','operator@test','--plan-file',plan,'--apply']);
    await chmod(plan,0o644);await expect(fileCommand(['deploy','-f',f.input.path,'--ssh','operator@test','--plan-file',plan,'--apply'])).rejects.toThrow('private');
    expect(calls.filter(c=>c==='apply')).toEqual(['apply']);
    await expect(fileCommand(['deploy','-f',f.input.path,'--ssh','operator@test','--apply'])).rejects.toThrow('plan-file');
  } finally{ext.sourceDeployment=saved;}
});
