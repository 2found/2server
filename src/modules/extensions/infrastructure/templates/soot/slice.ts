import { z } from 'zod';
import type { Config } from '../../../../config/application/config';
import type { NativeSliceDeployment,NativeSliceInput,PlanDecision } from '../../../domain/types';
import { canonical,checkSourceBundle,stageFiles,strictJSON,type CheckedSource } from './bundle';
import { assertRuntime,connectionDigest,factsSchema,identity,operatorToken,settleReceipt,sootOperations } from './deploy';
import { checkPlan,goJSON,leaseSchema,makePlan,planSchema,receiptSchema,RuntimeError,sha256,sourceId,stagingBytes,stateSchema,type DeployState } from './protocol';

// A SootSource document deploys one repository's slice (sources.d/<id>) of an
// installed bare runtime. It never touches the runtime's host deployment, AI
// providers, vault, release pointer or the other sources.
const artifactSchema=z.object({version:z.literal(1),operation:z.literal('deploy-source'),server:z.string(),instance:z.string(),source:sourceId,
  control_digest:z.string(),connection_digest:z.string(),document_digest:z.string(),tree_digest:z.string(),host:factsSchema,release:z.uuid(),
  staging_tree_digest:z.string(),plan:planSchema}).strict();
export type SliceArtifact=z.infer<typeof artifactSchema>;
const sourceOf=(input:NativeSliceInput)=>sourceId.parse(input.document.spec.source??input.document.metadata.name);
const check=(input:NativeSliceInput)=>checkSourceBundle(input.path,input.document.spec.bundle,sourceOf(input));
const inventoryOf=(source:CheckedSource,release:string)=>{
  const staged=stageFiles(source,'/transactions/inbox/'+release);
  return {staged,inventory:canonical({directories:source.directories,files:staged.map(f=>({name:f.name,digest:sha256(f.bytes),executable:!!(f.mode&0o111)}))})};
};
export async function sliceState(c:Config,id:string):Promise<DeployState> {
  const state=stateSchema.parse(await sootOperations.api(c,'/v1/settings/deploy/state?source='+id));
  assertRuntime(c,state);
  if(state.source!==id)throw new Error('Runtime does not support source deployments; upgrade the runtime App first');
  return state;
}
// Source deploys ride the package already running; a package change is a
// separate runtime App upgrade.
async function runningPackage(c:Config,state:DeployState) {
  const host=await sootOperations.inspect(c);
  if(host.phase!=='installed')throw new Error('Install the runtime App before deploying a SootSource');
  const pkg=host.image.split('@sha256:')[1]??'';
  if(!state.runtime_package_pins.includes(pkg))throw new Error('Runtime package changed; upgrade or restart the runtime App first');
  return {host,pkg};
}

// A first deploy into an empty slice replaces nothing, so it is approved like
// an unchanged redeploy. Files the repository never deployed, or Nest edits
// since the last deploy, are replaced only by an explicit operator decision.
export function sliceDecision(state:DeployState,id:string):PlanDecision {
  const review=(kind:'initial_source_review'|'reviewed_replacement')=>(artifact:unknown)=>{
    const a=artifact as SliceArtifact;return {...a,plan:{...a.plan,reviewed_replacement:{kind,bindings:a.plan.bindings}}};
  };
  if(state.baseline&&!state.deploy_drift)return {kind:'none',message:`Redeploy source ${id}; the runtime matches its last deploy (generation ${state.baseline.generation})`,approve:a=>a};
  if(!state.baseline&&state.source_files===0)return {kind:'safe',message:`First deploy of source ${id}; nothing on the runtime is replaced`,approve:review('initial_source_review')};
  if(!state.baseline)return {kind:'replace',message:`Source ${id} has files on the runtime that were never deployed from this repository; deploying replaces them`,approve:review('initial_source_review')};
  return {kind:'replace',message:`Source ${id} was edited on the runtime (Nest) since its last deploy; deploying replaces those edits`,approve:review('reviewed_replacement')};
}

export const sootSourceSlice:NativeSliceDeployment={
  async validate(input){await check(input);},
  async plan(input) {
    const {config:c}=input;operatorToken(c);
    const source=await check(input),state=await sliceState(c,source.id),{host,pkg}=await runningPackage(c,state);
    const release=crypto.randomUUID(),plan=makePlan(state,source.manifest.source_digest.value,pkg,release);
    const artifact=artifactSchema.parse({version:1,operation:'deploy-source',server:c.name,instance:identity(c).instance,source:source.id,
      control_digest:sha256(canonical(c)),connection_digest:connectionDigest(c),document_digest:sha256(canonical(input.document)),tree_digest:source.treeDigest,
      host,release,staging_tree_digest:sha256(inventoryOf(source,release).inventory),plan});
    const decision=sliceDecision(state,source.id);
    return {artifact,decision,summary:{operation:'deploy-source',instance:artifact.instance,source:source.id,sourceDigest:source.manifest.source_digest.value,
      packageDigest:pkg,deployed:state.baseline?{generation:state.baseline.generation,sourceDigest:state.baseline.source_digest}:null,drift:state.deploy_drift,bindings:plan.bindings,review:decision.message}};
  },
  async apply(input) {
    const {config:c}=input;operatorToken(c);
    let artifact:SliceArtifact;try{artifact=artifactSchema.parse(typeof input.artifact==='string'?strictJSON(input.artifact,1024*1024):input.artifact);}catch{throw new Error('Invalid reviewed SootSource plan artifact');}
    const source=await check(input),host=await sootOperations.inspect(c);
    if(artifact.server!==c.name||artifact.instance!==identity(c).instance||artifact.source!==source.id||artifact.control_digest!==sha256(canonical(c))
      ||artifact.connection_digest!==connectionDigest(c)||artifact.document_digest!==sha256(canonical(input.document))||artifact.tree_digest!==source.treeDigest
      ||canonical(host)!==canonical(artifact.host))throw new Error('plan_stale: local source, VM or control changed; abort and replan');
    const plan=artifact.plan;
    if(plan.bindings.source!==source.id||plan.bindings.source_digest!==source.manifest.source_digest.value||plan.bindings.staging_id!==artifact.release)throw new Error('Candidate pins changed; replan');
    const state=await sliceState(c,source.id);await runningPackage(c,state);
    const {staged,inventory}=inventoryOf(source,artifact.release);
    if(sha256(inventory)!==artifact.staging_tree_digest)throw new Error('Staging tree changed; abort and replan');
    const held=(await sootOperations.host(c,{action:'lease'})).lease;
    let recoveredLease;
    if(held){recoveredLease=leaseSchema.parse(held);if(goJSON(recoveredLease.plan)!==goJSON(plan))throw new Error('A different deploy lease is held; inspect and reconcile its owner');}
    else checkPlan(state,plan);
    await sootOperations.host(c,{action:'stage-source',expected:host,release:artifact.release,directories:source.directories,
      files:staged.map(f=>({name:f.name,bytes:f.bytes.toString('base64'),digest:sha256(f.bytes),executable:!!(f.mode&0o111)})),
      archives:source.archives.map(a=>({digest:a.digest,bytes:a.bytes.toString('base64')})),inventory,inventory_digest:artifact.staging_tree_digest,
      staging_bytes:stagingBytes(plan.bindings.source_digest,plan.bindings.package_digest),staging_digest:plan.bindings.staging_digest});
    let lease;
    try {lease=recoveredLease??leaseSchema.parse(await sootOperations.api(c,'/v1/settings/deploy/prepare',plan));}
    catch(e){throw new Error(`Soot prepare failed${e instanceof RuntimeError?` (${e.code}: ${e.reason})`:''}; nothing was written. Fix the source or replan`);}
    if(goJSON(lease.plan)!==goJSON(plan))throw new Error('Runtime returned a different lease plan; retained fence requires inspection');
    let receipt,commitMayHaveApplied=false;
    try {
      await sootOperations.host(c,{action:'verify-source-stage',release:artifact.release,inventory_digest:artifact.staging_tree_digest});
      commitMayHaveApplied=true;receipt=receiptSchema.parse(await sootOperations.api(c,'/v1/settings/deploy/commit',lease));
    }catch(e) {
      if(!commitMayHaveApplied||e instanceof RuntimeError&&e.reason==='restart_required') {
        try{await sootOperations.api(c,'/v1/settings/deploy/abort',lease);}
        catch{throw new Error(`Soot abort blocked; preserve edits/fence and reconcile request ${plan.request_id}`);}
        throw new Error(e instanceof RuntimeError&&e.reason==='restart_required'?'Runtime package changed; lease aborted. Upgrade the runtime App, then replan'
          :'Source stage changed before commit; lease aborted, replan');
      }
      // A lost response may have acknowledged; reconcile the SAME request.
      try {receipt=receiptSchema.parse(await sootOperations.api(c,'/v1/settings/transactions/'+plan.request_id));}
      catch {throw new Error(`Soot commit outcome uncertain; reconcile request ${plan.request_id} and retained lease before retrying`);}
      if(receipt.state!=='applied') {
        if(e instanceof RuntimeError) {
          try{await sootOperations.api(c,'/v1/settings/deploy/abort',lease);}
          catch{throw new Error(`Soot abort blocked; preserve edits/fence and reconcile request ${plan.request_id}`);}
        }
        throw new Error(`Soot commit not acknowledged (${receipt.state}${e instanceof RuntimeError?`: ${e.reason}`:''}); reconcile request ${plan.request_id}`);
      }
    }
    receipt=await settleReceipt(c,plan.request_id,receipt);
    if(receipt.state!=='applied'||receipt.request_id!==plan.request_id)return {status:receipt.state==='rejected'?'rejected':'pending',summary:{status:receipt.state,requestId:plan.request_id,reason:receipt.reason_code}};
    const after=await sliceState(c,source.id);
    if(after.baseline?.id!==lease.transaction_id||after.baseline.source_digest!==plan.bindings.source_digest)throw new Error('Acknowledged receipt does not identify the prepared source lease');
    return {status:'applied',summary:{status:'applied',source:source.id,requestId:plan.request_id,generation:after.baseline.generation,
      activeRevision:after.active_revision,sourceDigest:after.baseline.source_digest}};
  },
};
