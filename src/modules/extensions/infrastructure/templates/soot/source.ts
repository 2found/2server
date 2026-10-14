import { z } from 'zod';
import type { Config } from '../../../../config/application/config';
import type { NativeSourceDeployment,NativeSourceInput } from '../../../domain/types';
import { canonical,checkBundle,checkReceipt,stageFiles,strictJSON,type CheckedBundle } from './bundle';
import { assertRuntime,connectionDigest,factsSchema,identity,operatorToken,ready,releaseInput,settleReceipt,sootOperations,verifyPublic,type HostFacts } from './deploy';
import { checkPlan,goJSON,leaseSchema,makePlan,planSchema,receiptSchema,RuntimeError,sha256,stagingBytes } from './protocol';

const artifactSchema=z.object({version:z.literal(1),operation:z.enum(['initialize','deploy','upgrade','none']),server:z.string(),instance:z.string(),
  control_digest:z.string(),connection_digest:z.string(),document_digest:z.string(),tree_digest:z.string(),receipt_digest:z.string(),image:z.string(),
  host:factsSchema,release:z.uuid(),staging_tree_digest:z.string(),plan:planSchema.optional(),reviewed_initialization:z.literal(true).optional(),
}).strict().refine(a=>(a.operation==='deploy')===!!a.plan,'Plan phase mismatch');
export type SourceArtifact=z.infer<typeof artifactSchema>;
// A bare runtime App has no bundle: its Soots arrive as SootSource slices.
const inputPins=async(input:NativeSourceInput)=>{
  const bundle:CheckedBundle|undefined=input.document.spec.bundle?await checkBundle(input):undefined;
  const runtime=bundle??await checkReceipt(input);
  return {bundle,runtime,document_digest:sha256(canonical(input.document)),tree_digest:bundle?.treeDigest??'',receipt_digest:runtime.receiptDigest,image:String(input.document.spec.image)};
};
const stagingTree=(bundle:CheckedBundle|undefined,release:string)=>{
  if(!bundle)return '';
  const staged=stageFiles(bundle,'/transactions/inbox/'+release);
  return sha256(canonical({directories:bundle.directories,files:staged.map(f=>({name:f.name,digest:sha256(f.bytes),executable:!!(f.mode&0o111)}))}));
};
const packageOf=(image:string)=>image.split('@sha256:')[1]??'';
export const sootSourceDeployment:NativeSourceDeployment={
  async validate(input){await inputPins(input);},
  async plan(input) {
    const {config:c}=input;operatorToken(c);
    const {bundle,runtime,...pins}=await inputPins(input),host=await sootOperations.inspect(c);
    const release=crypto.randomUUID();
    const staging_tree_digest=stagingTree(bundle,release);
    let plan,operation:'initialize'|'deploy'|'upgrade'|'none'='initialize';
    if(host.phase==='installed'){
      const state=await sootOperations.state(c);assertRuntime(c,state);
      if(bundle){plan=makePlan(state,bundle.manifest.source_digest.value,bundle.receipt.oci_manifest_digest.slice(7),release);operation='deploy';}
      else operation=packageOf(host.image)===runtime.receipt.oci_manifest_digest.slice(7)?'none':'upgrade';
    }
    const artifact=artifactSchema.parse({version:1,operation,server:c.name,instance:identity(c).instance,
      control_digest:sha256(canonical(c)),connection_digest:connectionDigest(c),...pins,host,release,staging_tree_digest,...(plan?{plan}:{})});
    const review={
      initialize:'Set reviewed_initialization: true to authorize an empty management bootstrap; then add providers in Nest and deploy Soot with kind: SootSource',
      deploy:'Review these exact bindings; initial/replacement decision must repeat them',
      upgrade:'Runtime package handoff only; config, sources, state and vault are retained. Apply the reviewed plan file',
      none:'Runtime package is current. Deploy Soot from each repository with kind: SootSource',
    }[operation];
    return {artifact,summary:{operation,instance:artifact.instance,image:pins.image,...(bundle?{sourceDigest:bundle.manifest.source_digest.value,treeDigest:pins.tree_digest}:{}),
      receiptDigest:pins.receipt_digest,...(operation==='upgrade'?{fromPackage:packageOf(host.image),toPackage:runtime.receipt.oci_manifest_digest.slice(7)}:{}),...(plan?{bindings:plan.bindings}:{}),review}};
  },
  async apply(input) {
    const {config:c}=input;operatorToken(c);
    let artifact:SourceArtifact;try{artifact=artifactSchema.parse(typeof input.artifact==='string'?strictJSON(input.artifact,1024*1024):input.artifact);}catch{throw new Error('Invalid reviewed source artifact');}
    const {bundle,runtime,...pins}=await inputPins(input);
    const host=await sootOperations.inspect(c);
    if(artifact.server!==c.name||artifact.instance!==identity(c).instance||artifact.control_digest!==sha256(canonical(c))||artifact.connection_digest!==connectionDigest(c)
      ||artifact.document_digest!==pins.document_digest||artifact.tree_digest!==pins.tree_digest||artifact.receipt_digest!==pins.receipt_digest
      ||artifact.image!==pins.image||canonical(host)!==canonical(artifact.host))throw new Error('plan_stale: local source, receipt, VM or control changed; abort and replan');
    const spec=input.document.spec;
    if(artifact.operation==='initialize') {
      if(!artifact.reviewed_initialization||host.phase!=='absent')throw new Error('Review empty management initialization explicitly in the plan artifact');
      // Host-only management bootstrap carries no source mission or AI provider.
      await sootOperations.host(c,{action:'initialize',expected:host,...releaseInput(c,runtime,artifact.release,true),
        token:operatorToken(c),token_env:c.extensions.soot!.tokenEnv,
        bootstrap:{listen:'0.0.0.0:7788',data_dir:'/state',credentials_dir:'/credentials',token_env:c.extensions.soot!.tokenEnv,
          model:{},soots:['bootstrap/soot.json'],workers:1,packs_dir:'packs.d'},
        bootstrap_files:{'bootstrap/soot.json':JSON.stringify({id:'management',soul:'SOUL.md',mission:'mission.md'}),
          'bootstrap/SOUL.md':'Management bootstrap; work is unavailable until explicitly configured.',
          'bootstrap/mission.md':'Wait for operator-reviewed source deployment.'}});
      await ready(c);
      return {status:'initialized',spec,summary:{status:'initialized',instance:artifact.instance,next:bundle?'Management initialized; create a new source plan and review initial_source_review before applying source or traffic'
        :'Runtime initialized. Connect Nest, add an AI provider, then deploy Soot with kind: SootSource documents'}};
    }
    if(artifact.operation==='none') {
      if(host.phase!=='installed'||packageOf(host.image)!==runtime.receipt.oci_manifest_digest.slice(7))throw new Error('plan_stale: runtime changed; replan');
      return {status:'applied',spec,summary:{status:'current',instance:artifact.instance}};
    }
    if(artifact.operation==='upgrade')return upgrade(c,spec,artifact,host,runtime);
    if(!bundle)throw new Error('plan_stale: bundle removed after review; replan');
    const plan=artifact.plan!,state=await sootOperations.state(c);assertRuntime(c,state);
    const staged=stageFiles(bundle,'/transactions/inbox/'+artifact.release);
    const inventory=canonical({directories:bundle.directories,files:staged.map(f=>({name:f.name,digest:sha256(f.bytes),executable:!!(f.mode&0o111)}))});
    if(sha256(inventory)!==artifact.staging_tree_digest)throw new Error('Staging tree changed; abort and replan');
    if(plan.bindings.source_digest!==bundle.manifest.source_digest.value||plan.bindings.package_digest!==bundle.receipt.oci_manifest_digest.slice(7)
      ||plan.bindings.staging_id!==artifact.release)throw new Error('Candidate pins changed; replan');
    const held=(await sootOperations.host(c,{action:'lease'})).lease;
    let recoveredLease;
    if(held){recoveredLease=leaseSchema.parse(held);if(goJSON(recoveredLease.plan)!==goJSON(plan))throw new Error('A different deploy lease is held; inspect and reconcile its owner');}
    else checkPlan(state,plan);
    await sootOperations.host(c,{action:'stage',expected:host,...releaseInput(c,bundle,artifact.release),directories:bundle.directories,
      files:staged.map(f=>({name:f.name,bytes:f.bytes.toString('base64'),digest:sha256(f.bytes),executable:!!(f.mode&0o111)})),
      archives:bundle.archives.map(a=>({digest:a.digest,bytes:a.bytes.toString('base64')})),
      inventory,inventory_digest:artifact.staging_tree_digest,
      staging_bytes:stagingBytes(plan.bindings.source_digest,plan.bindings.package_digest),staging_digest:plan.bindings.staging_digest});
    // The locator is a UUID; HTTP never sees stage paths or fetch URLs.
    let lease;
    try {lease=recoveredLease??leaseSchema.parse(await sootOperations.api(c,'/v1/settings/deploy/prepare',plan));}
    catch(e){throw new Error(`Soot prepare failed; immutable stage retained for request ${plan.request_id}${e instanceof RuntimeError?` (${e.code}: ${e.reason})`:''}; reconcile this request before retrying`);}
    if(goJSON(lease.plan)!==goJSON(plan))throw new Error('Runtime returned a different lease plan; retained fence requires inspection');
    let receipt,commitMayHaveApplied=false,handoffAttempted=false;
    try {
      await sootOperations.host(c,{action:'verify-stage',release:artifact.release,inventory_digest:artifact.staging_tree_digest});
      try {commitMayHaveApplied=true;receipt=receiptSchema.parse(await sootOperations.api(c,'/v1/settings/deploy/commit',lease));}
      catch(e) {
        if(!(e instanceof RuntimeError)||e.reason!=='restart_required')throw e;
        commitMayHaveApplied=false; // C3 promises no source writes for this result.
        handoffAttempted=true;
        await sootOperations.host(c,{action:'handoff',release:artifact.release});
        await ready(c);
        await sootOperations.host(c,{action:'verify-stage',release:artifact.release,inventory_digest:artifact.staging_tree_digest});
        commitMayHaveApplied=true;receipt=receiptSchema.parse(await sootOperations.api(c,'/v1/settings/deploy/commit',lease));
      }
    }catch(e) {
      if(!commitMayHaveApplied){
        if(handoffAttempted){
          // No source commit has run on the candidate. Keep the C3 fence while
          // joining it and recovering the retained supervisor on the same mounts.
          // A blocked close/restoration must not revoke the recovery lease.
          try{await sootOperations.host(c,{action:'handoff',release:host.current});await ready(c);}
          catch{throw new Error(`Soot pre-commit restoration blocked; preserve edits/fence and reconcile request ${plan.request_id}`);}
        }
        try{await sootOperations.api(c,'/v1/settings/deploy/abort',lease);}
        catch{throw new Error(`Soot pre-commit abort blocked; preserve edits/fence and reconcile request ${plan.request_id}`);}
        throw new Error('Soot stage or handoff readiness changed before source writes; lease aborted, inspect retained state and replan');
      }
      // A lost response may have acknowledged. Reconcile the SAME request;
      // never choose a fresh ID or unconditionally abort a completed commit.
      try {receipt=receiptSchema.parse(await sootOperations.api(c,'/v1/settings/transactions/'+plan.request_id));}
      catch {throw new Error(`Soot commit outcome uncertain; reconcile request ${plan.request_id} and retained lease before retrying`);}
      if(receipt.state!=='applied') {
        if(e instanceof RuntimeError&&e.reason!=='restart_required') {
          try{await sootOperations.api(c,'/v1/settings/deploy/abort',lease);}
          catch{throw new Error(`Soot abort blocked; preserve edits/fence and reconcile request ${plan.request_id}`);}
        }
        throw new Error(`Soot commit not acknowledged (${receipt.state}); reconcile request ${plan.request_id}`);
      }
    }
    receipt=await settleReceipt(c,plan.request_id,receipt);
    if(receipt.state!=='applied'||receipt.request_id!==plan.request_id)return {status:receipt.state==='rejected'?'rejected':'pending',spec,summary:{status:receipt.state,requestId:plan.request_id}};
    const active=await ready(c,{source:plan.bindings.source_digest,pkg:plan.bindings.package_digest});
    if(active.baseline?.id!==lease.transaction_id)throw new Error('Acknowledged receipt does not identify prepared lease');
    await sootOperations.host(c,{action:'publish',release:artifact.release,expected_current:'releases/'+host.current});
    return {status:'applied',spec,summary:{status:'applied',requestId:plan.request_id,activeRevision:active.active_revision,
      sourceDigest:active.baseline!.source_digest,packageDigest:active.baseline!.package_digest}};
  },
  async verify({config:c,document}) {
    await verifyPublic(c,document.domains);
  },
};

// Package-only handoff for a runtime App: same config, sources, state and
// vault on a new pinned package. A failed start restores the retained release.
async function upgrade(c:Config,spec:Record<string,unknown>,artifact:SourceArtifact,host:HostFacts,runtime:Awaited<ReturnType<typeof checkReceipt>>) {
  const pkg=runtime.receipt.oci_manifest_digest.slice(7);
  const before=await sootOperations.state(c);assertRuntime(c,before);
  if((await sootOperations.host(c,{action:'lease'})).lease)throw new Error('A deploy lease is held; reconcile it before a runtime upgrade');
  await sootOperations.host(c,{action:'release',expected:host,...releaseInput(c,runtime,artifact.release)});
  try {
    await sootOperations.host(c,{action:'handoff',release:artifact.release});
    const after=await ready(c);
    if(!after.runtime_package_pins.includes(pkg)||after.active_revision!==before.active_revision||goJSON(after.baseline)!==goJSON(before.baseline))throw new Error('upgraded runtime did not keep the active configuration');
  }catch(e) {
    try{await sootOperations.host(c,{action:'handoff',release:host.current});await ready(c);}
    catch{throw new Error('Runtime upgrade failed and restoring the previous release is blocked; inspect the instance');}
    throw new Error(`Runtime upgrade failed; previous release restored (${String((e as Error)?.message??e).split('\n')[0].slice(0,200)})`);
  }
  await sootOperations.host(c,{action:'publish',release:artifact.release,expected_current:'releases/'+host.current});
  return {status:'applied' as const,spec,summary:{status:'upgraded',instance:artifact.instance,packageDigest:pkg}};
}
