import { createHash } from 'node:crypto';
import { lstat,readFile } from 'node:fs/promises';
import { dirname,resolve } from 'node:path';
import { z } from 'zod';
import { resourceCommand } from '../src/cli/resources';
import { appCommand } from '../src/modules/apps/cli/command';
import { readConfig } from '../src/modules/config/infrastructure/file';
import { connectedCommand } from '../src/modules/control/application/session';
import { connection } from '../src/modules/control/infrastructure/connection';
import { fileCommand } from '../src/modules/source/cli/command';
import { parseDocument } from '../src/modules/source/application/documents';
import { parseData } from '../src/shared/infrastructure/serialization';

// A private, dedicated target must already exist. This driver does not provision
// a VM, publish/import an image, create credentials or approve source replacement.
const fixtureSchema=z.object({version:z.literal(1),nonproduction:z.literal(true),server:z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
  connectionFile:z.string().min(1),providerIdentityDigest:z.string().regex(/^[a-f0-9]{64}$/),
  instances:z.array(z.object({name:z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),sourceFile:z.string().min(1),
    planOutput:z.string().min(1),reviewedPlan:z.string().optional(),restoreOutput:z.string().optional(),reviewedRestore:z.string().optional()}).strict()).length(2),
}).strict().refine(f=>f.instances[0].name!==f.instances[1].name,'Use two distinct isolated instances');
function sorted(value:unknown):unknown {
  if(Array.isArray(value))return value.map(sorted);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,sorted((value as Record<string,unknown>)[k])]));
  return value;
}
function digest(value:unknown){return createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');}
const options:Record<string,string>={};
for(let i=2;i<Bun.argv.length;i++) {
  const flag=Bun.argv[i];if(!['--fixture','--step','--instance','--apply'].includes(flag)||flag in options)throw new Error('Unknown or duplicate isolated VM fixture option');
  if(flag==='--apply')options[flag]='true';else{const v=Bun.argv[++i];if(!v||v.startsWith('-'))throw new Error('Missing fixture option');options[flag]=v;}
}
if(!options['--fixture'])throw new Error('Use --fixture PRIVATE_FILE [--step plan|deploy|status|restart|restore|retire] [--instance NAME] [--apply]');
const file=resolve(options['--fixture']),st=await lstat(file);
if(!st.isFile()||st.nlink!==1||st.mode&0o077||st.size>65536)throw new Error('Fixture must be a private regular JSON file below 64 KiB');
const fixture=fixtureSchema.parse(JSON.parse(await readFile(file,'utf8'))),base=dirname(file);
const conn=resolve(base,fixture.connectionFile),transport=await connection({'--connection':conn});
const step=options['--step']??'plan';
if(!['plan','deploy','status','restart','restore','retire'].includes(step)||options['--apply']&&['plan','status'].includes(step))throw new Error('Unsupported fixture operation');
const instances=fixture.instances.filter(i=>!options['--instance']||i.name===options['--instance']);if(!instances.length)throw new Error('Unknown fixture instance');
// Validate local desired inputs before any connection. Source --apply later
// compares its own checked artifact and runtime bindings under the VM lock.
for(const instance of instances) {
  const source=resolve(base,instance.sourceFile),doc=parseDocument(parseData(await Bun.file(source).text()));
  if(doc.kind!=='Extension'||doc.metadata.name!==instance.name||doc.template!=='soot')throw new Error('Fixture must bind two named Soot source Apps');
  await fileCommand(['validate','-f',source]);
}
await connectedCommand(['get','app','--connection',conn],async internal=>{
  const c=await readConfig(internal.at(-1)!);
  const identity={server:c.name,provider:c.vm??(c.ssh.kind==='gcp'?{kind:'gcp',instance:c.ssh.instance,project:c.ssh.project,zone:c.ssh.zone}:{kind:'direct',host:c.ssh.host,user:c.ssh.user,port:c.ssh.port}),transport};
  if(c.name!==fixture.server||digest(identity)!==fixture.providerIdentityDigest)throw new Error(`Dedicated fixture server/provider identity changed; inspected identity digest ${digest(identity)} must be independently reviewed`);
});
for(const instance of instances) {
  const source=resolve(base,instance.sourceFile),flags=options['--apply']?['--apply']:[];
  if(step==='plan'||step==='deploy') {
    if(options['--apply']&&!instance.reviewedPlan)throw new Error('An exact reviewed source plan is required; this driver never invents approval');
    await fileCommand([step==='plan'?'plan':'deploy','-f',source,'--connection',conn,...(options['--apply']?['--plan-file',resolve(base,instance.reviewedPlan!),...flags]:['--plan-output',resolve(base,instance.planOutput)])]);
  } else if(step==='restore') {
    const artifact=options['--apply']?instance.reviewedRestore:instance.restoreOutput;
    if(!artifact)throw new Error('Declare a separate private restore output or reviewed restore artifact');
    await connectedCommand(['app-action',instance.name,'restore-release','--connection',conn,...(options['--apply']?['--plan-file',resolve(base,artifact),...flags]:['--plan-output',resolve(base,artifact)])],async internal=>{await appCommand(internal,resourceCommand);});
  } else {
    const command=step==='status'?['app-action',instance.name,'release-status']:step==='restart'?['reload','app',instance.name]:['delete','app',instance.name];
    await connectedCommand([...command,'--connection',conn,...flags],async internal=>{
      if(step==='status')await appCommand(internal,resourceCommand);else await resourceCommand(internal);
    });
  }
}
console.log(JSON.stringify({step,instances:instances.map(i=>i.name),mutationsRequested:!!options['--apply'],scope:'dedicated isolated fixture; provider smoke and backup/DR are separate'}));
