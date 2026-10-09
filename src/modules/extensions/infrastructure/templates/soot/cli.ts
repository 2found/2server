import { mkdir,writeFile } from 'node:fs/promises';
import { dirname,resolve } from 'node:path';
import { z } from 'zod';
import type { Config } from '../../../../config/application/config';
import { canonical,checkedRead,strictJSON } from './bundle';
import { assertRuntime,connectionDigest,factsSchema,identity,operatorToken,ready,settleReceipt,sootOperations,verifyPublic } from './deploy';
import { receiptSchema,rollbackSchema,RuntimeError,sha256,stateSchema } from './protocol';

const restoreArtifact=z.object({version:z.literal(1),server:z.string(),instance:z.string(),control_digest:z.string(),connection_digest:z.string(),host:factsSchema,
  state:stateSchema,request:rollbackSchema,reviewed_restore:z.literal(true).optional()}).strict();
export async function run(c:Config,command:string,args:string[]) {
  operatorToken(c);
  if(command==='release-status') {
    if(args.length)throw new Error('release-status takes no operation flags');
    const state=await sootOperations.state(c);assertRuntime(c,state);console.log(JSON.stringify(state,null,2));return;
  }
  if(command!=='restore-release')throw new Error('Unknown Soot app command');
  const options:Record<string,string>={};
  for(let i=0;i<args.length;i++) {
    const flag=args[i];if(!['--plan-output','--plan-file','--apply'].includes(flag)||flag in options)throw new Error('Unknown or duplicate restore option');
    if(flag==='--apply')options[flag]='true';else {const value=args[++i];if(!value||value.startsWith('-'))throw new Error('Missing private restore artifact path');options[flag]=value;}
  }
  if(options['--apply']?!options['--plan-file']||!!options['--plan-output']:!!options['--plan-file'])throw new Error('Use restore-release --plan-output FILE or --plan-file FILE --apply');
  const state=await sootOperations.state(c);assertRuntime(c,state);
  if(state.source_changed||state.deploy_drift)throw new Error('Guarded restore refuses edits since deployment; review runtime source first');
  if(!state.prior_revision||!state.prior_package_digest)throw new Error('Compatible prior release is unavailable');
  const host=await sootOperations.inspect(c);
  let artifact;
  if(options['--apply']) {
    const f=await checkedRead(resolve(options['--plan-file']),1024*1024);if(f.mode&0o077)throw new Error('Restore artifact must have private permissions');
    try{artifact=restoreArtifact.parse(strictJSON(f.bytes.toString(),1024*1024));}catch{throw new Error('Invalid reviewed restore artifact');}
    if(!artifact.reviewed_restore||artifact.server!==c.name||artifact.instance!==identity(c).instance||artifact.control_digest!==sha256(canonical(c))||artifact.connection_digest!==connectionDigest(c)
      ||canonical(artifact.host)!==canonical(host)||canonical(artifact.state)!==canonical(state))throw new Error('Restore plan changed or unreviewed; abort and replan');
    const expected={request_id:artifact.request.request_id,persisted_revision:state.persisted_revision,active_revision:state.active_revision,
      prior_revision:state.prior_revision,package_digest:state.prior_package_digest,compatibility_pin:state.compatibility_pin,fingerprints:state.fingerprints};
    if(canonical(expected)!==canonical(artifact.request))throw new Error('Restore request bindings changed; replan');
  } else {
    artifact=restoreArtifact.parse({version:1,server:c.name,instance:identity(c).instance,control_digest:sha256(canonical(c)),connection_digest:connectionDigest(c),host,state,
      request:{request_id:crypto.randomUUID(),persisted_revision:state.persisted_revision,active_revision:state.active_revision,prior_revision:state.prior_revision,
        package_digest:state.prior_package_digest,compatibility_pin:state.compatibility_pin,fingerprints:state.fingerprints}});
    if(options['--plan-output']) {
      const file=resolve(options['--plan-output']);await mkdir(dirname(file),{recursive:true,mode:0o700});
      await writeFile(file,JSON.stringify(artifact,null,2)+'\n',{mode:0o600,flag:'wx'});
    }
    console.log(JSON.stringify({operation:'guarded_restore',request:artifact.request,review:'Review exact request and set reviewed_restore: true; state/vault/history are retained'},null,2));return;
  }
  const prior=await sootOperations.host(c,{action:'find-release',package_digest:artifact.request.package_digest});
  let receipt;
  try {
    try{receipt=receiptSchema.parse(await sootOperations.api(c,'/v1/settings/deploy/rollback',artifact.request));}
    catch(e) {
      if(!(e instanceof RuntimeError)||e.reason!=='restart_required')throw e;
      await sootOperations.host(c,{action:'handoff',release:prior.release});await ready(c);
      receipt=receiptSchema.parse(await sootOperations.api(c,'/v1/settings/deploy/rollback',artifact.request));
    }
  }catch(e) {
    try{receipt=receiptSchema.parse(await sootOperations.api(c,'/v1/settings/transactions/'+artifact.request.request_id));}
    catch{throw new Error('Guarded restore outcome uncertain; reconcile the same request and retained fence');}
    if(receipt.state!=='applied')throw new Error(`Guarded restore ${receipt.state}; preserve state and reconcile request`);
  }
  receipt=await settleReceipt(c,artifact.request.request_id,receipt);
  if(receipt.state!=='applied'||receipt.request_id!==artifact.request.request_id)throw new Error('Guarded restore not acknowledged');
  const after=await ready(c);if(after.baseline?.package_digest!==artifact.request.package_digest||after.active_revision!==receipt.active_revision)throw new Error('Restored receipt mismatch');
  if(!state.runtime_package_pins.includes(artifact.request.package_digest))await sootOperations.host(c,{action:'publish',release:prior.release,expected_current:'releases/'+host.current});
  try{await verifyPublic(c,c.domains.filter(d=>JSON.stringify([d.upstream,...d.routes.map(r=>r.upstream)]).includes(identity(c).container+':')));}
  catch{throw new Error('Guarded restore acknowledged; public HTTPS/API phase unresolved. Inspect active receipt before retrying.');}
  console.log(JSON.stringify({status:'applied',requestId:receipt.request_id,activeRevision:after.active_revision,packageDigest:after.baseline.package_digest},null,2));
}
