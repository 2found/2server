import { afterEach,expect,test } from 'bun:test';
import { chmod,link,mkdir,readFile,rm,symlink,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bindInstance,instanceSecret } from '../src/modules/extensions/application/instance';
import { extensionForCliName } from '../src/modules/extensions/application/registry';
import { checkBundle,canonical,framedDigest,stageFiles,strictJSON,type BundleFile } from '../src/modules/extensions/infrastructure/templates/soot/bundle';
import { identity,operatorToken,supervisor } from '../src/modules/extensions/infrastructure/templates/soot/deploy';
import { parseDocument } from '../src/modules/source/application/documents';
import { fileCommand } from '../src/modules/source/cli/command';
import { setVmSecrets } from '../src/shared/infrastructure/vm-secrets';
import { fixture } from './fixtures/soot/helpers';
const dirs:string[]=[];
afterEach(async()=>{setVmSecrets();for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
test('named offline init/validate uses strict pinned receipt/C1; never overwrites init',async()=>{
  const f=await fixture();dirs.push(f.dir);
  const file=join(f.dir,'new.yaml');await fileCommand(['init','app','new','--template','soot','-o',file]);
  await expect(fileCommand(['init','app','new','--template','soot','-o',file])).rejects.toThrow();
  expect(await fileCommand(['validate','-f',file])).toBe(true);
  const b=await checkBundle(f.input);expect(b.receipt.source_commit).toBe('afb1e0d568071d59fe7d4ff7e3cf88e872915b4d');
  for(const spec of [{...f.doc.spec,image:'soot:latest'},{...f.doc.spec,typo:true}])expect(()=>parseDocument({...f.doc,spec})).toThrow();
  await writeFile(join(f.dir,'runtime-receipt.json'),JSON.stringify({...b.receipt,target:'linux/arm64'}));
  await expect(checkBundle(f.input)).rejects.toThrow('receipt');
});

test('complete installed C1 pack preserves producer tree pins and relocates only verified receipt paths',async()=>{
  const f=await fixture();dirs.push(f.dir);const root=join(f.dir,'bundle');await rm(root,{recursive:true});await mkdir(root);
  const vectors=await Bun.file(join(import.meta.dir,'fixtures/soot/c1-v1.json')).json();const v=vectors.vectors[2];
  const manifest=structuredClone(v.manifest),files:BundleFile[]=[];
  for(const file of v.files) {
    let bytes=file.bytes_hex?Buffer.from(file.bytes_hex,'hex'):Buffer.from(file.bytes_utf8);
    if(file.path==='soot/deployment.json')bytes=Buffer.from(JSON.stringify({...JSON.parse(bytes.toString()),listen:'0.0.0.0:7788',data_dir:'/state',token_env:'SOOT_OPERATOR_TOKEN'}));
    if(file.path==='soot/ai.json')bytes=Buffer.from(JSON.stringify({...JSON.parse(bytes.toString()),credentials_dir:'/credentials'}));
    await mkdir(join(root,file.path,'..'),{recursive:true});await writeFile(join(root,file.path),bytes,{mode:file.executable?0o700:0o600});
    files.push({name:file.path,mode:file.executable?0o700:0o600,bytes});
  }
  const p=manifest.packs[0];await mkdir(join(root,p.installed_path,'tools'),{recursive:true});
  for(const file of files.filter(f=>f.name.startsWith(p.package_root+'/'))){const target=join(root,p.installed_path,file.name.slice(p.package_root.length+1));await writeFile(target,file.bytes,{mode:file.mode});}
  const receipt={repository:join(root,p.source.path),path:'',ref:'',archive:true,sha256:p.archive_sha256,id:p.id,archive_sha256:p.archive_sha256,
    installed_at:'2026-01-01T00:00:00Z',directory:join(root,p.installed_path),capabilities:['fixturepack/guide','fixturepack/inspect']};
  const receiptPath=join(root,p.installed_path,'.soot-source.json');await writeFile(receiptPath,JSON.stringify(receipt));
  delete manifest.source_digest.value;manifest.source_digest.value=framedDigest('soot.bundle.source.v1',canonical(manifest),files);
  await writeFile(join(root,'soot.bundle.json'),JSON.stringify(manifest));
  const checked=await checkBundle(f.input),staged=stageFiles(checked,'/transactions/inbox/reviewed');
  const relocated=JSON.parse(staged.find(f=>f.name===p.installed_path+'/.soot-source.json')!.bytes.toString());
  expect(relocated.directory).toBe('/transactions/inbox/reviewed/'+p.installed_path);expect(relocated.repository).toBe('/transactions/inbox/reviewed/'+p.source.path);
  expect(checked.manifest.source_digest.value).toBe(manifest.source_digest.value);expect(checked.manifest.packs[0].tree_digest.value).toBe(vectors.vectors[1].expected_package_tree_digest);
  await writeFile(receiptPath,JSON.stringify({...receipt,archive_sha256:'a'.repeat(64)}));await expect(checkBundle(f.input)).rejects.toThrow('receipt');
  await writeFile(receiptPath,JSON.stringify(receipt));await chmod(join(root,p.installed_path,'tools/inspect.sh'),0o600);
  await expect(checkBundle(f.input)).rejects.toThrow('Installed tree digest mismatch');
});
test('private content, symlink/hardlink, case collision, mismatch and duplicate metadata fail offline',async()=>{
  for(const kind of ['secret','link','hardlink','collision','mismatch','duplicate']) {
    const f=await fixture();dirs.push(f.dir);const root=join(f.dir,'bundle/soot');
    const mission=join(root,'soots/helper/mission.md');
    if(kind==='secret')await writeFile(join(root,'.env'),'FAKE=not-an-export');
    if(kind==='link'){await rm(mission);await symlink('SOUL.md',mission);}
    if(kind==='hardlink'){await rm(mission);await link(join(root,'soots/helper/SOUL.md'),mission);}
    if(kind==='collision')await writeFile(join(root,'Deployment.json'),'{}');
    if(kind==='mismatch')await writeFile(mission,'changed source');
    if(kind==='duplicate')await writeFile(join(f.dir,'bundle/soot.bundle.json'),' {"schema_version":1,"schema_version":1}');
    await expect(checkBundle(f.input)).rejects.toThrow();
  }
  expect(()=>strictJSON('{"key":1,"key":2}')).toThrow('Duplicate');
  expect(()=>strictJSON('{"key":1} garbage')).toThrow();
});
test('two instances isolate stores/credentials/container names and reject global secret fallback',async()=>{
  const a=await fixture('alpha'),b=await fixture('beta');dirs.push(a.dir,b.dir);
  setVmSecrets({alpha:{SOOT_OPERATOR_TOKEN:'alpha-placeholder-token-0000000000000000000'},beta:{SOOT_OPERATOR_TOKEN:'beta-placeholder-token-00000000000000000000'}});
  const ia=identity(a.bound),ib=identity(b.bound);expect(ia.container).not.toBe(ib.container);expect(ia.root).not.toBe(ib.root);expect(ia.data).not.toBe(ib.data);
  expect(operatorToken(a.bound)).not.toBe(operatorToken(b.bound));
  const compose=supervisor(a.bound,a.doc.spec.image as string,crypto.randomUUID());
  const service=(compose.services as any)[ia.container];expect(service.ports).toBeUndefined();expect(service.read_only).toBe(true);
  expect(service.volumes.map((v:any)=>v.target)).toEqual(['/config','/transactions','/state','/credentials','/release']);
  expect(service.volumes.at(-1).read_only).toBe(true);
  const old=process.env.SOOT_OPERATOR_TOKEN;process.env.SOOT_OPERATOR_TOKEN='global-placeholder-token-000000000000000';setVmSecrets({alpha:{}});
  try{expect(instanceSecret(a.bound,'SOOT_OPERATOR_TOKEN')).toBeUndefined();expect(()=>operatorToken(a.bound)).toThrow('VM secret');}
  finally{if(old===undefined)delete process.env.SOOT_OPERATOR_TOKEN;else process.env.SOOT_OPERATOR_TOKEN=old;}
});
test('generic native capability binds a third extension without template-name dispatch',async()=>{
  const f=await fixture();dirs.push(f.dir);const seen:string[]=[];
  const ext={...extensionForCliName('soot')!,name:'third',sourceDeployment:{
    validate:async()=>{},plan:async({config}:any)=>{seen.push(config.instance.name);return {artifact:{},summary:{}};},
    apply:async({config}:any)=>{seen.push(config.instance.name);return {status:'applied' as const,spec:{},summary:{}};},
  }};
  const bound=bindInstance(f.config,'alpha',ext,{template:'third',spec:{},secrets:{},webhooks:[]});
  await bound.sourceDeployment!.plan({...f.input,config:f.config});await bound.sourceDeployment!.apply({...f.input,config:f.config,artifact:{}});
  expect(seen).toEqual(['alpha','alpha']);
});
test('producer C1 vectors preserve exact framed source/tree codec',async()=>{
  const vectors=await Bun.file(join(import.meta.dir,'fixtures/soot/c1-v1.json')).json();
  for(const v of vectors.vectors) {
    const m=structuredClone(v.manifest);delete m.source_digest.value;
    const files=v.files.filter((f:any)=>!f.path.startsWith(v.manifest.install_root+'/')).map((f:any)=>({name:f.path,mode:f.executable?0o700:0o600,
      bytes:f.bytes_hex?Buffer.from(f.bytes_hex,'hex'):Buffer.from(f.bytes_utf8)}));
    expect(framedDigest('soot.bundle.source.v1',canonical(m),files)).toBe(v.manifest.source_digest.value);
  }
});
