import {mkdtemp,rm,mkdir,writeFile,readdir} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {parseData,parseDocument,imageReference,type Document} from './documents';
import {connectedCommand,findConnection,secretKeys} from './control';
import {appSchema,configSchema,readConfig,type Config,type App} from './config';
import {deployApp,resolveEnv} from './apps';
import {preflightEdge} from './edge';
import {withExtensionDomains,extensionByName,extensionForCliName} from './extensions';
import {resourceCommand} from './resources';
import {confirmComposeMigrations,validateTemplate} from './compose-apps';
import {resolveImage} from './images';
import {operatorState} from './operator-state';
import {extensionTemplate,serviceTemplate} from './templates';
import {bindWorkload} from './workload';

export const fileHelp=`Source configuration (YAML or JSON):
  2server validate -f app/2server/deploy.yaml
  2server <plan|apply|deploy|delete|get|rollback> -f FILE [--connection FILE|--ssh user@host] [--apply]
  apply/deploy: [--image repository:tag|repository@sha256:...] [--migrations-applied]
  2server init extension NAME -o platform/NAME.yaml  # NAME: postgres, redis, nats, monitoring, image-proxy
  2server init service NAME -o platform/NAME.yaml   # arbitrary single-container extension
  2server secret list [--app NAME]
  2server secret set [--app NAME] --env-file /private/secrets.env [--apply]
  2server secret delete [--app NAME] --key KEY [--apply]
  Connection discovery: nearest .2server/connection.yaml (legacy .json supported).
  Tags are resolved from the registry on every plan/apply; no cached-tag fallback.`;
export const fileOperations={connectedCommand,deployApp,resolveEnv,preflightEdge,resourceCommand,resolveImage};
function parseArgs(args:string[]) {
 const result:Record<string,string>={};
 for(let i=1;i<args.length;i++) {
  const flag=args[i]==='--file'?'-f':args[i];
  if(!['-f','--image','--connection','--ssh','--port','--identity','--apply','--migrations-applied'].includes(flag)||flag in result) throw new Error('Unknown or duplicate file command option');
  if(['--apply','--migrations-applied'].includes(flag)) result[flag]='true';
  else { const value=args[++i]; if(!value||value.startsWith('-')) throw new Error(`Missing ${flag}`);result[flag]=value; }
 }
 if(!result['-f']) throw new Error('Specify a source config with -f FILE');
 return result;
}
function redacted(value:unknown):unknown {
 if(Array.isArray(value)) return value.map(redacted);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,k==='env'||k==='environment'?Object.fromEntries(Object.keys(v as object).map(key=>[key,'<value hidden>'])):redacted(v)]));
 return value;
}
export function authoritativeApp(d:Extract<Document,{kind:'App'}>,image:string,runtime?:Record<string,unknown>):App {
 return appSchema.parse({...d.spec,name:d.metadata.name,image,compose:d.spec.compose?{...d.spec.compose,runtime}:undefined});
}
export function assertBindings(old:App|undefined,next:App) {
 if(!old) {if(next.compose)throw new Error('Compose adoption must happen before applying its source file');return;}
 const binding=(a:App)=>a.compose?{project:a.compose.project,services:a.compose.services,containers:a.compose.containers,upstreamFile:a.compose.upstreamFile,upstreamName:a.compose.upstreamName}:null;
 if(JSON.stringify(binding(old))!==JSON.stringify(binding(next)))throw new Error('Cannot replace runtime ownership bindings; migrate/adopt explicitly');
}
export async function fileCommand(args:string[]):Promise<boolean> {
 if(args[0]==='init') {
  if(args.length!==5||!['extension','service'].includes(args[1])||args[3]!=='-o')throw new Error('Use init extension|service NAME -o FILE');
  const d=args[1]==='service'?serviceTemplate(args[2]):extensionTemplate(args[2]);const file=resolve(args[4]);
  await mkdir(dirname(file),{recursive:true});await writeFile(file,Bun.YAML.stringify(d,null,2)+'\n',{flag:'wx',mode:0o644});
  console.log(`Created ${file}; edit config and set its declared secrets before apply.`);return true;
 }
 if(!args.includes('-f')&&!args.includes('--file')&&args[0]!=='apply')return false;
 if(!['validate','plan','apply','deploy','delete','get','rollback'].includes(args[0]) || (args[1]&&!args[1].startsWith('-')))return false;
 const o=parseArgs(args),path=resolve(o['-f']);const doc=parseDocument(parseData(await Bun.file(path).text()));
 if(o['--apply']&&['validate','plan','get'].includes(args[0]))throw new Error('--apply is only valid for mutating commands');
 if(o['--image']&&doc.kind!=='App')throw new Error('--image is only valid for App files');
 if(o['--migrations-applied']&&doc.kind!=='App')throw new Error('--migrations-applied is only valid for App files');
 if(!['apply','deploy','plan'].includes(args[0])&&(o['--image']||o['--migrations-applied']))throw new Error('Image/migration overrides require plan/apply/deploy');
 let runtime:Record<string,unknown>|undefined;
 if(doc.kind==='App'&&doc.runtimeFile) {
  runtime=parseData(await Bun.file(resolve(dirname(path),doc.runtimeFile)).text()) as Record<string,unknown>;
  if(!runtime||typeof runtime!=='object'||Array.isArray(runtime)||'x-2server' in runtime)throw new Error('runtimeFile must be a public Compose object without control metadata');
  const a=authoritativeApp(doc,'example/app@sha256:'+'a'.repeat(64),runtime);
  validateTemplate({...runtime,'x-2server':{}} as any,a);
 }
 if(args[0]==='validate') {console.log(`Valid ${doc.kind}: ${doc.metadata.name}; config=${path}`);return true;}
 const conn:string[]=[];
 for(const flag of ['--connection','--ssh','--port','--identity'])if(o[flag])conn.push(flag,o[flag]);
 const connection=o['--connection']?resolve(o['--connection']):o['--ssh']??await findConnection();
 if(!connection)throw new Error('No connection found; run 2server connect --ssh user@host, or pass --connection FILE');
 if(!conn.length)conn.push('--connection',connection);
 const dir=await mkdtemp(join(tmpdir(),'2server-document-'));
 try {
  const pending=join(dir,'spec.json');await writeFile(pending,JSON.stringify(doc),{mode:0o600});
  const mutate=['apply','deploy','delete','rollback'].includes(args[0])&&!!o['--apply'];
  await fileOperations.connectedCommand(['file-action','--spec',pending,...conn,...(mutate?['--apply']:[])],async internal=>{
   const manifest=internal.at(-1)!;let c=await readConfig(manifest);
   console.log(`Config: ${path}\nConnection: ${connection}\nServer: ${c.name}\nResource: ${doc.kind}/${doc.metadata.name}`);
   const resource=doc.kind==='Service'?'extension':doc.kind.toLowerCase();const extDoc=doc.kind==='Extension'?extensionForCliName(doc.metadata.name):undefined;const name=extDoc?.name??doc.metadata.name;
   if(['get','delete','rollback'].includes(args[0])) {
    if(args[0]==='rollback'&&doc.kind!=='App')throw new Error('Stateful extensions require their restore/update workflow');
    await fileOperations.resourceCommand([args[0],resource,doc.metadata.name,'-f',manifest,...(mutate?['--apply']:[])]);return;
   }
   for(const r of doc.requires) {
    const key=extensionByName(r.name)?.name??extensionForCliName(r.name)?.name??r.name;
    if(r.kind==='App'?!c.apps.some(a=>a.name===r.name):!(c.extensions as Record<string,unknown>)[key]&&!c.extensions.services[key])throw new Error(`Missing dependency ${r.kind}/${r.name}; apply its file first`);
   }
   if(doc.kind==='App') {
    const requested=o['--image']??doc.spec.image;imageReference.parse(requested);
    const old=c.apps.find(a=>a.name===name);
    const provisional=await bindWorkload(c,authoritativeApp(doc,'example/app@sha256:'+'a'.repeat(64),runtime),old);
    assertBindings(old,provisional);
    // Reject missing secrets and ownership changes before downloading image layers.
    await fileOperations.resolveEnv(provisional);
    const image=await fileOperations.resolveImage(c,requested);
    const next=appSchema.parse({...provisional,image});
    const updated=configSchema.parse({...c,apps:[...c.apps.filter(a=>a.name!==name),next]});
    console.log(JSON.stringify({requestedImage:requested,resolvedImage:image,before:redacted(old??null),after:redacted(next),domains:doc.domains},null,2));
    if(!mutate){console.log('Plan only; pass --apply to deploy. Registry image layers may have been pulled.');return;}
    confirmComposeMigrations(!!o['--migrations-applied']);
    try {await fileOperations.preflightEdge(withExtensionDomains(updated));await fileOperations.deployApp(updated,next);}
    finally {confirmComposeMigrations(false);}
    await Bun.write(manifest,JSON.stringify(updated)); c=updated;
    for(const domain of doc.domains) {
      const f=join(dir,'domain.json');await Bun.write(f,JSON.stringify(domain));
      await fileOperations.resourceCommand([c.domains.some(d=>d.name===domain.name)?'update':'create','domain',domain.name,'-f',manifest,'--spec',f,'--apply']);
      c=await readConfig(manifest);
    }
   } else {
    const spec=doc.kind==='Domain'?{...doc.spec,name}:structuredClone(doc.spec);
    if(doc.kind==='Extension') {
      // Extension secret values are global VM secrets loaded by connectedCommand.
      const refs=doc.secrets;
      const required=new Set(secretKeys([spec,doc.webhooks]));
      for(const key of required)if(!refs[key])throw new Error(`Declare secrets.${key} in the extension file`);
      for(const [key,ref] of Object.entries(refs)) {
        if(!required.has(key))throw new Error(`Unused extension secret declaration ${key}`);
        if(key!==ref.key)throw new Error('Extension secret reference key must match its Env field');
        if(!process.env[ref.key])throw new Error(`Missing VM secret ${ref.key}; use 2server secret set --env-file FILE --apply`);
      }
    }
    if(doc.kind==='Extension'||doc.kind==='Service') {
      const pin=async(ref:string)=>ref.includes('@sha256:')?ref:`${ref}@${(await fileOperations.resolveImage(c,ref)).split('@')[1]}`;
      if(typeof spec.image==='string')spec.image=await pin(spec.image);
      const images=(spec as Record<string,unknown>).images;if(images&&typeof images==='object')for(const [key,value]of Object.entries(images))if(typeof value==='string')(images as Record<string,string>)[key]=await pin(value);
    }
    const existing=doc.kind==='Extension'?(c.extensions as Record<string,unknown>)[name]:doc.kind==='Service'?c.extensions.services[name]:c.domains.find(d=>d.name===name);
    if((doc.kind==='Extension'||doc.kind==='Service')&&existing) {
      const locked=doc.kind==='Service'?['dataPath']:(extDoc?.immutable??[]);
      for(const field of locked)if((existing as Record<string,unknown>)[field]!==(spec as Record<string,unknown>)[field])throw new Error(`Changing ${field} requires explicit stateful data migration; refusing implicit replacement`);
    }
    console.log(JSON.stringify({before:redacted(existing??null),after:redacted(spec)},null,2));
    const f=join(dir,'resource.json');await Bun.write(f,JSON.stringify(spec));
    const before=await Bun.file(manifest).text();
    if(doc.kind==='Extension'&&extDoc?.acceptsWebhooks)await Bun.write(manifest,JSON.stringify({...c,extensions:{...c.extensions,webhooks:doc.webhooks,alertWebhookEnv:undefined}}));
    try {await fileOperations.resourceCommand([existing?'update':'create',resource,doc.metadata.name,'-f',manifest,'--spec',f,...(mutate?['--apply']:[])]);}
    catch(e){await Bun.write(manifest,before);throw e;}
    if(!mutate)await Bun.write(manifest,before);
   }
   if(mutate) {
    const history=join(operatorState(c.name),'deployments');await mkdir(history,{recursive:true,mode:0o700});
    await writeFile(join(history,crypto.randomUUID()+'.json'),JSON.stringify({appliedConfig:doc.kind==='App'?c.apps.find(a=>a.name===name):doc.spec,document:doc,appliedAt:new Date().toISOString(),configPath:path,requestedImage:doc.kind==='App'?(o['--image']??doc.spec.image):undefined,resolvedImage:doc.kind==='App'?c.apps.find(a=>a.name===name)?.image:undefined}),{mode:0o600});
    const records=await Promise.all((await readdir(history)).map(async f=>{
      const record=await Bun.file(join(history,f)).json();
      const time=Date.parse(record.appliedAt);
      return {f,time:Number.isFinite(time)?time:0};
    }));
    for(const r of records.sort((a,b)=>b.time-a.time).slice(20))await rm(join(history,r.f));
   }
  });
 } finally {await rm(dir,{recursive:true,force:true});}
 return true;
}
