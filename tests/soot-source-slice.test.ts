import { afterEach,expect,test } from 'bun:test';
import { cp,mkdir,mkdtemp,realpath,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSourceBundle } from '../src/modules/extensions/infrastructure/templates/soot/bundle';
import { sliceDecision,sootSourceSlice } from '../src/modules/extensions/infrastructure/templates/soot/slice';
import { sootSourceDeployment } from '../src/modules/extensions/infrastructure/templates/soot/source';
import { sootOperations } from '../src/modules/extensions/infrastructure/templates/soot/deploy';
import { RuntimeError,type DeployState } from '../src/modules/extensions/infrastructure/templates/soot/protocol';
import { parseDocument } from '../src/modules/source/application/documents';
import { run } from '../src/shared/infrastructure/process';
import { setVmSecrets } from '../src/shared/infrastructure/vm-secrets';
import { fixture,runtimeState } from './fixtures/soot/helpers';

const original={...sootOperations},dirs:string[]=[];
const image='registry.example/soot@sha256:35c9af6ab29b4ffea7374a1233b677afef1a79188b8188eba1d0642451f24f23';
const installed={phase:'installed' as const,control_revision:'revisions/11111111-1111-4111-8111-111111111111',current:'22222222-2222-4222-8222-222222222222',image,running:true};
afterEach(async()=>{Object.assign(sootOperations,original);setVmSecrets();for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});

async function source(name='lohi2',spec:Record<string,unknown>={}) {
  const f=await fixture();dirs.push(f.dir);
  await cp(join(import.meta.dir,'../examples/soot-source'),join(f.dir,'source'),{recursive:true});
  // Match a fresh clone: Git drops the empty install root.
  await rm(join(f.dir,'source/bundle/soot/packs.d'),{recursive:true,force:true});
  const path=join(f.dir,'source/source.yaml');
  const raw=Bun.YAML.parse(await Bun.file(path).text()) as any;raw.metadata.name=name;Object.assign(raw.spec,spec);
  await Bun.write(path,Bun.YAML.stringify(raw));
  const doc=parseDocument(raw);if(doc.kind!=='SootSource')throw new Error('fixture kind');
  return {...f,source:{path,document:doc},slice:{path,document:doc,config:f.bound}};
}
const scoped=(f:Awaited<ReturnType<typeof source>>,over:Partial<DeployState>={}):DeployState=>({...runtimeState(f.bound),source:'lohi2',...over});

test('a source bundle validates on its own and must declare the document id',async()=>{
  const f=await source();
  await sootSourceSlice.validate(f.source);
  const other=await source('shop');
  await expect(sootSourceSlice.validate(other.source)).rejects.toThrow('this document deploys source shop');
  // spec.source carries ids 2server names cannot (leading digit).
  const digit=await source('twofound',{source:'2found'});
  await expect(sootSourceSlice.validate(digit.source)).rejects.toThrow('deploys source 2found');
  // A complete deployment bundle is not a source slice.
  const full=await source('lohi2',{bundle:'../bundle'});
  await expect(sootSourceSlice.validate(full.source)).rejects.toThrow('source.json as entrypoint');
});

test('a cloned bundle without its empty install root stages the same tree as one with it',async()=>{
  const f=await source(),bundle=join(f.dir,'source/bundle');
  const cloned=await checkSourceBundle(f.source.path,'bundle','lohi2');
  expect(cloned.directories).toContain('soot/packs.d');
  await mkdir(join(bundle,'soot/packs.d'));
  expect((await checkSourceBundle(f.source.path,'bundle','lohi2')).treeDigest).toBe(cloned.treeDigest);
  // A stray file where the install root belongs is still refused.
  await rm(join(bundle,'soot/packs.d'),{recursive:true});await writeFile(join(bundle,'soot/packs.d'),'x');
  await expect(checkSourceBundle(f.source.path,'bundle','lohi2')).rejects.toThrow();
});

test('plan reads only the scoped state and rides the running package; first deploy needs initial review',async()=>{
  const f=await source(),paths:string[]=[];
  sootOperations.inspect=async()=>installed;
  sootOperations.api=async(_c,path)=>{paths.push(path);return scoped(f);};
  sootOperations.host=async()=>{throw new Error('plan mutation');};
  const {artifact,summary,decision}=await sootSourceSlice.plan(f.slice) as any;
  expect(paths).toEqual(['/v1/settings/deploy/state?source=lohi2']);
  expect(artifact.plan.bindings.source).toBe('lohi2');
  expect(artifact.plan.bindings.package_digest).toBe(image.split('@sha256:')[1]);
  // Without a file count the runtime may hold files: never assume an empty slice.
  expect(decision.kind).toBe('replace');expect(summary.review).toContain('never deployed');
  expect(decision.approve(artifact).plan.reviewed_replacement).toEqual({kind:'initial_source_review',bindings:artifact.plan.bindings});
  // An old runtime answers unscoped state: refuse instead of replacing everything.
  sootOperations.api=async()=>runtimeState(f.bound);
  await expect(sootSourceSlice.plan(f.slice)).rejects.toThrow('does not support source deployments');
  // A package the runtime is not running is a runtime upgrade, not a source deploy.
  sootOperations.api=async()=>scoped(f,{runtime_package_pins:['f'.repeat(64)]});
  await expect(sootSourceSlice.plan(f.slice)).rejects.toThrow('upgrade or restart the runtime App');
});

test('apply stages into the inbox only, commits C3 for the slice and never hands off or publishes',async()=>{
  const f=await source();let state=scoped(f);const actions:string[]=[];let lease:any;
  sootOperations.inspect=async()=>installed;sootOperations.pause=async()=>{};
  sootOperations.host=async(_c,q:any)=>{actions.push(q.action);if(q.action==='lease')return {lease:null};
    if(q.action==='stage-source'){expect(q.files.every((x:any)=>x.name.startsWith('soot/')||x.name==='soot.bundle.json'||x.name.startsWith('docs/'))).toBe(true);expect(q.compose).toBeUndefined();}
    return {};};
  sootOperations.api=async(_c,path,body:any)=>{
    actions.push(path);
    if(path.startsWith('/v1/settings/deploy/state'))return state;
    if(path.endsWith('/prepare')){lease={transaction_id:crypto.randomUUID(),fence:crypto.randomUUID(),plan:body};return lease;}
    if(path.endsWith('/commit')){
      state=scoped(f,{deploy_drift:false,baseline:{id:lease.transaction_id,generation:1,receipt_digest:'c'.repeat(64),persisted_revision:'s2',active_revision:'a2',
        fingerprints:'d'.repeat(64),source_digest:body.plan.bindings.source_digest,package_digest:body.plan.bindings.package_digest}});
      return {transaction_id:lease.transaction_id,request_id:body.plan.request_id,state:'applied',reason_code:'',saved_revision:'s2',active_revision:'a2',config_digest:'e'.repeat(64)};
    }
    throw new Error('unexpected '+path);
  };
  const {artifact}=await sootSourceSlice.plan(f.slice) as any;
  await expect(sootSourceSlice.apply({...f.slice,artifact})).rejects.toThrow('deploy_drift');
  expect(actions.filter(a=>a==='stage-source')).toEqual([]);
  artifact.plan.reviewed_replacement={kind:'initial_source_review',bindings:structuredClone(artifact.plan.bindings)};
  actions.length=0;
  const result=await sootSourceSlice.apply({...f.slice,artifact});
  expect(result.status).toBe('applied');
  expect(actions).toEqual(['/v1/settings/deploy/state?source=lohi2','lease','stage-source','/v1/settings/deploy/prepare','verify-source-stage','/v1/settings/deploy/commit','/v1/settings/deploy/state?source=lohi2']);
  // An edited source after review is stale before any effect.
  actions.length=0;
  await writeFile(join(f.dir,'source/bundle/soot/soots/lohi2-assistant/mission.md'),'edited');
  await expect(sootSourceSlice.apply({...f.slice,artifact})).rejects.toThrow();expect(actions).toEqual([]);
});

test('a package change at commit aborts the lease instead of handing off the runtime',async()=>{
  const f=await source();const actions:string[]=[];
  sootOperations.inspect=async()=>installed;
  sootOperations.host=async(_c,q:any)=>{actions.push(q.action);return q.action==='lease'?{lease:null}:{};};
  sootOperations.api=async(_c,path,body:any)=>{
    actions.push(path);
    if(path.startsWith('/v1/settings/deploy/state'))return scoped(f);
    if(path.endsWith('/prepare'))return {transaction_id:crypto.randomUUID(),fence:crypto.randomUUID(),plan:body};
    if(path.endsWith('/commit'))throw new RuntimeError('config_busy','restart_required');
    return {};
  };
  const {artifact}=await sootSourceSlice.plan(f.slice) as any;
  artifact.plan.reviewed_replacement={kind:'initial_source_review',bindings:structuredClone(artifact.plan.bindings)};
  await expect(sootSourceSlice.apply({...f.slice,artifact})).rejects.toThrow('Upgrade the runtime App');
  expect(actions).toContain('/v1/settings/deploy/abort');expect(actions).not.toContain('handoff');
});

test('a bare runtime App installs without a bundle, reports current, and upgrades its package with restore on failure',async()=>{
  const f=await fixture();dirs.push(f.dir);
  const raw=Bun.YAML.parse(await Bun.file(f.input.path).text()) as any;delete raw.spec.bundle;await Bun.write(f.input.path,Bun.YAML.stringify(raw));
  const doc=parseDocument(raw);if(doc.kind!=='Extension')throw new Error('kind');
  const input={...f.input,document:doc};
  await sootSourceDeployment.validate(input);
  // Absent: an empty management bootstrap, as with a bundle.
  let host:any={...installed,phase:'absent',current:'',image:'',running:false};const actions:string[]=[];
  sootOperations.inspect=async()=>host;sootOperations.pause=async()=>{};
  sootOperations.api=async(_c,path)=>path==='/readyz'?{ready:true}:runtimeState(f.bound);
  sootOperations.host=async(_c,q:any)=>{actions.push(q.action);return q.action==='lease'?{lease:null}:{};};
  let {artifact,summary}=await sootSourceDeployment.plan(input) as any;
  expect(artifact.operation).toBe('initialize');expect(summary.review).toContain('SootSource');
  artifact.reviewed_initialization=true;
  expect((await sootSourceDeployment.apply({...input,artifact})).status).toBe('initialized');expect(actions).toEqual(['initialize']);
  // Installed on the same package: nothing to do.
  host=installed;({artifact}=await sootSourceDeployment.plan(input) as any);expect(artifact.operation).toBe('none');
  actions.length=0;expect((await sootSourceDeployment.apply({...input,artifact})).status).toBe('applied');expect(actions).toEqual([]);
  // A different running package is a reviewed package-only upgrade.
  host={...installed,image:'registry.example/soot@sha256:'+'9'.repeat(64)};
  ({artifact,summary}=await sootSourceDeployment.plan(input) as any);expect(artifact.operation).toBe('upgrade');expect(summary.toPackage).toBe(image.split('@sha256:')[1]);
  actions.length=0;
  expect((await sootSourceDeployment.apply({...input,artifact})).summary).toMatchObject({status:'upgraded'});
  expect(actions).toEqual(['lease','release','handoff','publish']);
  // The new package does not come up with the same configuration: restore.
  actions.length=0;let calls=0;
  sootOperations.api=async(_c,path)=>path==='/readyz'?{ready:true}:(calls++?{...runtimeState(f.bound),active_revision:'other'}:runtimeState(f.bound));
  await expect(sootSourceDeployment.apply({...input,artifact})).rejects.toThrow('previous release restored');
  expect(actions).toEqual(['lease','release','handoff','handoff']);
});

test('host api admits the scoped deploy state and nothing else new',async()=>{
  const host=fileURLToPath(new URL('../src/modules/extensions/infrastructure/templates/soot/host.py',import.meta.url));
  const program=String.raw`
import importlib.util, json
spec = importlib.util.spec_from_file_location('soot_host', ${JSON.stringify(host)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.owner = lambda q: None
m.container = lambda q: {'State': {'Running': True}, 'NetworkSettings': {'Networks': {'edge': {'IPAddress': '10.0.0.2'}}}}
seen = []
class Response:
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def read(self, n): return b'{}'
m.urllib.request.urlopen = lambda req, timeout: seen.append(req.full_url) or Response()
q = {'network': 'edge', 'token': 't'}
m.api({**q, 'path': '/v1/settings/deploy/state?source=lohi2'})
for bad in ['/v1/settings/deploy/state?source=../x', '/v1/settings/deploy/state?source=a&x=1', '/v1/settings/actions']:
    try:
        m.api({**q, 'path': bad})
        raise AssertionError(bad)
    except RuntimeError as e:
        assert str(e) == 'unsupported_runtime_operation', bad
print(json.dumps(seen))
`;
  expect(JSON.parse(await run(['python3','-c',program]))).toEqual(['http://10.0.0.2:7788/v1/settings/deploy/state?source=lohi2']);
});

test('a first deploy into an empty slice replaces nothing; drift and stray files need a decision',()=>{
  const base={} as any,baseline={generation:4} as any;
  const safe=sliceDecision({...base,source:'lohi2',baseline:null,deploy_drift:true,source_files:0},'lohi2');
  expect(safe.kind).toBe('safe');expect(safe.message).toContain('nothing on the runtime is replaced');
  const plan={bindings:{source:'lohi2'}};
  expect((safe.approve({plan}) as any).plan.reviewed_replacement).toEqual({kind:'initial_source_review',bindings:plan.bindings});
  expect(sliceDecision({...base,source:'lohi2',baseline:null,deploy_drift:true,source_files:3},'lohi2').kind).toBe('replace');
  const edited=sliceDecision({...base,source:'lohi2',baseline,deploy_drift:true,source_files:3},'lohi2');
  expect(edited.kind).toBe('replace');expect(edited.message).toContain('edited on the runtime (Nest)');
  expect((edited.approve({plan}) as any).plan.reviewed_replacement.kind).toBe('reviewed_replacement');
  const same=sliceDecision({...base,source:'lohi2',baseline,deploy_drift:false,source_files:3},'lohi2');
  expect(same.kind).toBe('none');expect(same.approve({plan})).toEqual({plan});
});

test('one-step deploy asks before replacing edits and never guesses without a terminal',async()=>{
  const {decidePlan}=await import('../src/modules/source/cli/command');
  const approve=(a:unknown)=>({...(a as object),approved:true});
  const replace={artifact:{id:1},decision:{kind:'replace' as const,message:'Source lohi2 was edited',approve}};
  const noTerminal=()=>null;
  await expect(decidePlan(replace,'lohi2',{},noTerminal)).rejects.toThrow('--replace-edits');
  expect(await decidePlan(replace,'lohi2',{'--replace-edits':'true'},noTerminal)).toEqual({id:1,approved:true});
  expect(await decidePlan(replace,'lohi2',{},()=>' lohi2 ')).toEqual({id:1,approved:true});
  await expect(decidePlan(replace,'lohi2',{},()=>'y')).rejects.toThrow('Not confirmed');
  // Nothing is replaced: no question, approved as planned.
  let asked=false;
  expect(await decidePlan({artifact:{id:2},decision:{kind:'safe',message:'First deploy',approve}},'lohi2',{},()=>{asked=true;return null;})).toEqual({id:2,approved:true});
  expect(asked).toBe(false);
  await expect(decidePlan({artifact:{}},'x',{},noTerminal)).rejects.toThrow('reviewed plan');
});

test('SootSource CLI validates offline and checks one-step deploy flags',async()=>{
  const {fileCommand}=await import('../src/modules/source/cli/command');
  const f=await source();
  expect(await fileCommand(['validate','-f',f.source.path])).toBe(true);
  await expect(fileCommand(['plan','-f',f.source.path,'--replace-edits'])).rejects.toThrow('one-step deploy');
  await expect(fileCommand(['deploy','-f',f.source.path,'--plan-file','/x','--apply','--replace-edits'])).rejects.toThrow('one-step deploy');
  await expect(fileCommand(['deploy','-f',f.source.path,'--plan-file','/x'])).rejects.toThrow('requires deploy --apply');
  await expect(fileCommand(['delete','-f',f.source.path])).rejects.toThrow('SootSource supports');
  await expect(fileCommand(['plan','-f',f.source.path,'--image','x/y:1'])).rejects.toThrow('declared in the document');
});

test('init soot-source writes a deployable SootSource beside the bundle',async()=>{
  const {fileCommand}=await import('../src/modules/source/cli/command');
  const dir=await mkdtemp(join(tmpdir(),'2server-init-source-'));
  try {
    const file=join(dir,'repo','soot-source','deploy.yaml');
    expect(await fileCommand(['init','soot-source','2found','--runtime','soot','-o',file])).toBe(true);
    const text=await Bun.file(file).text();expect(text).toContain('2srv deploy -f');
    expect(Bun.YAML.parse(text)).toEqual({apiVersion:'2server.app/v1',kind:'SootSource',metadata:{name:'source-2found'},spec:{runtime:'soot',bundle:'.',source:'2found'}});
    await expect(fileCommand(['init','soot-source','2found','--runtime','soot','-o',file])).rejects.toThrow();
    await expect(fileCommand(['init','soot-source','Lohi2','--runtime','soot','-o',join(dir,'x.yaml')])).rejects.toThrow('lower-case');
    await expect(fileCommand(['init','soot-source','lohi2','--runtime','Soot!','-o',join(dir,'x.yaml')])).rejects.toThrow('--runtime');
  } finally {await rm(dir,{recursive:true,force:true});}
});
