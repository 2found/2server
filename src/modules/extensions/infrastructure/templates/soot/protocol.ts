import { createHash } from 'node:crypto';
import { z } from 'zod';

export const sha256=(raw:string|Uint8Array)=>createHash('sha256').update(raw).digest('hex');
export const hash=z.string().regex(/^[a-f0-9]{64}$/);
const revision=z.string().max(128);
export const compatibility='soot/api1-store1';
export const deployReceiptSchema=z.object({
  id:revision,generation:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),receipt_digest:revision,
  persisted_revision:revision,active_revision:revision,fingerprints:revision,source_digest:revision,package_digest:revision,
}).strict();
export type DeployReceipt=z.infer<typeof deployReceiptSchema>;
export const stateSchema=z.object({
  runtime_identity:hash,persisted_revision:revision,active_revision:revision,fingerprints:hash,persisted_digest:hash,
  baseline:deployReceiptSchema.nullable(),deploy_drift:z.boolean(),compatibility_pin:z.literal(compatibility),
  runtime_package_pins:z.array(hash).max(8),prior_revision:revision,prior_package_digest:revision,source_changed:z.boolean(),
}).strict();
export type DeployState=z.infer<typeof stateSchema>;
export const bindingsSchema=z.object({
  runtime_identity:hash,baseline_id:revision,baseline_generation:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),baseline_digest:revision,
  persisted_revision:revision,active_revision:revision,fingerprints:hash,source_digest:hash,package_digest:hash,
  compatibility_pin:z.literal(compatibility),staging_id:z.uuid(),staging_digest:hash,difference_digest:hash,
}).strict();
export const planSchema=z.object({request_id:z.uuid(),bindings:bindingsSchema,
  reviewed_replacement:z.object({kind:z.enum(['initial_source_review','reviewed_replacement']),bindings:bindingsSchema}).strict().optional(),
}).strict();
export type DeployPlan=z.infer<typeof planSchema>;
export const leaseSchema=z.object({transaction_id:z.uuid(),fence:z.uuid(),plan:planSchema}).strict();
export type DeployLease=z.infer<typeof leaseSchema>;
export const rollbackSchema=z.object({request_id:z.uuid(),persisted_revision:revision,active_revision:revision,prior_revision:revision,
  package_digest:hash,compatibility_pin:z.literal(compatibility),fingerprints:hash}).strict();
export type RollbackRequest=z.infer<typeof rollbackSchema>;
export const receiptSchema=z.object({transaction_id:z.string(),request_id:z.string(),state:z.enum(['applied','pending','rejected','restart_required']),
  lease_fence:z.string().optional(),reason_code:z.string(),saved_revision:z.string(),active_revision:z.string(),config_digest:z.string(),
}).strict();
export type Receipt=z.infer<typeof receiptSchema>;

// Go encoding/json escapes HTML and line separators. Field order is normative.
export function goJSON(value:unknown):string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
}
export function differencePreimage(state:DeployState,source:string,pkg:string):string {
  const d=state.baseline;
  const Old={id:d?.id??'',generation:d?.generation??0,receipt_digest:d?.receipt_digest??'',persisted_revision:d?.persisted_revision??'',
    active_revision:d?.active_revision??'',fingerprints:d?.fingerprints??'',source_digest:d?.source_digest??'',package_digest:d?.package_digest??''};
  return goJSON({Old,Current:state.persisted_digest,Source:source,Package:pkg});
}
export function stagingBytes(source:string,pkg:string):string {
  return goJSON({source_digest:source,package_digest:pkg,compatibility_pin:compatibility});
}
export function makePlan(state:DeployState,source:string,pkg:string,stagingId:string=crypto.randomUUID(),requestId:string=crypto.randomUUID()):DeployPlan {
  if(state.source_changed)throw new Error('source_changed: review and validate raw edits through the runtime before planning');
  return planSchema.parse({request_id:requestId,bindings:{runtime_identity:state.runtime_identity,
    baseline_id:state.baseline?.id??'',baseline_generation:state.baseline?.generation??0,baseline_digest:state.baseline?.receipt_digest??'',
    persisted_revision:state.persisted_revision,active_revision:state.active_revision,fingerprints:state.fingerprints,
    source_digest:source,package_digest:pkg,compatibility_pin:compatibility,staging_id:stagingId,
    staging_digest:sha256(stagingBytes(source,pkg)),difference_digest:sha256(differencePreimage(state,source,pkg))}});
}
export function checkPlan(state:DeployState,plan:DeployPlan):void {
  const fresh=makePlan(state,plan.bindings.source_digest,plan.bindings.package_digest,plan.bindings.staging_id,plan.request_id);
  if(goJSON(fresh.bindings)!==goJSON(plan.bindings))throw new Error('plan_stale: abort and replan; bindings changed');
  const review=plan.reviewed_replacement;
  if(review&&(review.kind!==(state.baseline?'reviewed_replacement':'initial_source_review')||goJSON(review.bindings)!==goJSON(plan.bindings)))
    throw new Error('review_bindings_changed: exact reviewed bindings required');
  if(state.deploy_drift&&!review)throw new Error('deploy_drift: exact initial_source_review or reviewed_replacement required');
}
export class RuntimeError extends Error {
  constructor(public readonly code:string,public readonly reason:string) {super(`Soot ${code}: ${reason}`);}
}
