import { readFileSync } from 'node:fs';
import type { Config } from '../../../../config/application/config';
import type { Domain } from '../../../../domains/domain/schema';
import { quote,run,sshArgs } from '../../../../../shared/infrastructure/process';
import { instanceSecret } from '../../../application/instance';
import { extensionProject,extensionRoot } from '../../../application/stateful';
import { instanceName,instanceRoot } from '../../../domain/instance';
import type { CheckedBundle } from './bundle';
import { goJSON,receiptSchema,RuntimeError,sha256,stateSchema,type DeployState,type Receipt } from './protocol';
import { z } from 'zod';

export const factsSchema=z.object({phase:z.enum(['absent','installed']),control_revision:z.string().regex(/^revisions\/[a-f0-9-]{36}$/),
  current:z.string(),image:z.string(),running:z.boolean()}).strict();
export type HostFacts=z.infer<typeof factsSchema>;
const hostCode=readFileSync(new URL('./host.py',import.meta.url),'utf8');
export function identity(c:Config) {
  if(!c.instance)throw new Error('Soot requires an explicitly bound named instance');
  const spec=c.extensions.soot!;
  const instance=instanceName(c,'soot'),root=instanceRoot(c,extensionRoot('soot',c));
  if(spec.dataPath!==`/opt/2server/data/${instance}`)throw new Error('Soot state root must use its instance namespace');
  return {server:c.name,instance,root,data:spec.dataPath,container:extensionProject(c,'soot'),network:c.edge.network,owner:`${c.name}:${instance}:soot`};
}
export function operatorToken(c:Config):string {
  identity(c);
  const key=c.extensions.soot!.tokenEnv,value=instanceSecret(c,key);
  if(!value||value.length<32||!/^[A-Za-z0-9_-]+$/.test(value))throw new Error(`Missing valid VM secret ${key}; use secret set --app ${c.instance!.name} with a private env file`);
  return value;
}
async function host(c:Config,input:Record<string,unknown>):Promise<any> {
  const value=JSON.parse(await run(sshArgs(c,'sudo -n python3 -c '+quote(hostCode)),JSON.stringify({...identity(c),...input})));
  if(value.host_error)throw new Error(`Soot host ${/^[a-z_]{1,64}$/.test(value.host_error)?value.host_error:'operation_failed'}; inspect instance and replan`);
  return value;
}
async function api(c:Config,path:string,body?:unknown):Promise<any> {
  const result=await sootOperations.host(c,{action:'api',path,token:operatorToken(c),...(body===undefined?{}:{body})});
  if(result.error)throw new RuntimeError(result.error.code,result.error.reason);
  return path==='/readyz'?result:result.value;
}
export const sootOperations={host,api,
  inspect: async(c:Config):Promise<HostFacts>=>factsSchema.parse(await sootOperations.host(c,{action:'inspect'})),
  state: async(c:Config):Promise<DeployState>=>stateSchema.parse(await sootOperations.api(c,'/v1/settings/deploy/state')),
  pause: async()=>{await Bun.sleep(1000);},
};
export function runtimeIdentity(c:Config):string {
  return sha256(goJSON({version:1,instance:identity(c).instance,root:'/transactions',config:'/config',state:'/state',credentials:'/credentials',target:'/config/deployment.json'}));
}
// Bind the actual connected transport, including provider target identifiers;
// the control manifest's original SSH settings may differ from this session.
export const connectionDigest=(c:Config)=>sha256(goJSON(sshArgs(c,'')));
export function assertRuntime(c:Config,state:DeployState) {
  if(state.runtime_identity!==runtimeIdentity(c))throw new Error('runtime_identity_changed: instance/mount identity mismatch');
}
export function supervisor(c:Config,image:string,release:string,initialize=false):Record<string,unknown> {
  const i=identity(c),s=c.extensions.soot!;
  const service={image,platform:'linux/amd64',container_name:i.container,restart:'unless-stopped',stop_grace_period:'90s',
    mem_limit:`${s.memoryMb}m`,cpus:s.cpus,pids_limit:256,security_opt:['no-new-privileges:true'],cap_drop:['ALL'],
    read_only:true,tmpfs:['/tmp:rw,noexec,nosuid,size=64m'],
    labels:{'io.2server.owner':c.name,'io.2server.extension':i.instance,'io.2server.app':i.instance,'io.2server.release':release},
    env_file:[`${i.root}/credentials/operator.env`],environment:{SOOT_HOME:'/credentials/home'},
    entrypoint:['/bin/soot'],command:['serve','--config','/config/deployment.json','--instance-id',i.instance,
      '--transaction-root','/transactions','--config-root','/config','--state-root','/state','--credential-root','/credentials',
      '--runtime-receipt','/release/receipt.json',...(initialize?['--initialize-instance']:[])],
    volumes:[{type:'bind',source:`${i.root}/config`,target:'/config',bind:{create_host_path:false}},
      {type:'bind',source:`${i.root}/transactions`,target:'/transactions',bind:{create_host_path:false}},
      {type:'bind',source:i.data,target:'/state',bind:{create_host_path:false}},
      {type:'bind',source:`${i.root}/credentials`,target:'/credentials',bind:{create_host_path:false}},
      {type:'bind',source:`${i.root}/releases/${release}`,target:'/release',read_only:true,bind:{create_host_path:false}}],
    networks:[c.edge.network],logging:{driver:'json-file',options:{'max-size':'10m','max-file':'3'}},
  };
  // Compose interpolates dollars even in JSON; secret env is outside Compose.
  return JSON.parse(JSON.stringify({services:{[i.container]:service},networks:{[c.edge.network]:{external:true}}}).replaceAll('$','$$'));
}
export function releaseInput(c:Config,bundle:CheckedBundle,release:string,initialize=false) {
  return {release,image:c.extensions.soot!.image,package_digest:bundle.receipt.oci_manifest_digest.slice(7),
    receipt:bundle.receiptBytes.toString('base64'),receipt_digest:bundle.receiptDigest,compose:supervisor(c,c.extensions.soot!.image,release,initialize)};
}
export async function ready(c:Config,expected?:{source:string;pkg:string;request?:string}):Promise<DeployState> {
  let last:unknown;
  for(let n=0;n<60;n++) {
    try {
      await sootOperations.api(c,'/readyz');
      const state=await sootOperations.state(c);assertRuntime(c,state);
      if(expected&&(!state.baseline||state.baseline.source_digest!==expected.source||state.baseline.package_digest!==expected.pkg
        ||state.persisted_revision!==state.baseline.persisted_revision||state.active_revision!==state.baseline.active_revision
        ||!state.runtime_package_pins.includes(expected.pkg)))throw new Error('Acknowledged active deployment mismatch');
      return state;
    }catch(e){last=e;await sootOperations.pause();}
  }
  throw new Error(`Soot readiness failed; retained source/state and recovery fence require inspection${last instanceof RuntimeError?` (${last.code})`:''}`);
}
export async function settleReceipt(c:Config,request:string,initial:Receipt):Promise<Receipt> {
  let receipt=initial;
  for(let n=0;n<60&&receipt.state==='pending';n++) {
    await sootOperations.pause();
    try {receipt=receiptSchema.parse(await sootOperations.api(c,'/v1/settings/transactions/'+request));}
    catch(e){if(e instanceof RuntimeError)throw e;continue;} // read-only GET during listener handoff
    if(receipt.request_id!==request)throw new Error('Runtime transaction receipt changed request identity');
  }
  return receipt;
}
export async function verifyPublic(c:Config,domains:Domain[]) {
  const state=await ready(c);
  for(const domain of domains)for(const host of domain.hosts) {
    const endpoint='https://'+host;
    const response=await fetch(endpoint+'/readyz',{signal:AbortSignal.timeout(15000),redirect:'error'});
    if(!response.ok)throw new Error('Public HTTPS readiness failed');
    const denied=await fetch(endpoint+'/v1/settings/deploy/state',{signal:AbortSignal.timeout(15000),redirect:'error'});
    if(![401,403].includes(denied.status))throw new Error('Public API must reject missing bearer credentials');
    const authenticated=await fetch(endpoint+'/v1/settings/deploy/state',{headers:{Authorization:'Bearer '+operatorToken(c)},signal:AbortSignal.timeout(15000),redirect:'error'});
    if(!authenticated.ok)throw new Error('Public API authentication failed');
    const publicState=stateSchema.parse(await authenticated.json());
    if(publicState.runtime_identity!==state.runtime_identity||publicState.active_revision!==state.active_revision||goJSON(publicState.baseline)!==goJSON(state.baseline))throw new Error('Public API is routed to a different runtime or receipt');
    console.log(JSON.stringify({endpoint,status:'verified',activeRevision:publicState.active_revision}));
  }
}
export async function restart(c:Config) {
  operatorToken(c);const before=await sootOperations.state(c);assertRuntime(c,before);
  if(!before.baseline)throw new Error('No acknowledged source release; use source plan/apply');
  const facts=await sootOperations.inspect(c);
  if(facts.image.split('@sha256:')[1]!==before.baseline.package_digest||!before.runtime_package_pins.includes(before.baseline.package_digest))throw new Error('Package changed; use reviewed source plan/apply');
  await sootOperations.host(c,{action:'restart'});
  const after=await ready(c);
  if(after.active_revision!==before.active_revision||goJSON(after.baseline)!==goJSON(before.baseline))throw new Error('Restart acknowledgment changed; inspect runtime recovery');
}
export async function retire(c:Config) {
  const i=identity(c);
  if(c.domains.some(d=>JSON.stringify([d.upstream,...d.routes.map(r=>r.upstream)]).includes(i.container+':')))throw new Error('Retire or reroute Soot domains before instance removal');
  operatorToken(c);await sootOperations.host(c,{action:'retire'});
}
