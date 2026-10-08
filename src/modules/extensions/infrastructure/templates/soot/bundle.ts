import { constants } from 'node:fs';
import { lstat,open,readdir } from 'node:fs/promises';
import { dirname,join,resolve } from 'node:path';
import { z } from 'zod';
import type { NativeSourceInput } from '../../../domain/types';
import { hash,sha256 } from './protocol';

// C1 metadata and framing are frozen producer contracts; runtime admission is
// repeated by T2 before source writes. Never install/fetch a pack during plan.
const path=z.string().max(1024).refine(v=>v.split('/').every(p=>/^[A-Za-z0-9_.-]+$/.test(p)&&p!=='.'&&p!=='..'),'Unsafe C1 path');
const paths=z.array(path).max(4096).refine(v=>v.every((p,i)=>!i||v[i-1]<p),'C1 paths must be sorted and unique');
const id=z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const packSchema=z.object({id,version:z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/),package_root:path,installed_path:path,
  source:z.discriminatedUnion('kind',[
    z.object({kind:z.literal('local_archive'),path}).strict(),
    z.object({kind:z.literal('git'),repository:z.string().max(1024),commit:z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),subdir:z.union([path,z.literal('.')])}).strict(),
  ]),archive_sha256:hash,tree_digest:z.object({algorithm:z.literal('soot.package.tree.v1-sha256'),value:hash}).strict(),
  selected_executables:z.array(z.object({soot_id:id,selector:z.string(),operation_id:id,
    program:z.discriminatedUnion('kind',[z.object({kind:z.literal('path'),name:z.enum(['sh','timeout','soot'])}).strict(),
      z.object({kind:z.literal('pack_file'),path}).strict()])}).strict()).max(4096),
}).strict();
export const bundleSchema=z.object({schema_version:z.literal(1),config_entrypoint:path,config_roots:paths.refine(v=>v.length>0),
  package_roots:paths,guide_files:paths,template_files:paths,install_root:path,
  source_digest:z.object({algorithm:z.literal('soot.bundle.source.v1-sha256'),value:hash}).strict(),packs:z.array(packSchema).max(32),
}).strict();
export type Bundle=z.infer<typeof bundleSchema>;
const dependency=z.object({name:z.string(),sha256:hash,applets:z.array(z.enum(['sh','timeout'])).optional(),image:z.string().optional(),
  source_sha256:hash.optional(),version:z.string().optional()}).strict();
export const runtimeReceiptSchema=z.object({schema_version:z.literal(1),source_commit:z.string().regex(/^[a-f0-9]{40}$/),
  runtime_version:z.string().max(128),target:z.literal('linux/amd64'),toolchain:z.string().max(128),base:z.string().max(128),
  binary_sha256:hash,runtime_tar_sha256:hash,oci_manifest_digest:z.string().regex(/^sha256:[a-f0-9]{64}$/),oci_archive_sha256:hash,
  go_mod_sha256:hash,go_sum_sha256:hash,dependencies:z.array(dependency).max(32),
  external_executables:z.array(z.enum(['/bin/sh','/bin/timeout'])).max(2),
  mounts:z.object({config:z.literal('/config'),credentials:z.literal('/credentials'),state:z.literal('/state')}).strict(),
}).strict();
export type RuntimeReceipt=z.infer<typeof runtimeReceiptSchema>;
export type BundleFile={name:string;mode:number;bytes:Buffer};
export type CheckedBundle={manifest:Bundle;files:BundleFile[];directories:string[];archives:{digest:string;bytes:Buffer}[];treeDigest:string;receipt:RuntimeReceipt;receiptBytes:Buffer;receiptDigest:string};
const maxBytes=128*1024*1024;
const inRoot=(p:string,r:string)=>p===r||p.startsWith(r+'/');
const byName=(a:BundleFile,b:BundleFile)=>a.name<b.name?-1:a.name>b.name?1:0;

// Parse without lost duplicate keys. Error messages never echo input values.
export function strictJSON(raw:string,limit=65536):unknown {
  if(Buffer.byteLength(raw)>limit)throw new Error('JSON size limit exceeded');
  let i=0;
  const ws=()=>{while(/\s/.test(raw[i]??'')&&i<raw.length)i++;};
  const string=()=>{const start=i++;while(i<raw.length){const c=raw[i++];if(c==='\\')i++;else if(c==='"')return JSON.parse(raw.slice(start,i)) as string;}throw new Error('Invalid JSON string');};
  const value=(depth:number):unknown=>{
    ws();if(depth>64)throw new Error('JSON nesting limit exceeded');
    if(raw[i]==='"')return string();
    if(raw[i]==='{'){
      i++;ws();const out:Record<string,unknown>=Object.create(null);
      if(raw[i]==='}'){i++;return out;}
      while(true){ws();if(raw[i]!=='"')throw new Error('Invalid JSON key');const k=string();
        if(Object.hasOwn(out,k))throw new Error('Duplicate JSON key');ws();if(raw[i++]!==':')throw new Error('Invalid JSON object');
        out[k]=value(depth+1);ws();const next=raw[i++];if(next==='}')return out;if(next!==',')throw new Error('Invalid JSON object');}
    }
    if(raw[i]==='['){i++;ws();const out:unknown[]=[];if(raw[i]===']'){i++;return out;}
      while(true){out.push(value(depth+1));ws();const next=raw[i++];if(next===']')return out;if(next!==',')throw new Error('Invalid JSON array');}}
    const token=/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(raw.slice(i))?.[0];
    if(!token)throw new Error('Invalid JSON');i+=token.length;return JSON.parse(token);
  };
  const result=value(0);ws();if(i!==raw.length)throw new Error('Expected one JSON document');return result;
}
export function canonical(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';
  return JSON.stringify(value);
}
export function framedDigest(domain:string,metadata:string|undefined,files:BundleFile[]):string {
  const parts:Buffer[]=[Buffer.from(domain+'\0')];
  const u64=(n:number)=>{const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(n));parts.push(b);};
  const put=(b:Buffer)=>{u64(b.length);parts.push(b);};
  if(metadata!==undefined)put(Buffer.from(metadata));
  u64(files.length);
  for(const f of [...files].sort(byName)){put(Buffer.from(f.name));parts.push(Buffer.from([f.mode&0o111?1:0]));put(f.bytes);}
  return sha256(Buffer.concat(parts));
}
function privatePath(p:string,templates:string[]=[]) {
  return p.toLowerCase().split('/').some(v=>['.git','.soot','node_modules','bin','credentials','secrets','vault','vault.json','connections.json','connection.json','credentials.json','.soot-source.json','.soot-add.lock'].includes(v)
    ||(/^(?:\.env)(?:\.|$)/.test(v)&&!(v==='.env.example'&&templates.includes(p)))
    ||/\.(?:db(?:-wal|-shm)?|sqlite3?|pem|key|p12|pfx|exe|dll|dylib|so|a|o)$/.test(v));
}
async function checkedDirectory(p:string) {
  // Check every ancestor, including a locator's parents, before traversal.
  if(p!==dirname(p))await checkedDirectory(dirname(p));
  const st=await lstat(p);if(!st.isDirectory()||st.isSymbolicLink())throw new Error('Bundle directory must not be a link');
}
export async function checkedRead(p:string,limit=maxBytes):Promise<{bytes:Buffer;mode:number}> {
  await checkedDirectory(dirname(p));
  const before=await lstat(p);if(!before.isFile()||before.nlink!==1||before.mode&0o7000||before.size>limit)throw new Error('Unsafe or oversized bundle file');
  const f=await open(p,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {const stat=await f.stat();if(stat.ino!==before.ino||stat.dev!==before.dev)throw new Error('Bundle changed while opening');
    const bytes=await f.readFile(),after=await f.stat(),current=await lstat(p);
    if(bytes.length>limit||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.mode!==before.mode||after.nlink!==1
      ||current.ino!==before.ino||current.dev!==before.dev||current.isSymbolicLink())throw new Error('Bundle changed while reading');
    return {bytes,mode:before.mode&0o777};
  } finally{await f.close();}
}
function validateMetadata(m:Bundle) {
  const roots=[...m.config_roots,...m.package_roots];
  for(const [i,r] of roots.entries()) {
    if(privatePath(r,m.template_files)||inRoot('soot.bundle.json',r)||roots.slice(0,i).some(p=>inRoot(r,p)||inRoot(p,r)))throw new Error('Unsafe or overlapping C1 roots');
  }
  if(!m.config_roots.some(r=>inRoot(m.config_entrypoint,r))||inRoot(m.config_entrypoint,m.install_root)
    ||m.config_roots.some(r=>inRoot(r,m.install_root))||m.package_roots.some(r=>inRoot(r,m.install_root)||inRoot(m.install_root,r)))throw new Error('Invalid C1 entrypoint or install root');
  const singles=[...m.guide_files,...m.template_files,...m.packs.flatMap(p=>p.source.kind==='local_archive'?[p.source.path]:[])];
  if(new Set(singles).size!==singles.length||singles.some(p=>p==='soot.bundle.json'||privatePath(p,m.template_files)||inRoot(p,m.install_root)||roots.some(r=>inRoot(p,r)||inRoot(r,p))))throw new Error('Invalid C1 single file inventory');
  if(m.packs.length!==m.package_roots.length||new Set(m.packs.map(p=>p.package_root)).size!==m.packs.length)throw new Error('Package roots must match pack pins');
  for(const [i,p] of m.packs.entries()) {
    if(i&&m.packs[i-1].id>=p.id||!m.package_roots.includes(p.package_root)||p.installed_path!==m.install_root+'/'+p.id)throw new Error('Invalid pack identity');
    if(p.source.kind==='git') {
      const locator=p.source.repository;
      if(locator.startsWith('git@')) {
        if(!/^git@[A-Za-z0-9.-]+:[A-Za-z0-9_./-]+$/.test(locator))throw new Error('Unsafe Git locator');
      } else {
        let u:URL;try{u=new URL(locator);}catch{throw new Error('Unsafe Git locator');}
        if(!['https:','ssh:'].includes(u.protocol)||!u.hostname||!u.pathname||u.search||u.hash||u.password
          ||u.username&&(u.protocol!=='ssh:'||u.username!=='git'))throw new Error('Git locator cannot contain credentials');
      }
    }
    let previous='';for(const e of p.selected_executables){const key=[e.soot_id,e.selector,e.operation_id].join('\0');
      if(!e.selector.startsWith(p.id+'/')||!id.safeParse(e.selector.slice(p.id.length+1)).success||key<=previous)throw new Error('Invalid executable selector');previous=key;}
  }
}
const packReceiptSchema=z.object({repository:z.string(),path:z.string(),ref:z.string(),archive:z.boolean().optional(),sha256:hash.optional(),id,
  commit:z.string().optional(),archive_sha256:hash,installed_at:z.string(),directory:z.string(),capabilities:z.array(z.string()).max(4096)}).strict();

export async function checkBundle(input:NativeSourceInput):Promise<CheckedBundle> {
  if(!input.document.template)throw new Error('Soot requires a named App with template');
  const spec=input.document.spec;
  const root=resolve(dirname(input.path),String(spec.bundle));await checkedDirectory(root);
  const manifestFile=await checkedRead(join(root,'soot.bundle.json'),65536);
  let m:Bundle;try{m=bundleSchema.parse(strictJSON(manifestFile.bytes.toString()));}catch{throw new Error('Invalid strict C1 manifest');}
  validateMetadata(m);
  const receiptFile=await checkedRead(resolve(dirname(input.path),String(spec.runtimeReceipt)),65536);
  let receipt:RuntimeReceipt;try{receipt=runtimeReceiptSchema.parse(strictJSON(receiptFile.bytes.toString()));}catch{throw new Error('Invalid Linux runtime receipt');}
  if(!String(spec.image).endsWith('@'+receipt.oci_manifest_digest))throw new Error('Runtime receipt/image pin mismatch');
  if(receipt.external_executables.length!==2||!receipt.external_executables.includes('/bin/sh')||!receipt.external_executables.includes('/bin/timeout'))throw new Error('Unsupported executable closure');
  const files:BundleFile[]=[],archives:{digest:string;bytes:Buffer}[]=[],directories=new Set<string>(),seen=new Map<string,string>();let bytes=0,nodes=0;
  const add=async(name:string,receiptAllowed=false)=>{
    if(!path.safeParse(name).success||(!receiptAllowed&&privatePath(name,m.template_files)))throw new Error('Private or unsafe bundle content');
    const folded=name.toLowerCase();if(seen.has(folded))throw new Error('Case collision or duplicate inventory');seen.set(folded,name);
    if(++nodes>8192||files.length>=4096)throw new Error('Bundle inventory count limit');
    const f=await checkedRead(join(root,name),maxBytes-bytes);bytes+=f.bytes.length;
    if(!receiptAllowed&&(f.bytes.subarray(0,4).equals(Buffer.from([127,69,76,70]))||f.bytes.subarray(0,2).toString()==='MZ'
      ||[0xfeedface,0xfeedfacf,0xcefaedfe,0xcffaedfe,0xcafebabe,0xbebafeca].includes(f.bytes.length>=4?f.bytes.readUInt32BE():0)))throw new Error('Compiled content is not C1 source');
    if(name.endsWith('/.env.example')||name==='.env.example')if(f.bytes.toString().split('\n').some(l=>l&&!l.startsWith('#')&&!/^[A-Za-z_][A-Za-z0-9_]*=CHANGE_ME$/.test(l)))throw new Error('Non-placeholder template value');
    files.push({name,...f});
  };
  const walk=async(name:string,installed=false)=>{
    if(!installed&&name===m.install_root)return;
    if(!path.safeParse(name).success||privatePath(name,m.template_files))throw new Error('Unsafe bundle directory');
    await checkedDirectory(join(root,name));if(++nodes>8192)throw new Error('Bundle directory count limit');
    if(seen.has(name.toLowerCase())&&seen.get(name.toLowerCase())!==name)throw new Error('Case collision');seen.set(name.toLowerCase(),name);directories.add(name);
    for(const e of await readdir(join(root,name),{withFileTypes:true})) {
      const n=name+'/'+e.name;if(e.isDirectory())await walk(n,installed);else await add(n,installed&&e.name==='.soot-source.json');
    }
  };
  await checkedDirectory(join(root,m.install_root));directories.add(m.install_root);
  const installEntries=await readdir(join(root,m.install_root));
  if(installEntries.length>33||installEntries.some(v=>!m.packs.some(p=>p.id===v)&&v!=='.soot-add.lock'))throw new Error('Undeclared installed derivative');
  if(installEntries.includes('.soot-add.lock'))await checkedRead(join(root,m.install_root,'.soot-add.lock'),65536);
  for(const r of [...m.config_roots,...m.package_roots])await walk(r);
  for(const p of [...m.guide_files,...m.template_files])await add(p);
  for(const p of m.packs) {
    const tree=files.filter(f=>inRoot(f.name,p.package_root)).map(f=>({...f,name:f.name.slice(p.package_root.length+1)}));
    if(framedDigest('soot.package.tree.v1',undefined,tree)!==p.tree_digest.value)throw new Error('Package tree digest mismatch');
    if(p.source.kind==='local_archive'){await add(p.source.path);if(sha256(files.at(-1)!.bytes)!==p.archive_sha256)throw new Error('Archive digest mismatch');}
    else {
      const f=await checkedRead(join(root,'obtained-archives',p.archive_sha256+'.tar'),maxBytes-bytes);bytes+=f.bytes.length;
      if(sha256(f.bytes)!==p.archive_sha256)throw new Error('Obtained Git archive digest mismatch');
      archives.push({digest:p.archive_sha256,bytes:f.bytes});
    }
  }
  const meta=structuredClone(m) as unknown as Record<string,any>;delete meta.source_digest.value;
  if(framedDigest('soot.bundle.source.v1',canonical(meta),files)!==m.source_digest.value)throw new Error('C1 source digest mismatch');
  const authored=new Set(files.map(f=>f.name));
  for(const p of m.packs) {
    const before=files.length;await walk(p.installed_path,true);
    const installed=files.slice(before),raw=installed.find(f=>f.name===p.installed_path+'/.soot-source.json');
    if(!raw)throw new Error('Installed receipt missing');
    let r:z.infer<typeof packReceiptSchema>;try{r=packReceiptSchema.parse(strictJSON(raw.bytes.toString()));}catch{throw new Error('Invalid installed receipt');}
    if(r.id!==p.id||r.directory!==join(root,p.installed_path)||r.archive_sha256!==p.archive_sha256||!Number.isFinite(Date.parse(r.installed_at)))throw new Error('Installed receipt pin mismatch');
    if(p.source.kind==='local_archive'&&(!r.archive||r.sha256!==p.archive_sha256||r.repository!==join(root,p.source.path)||r.path||r.ref||r.commit))throw new Error('Archive receipt mismatch');
    if(p.source.kind==='git'&&(r.archive||r.sha256||r.repository!==p.source.repository||r.path!==p.source.subdir||r.ref!==p.source.commit||r.commit!==p.source.commit))throw new Error('Git receipt mismatch');
    const tree=installed.filter(f=>f!==raw).map(f=>({...f,name:f.name.slice(p.installed_path.length+1)}));
    if(framedDigest('soot.package.tree.v1',undefined,tree)!==p.tree_digest.value)throw new Error('Installed tree digest mismatch');
    const pack=tree.find(f=>f.name==='pack.json');if(!pack)throw new Error('Installed pack manifest missing');
    const packDoc=strictJSON(pack.bytes.toString()) as {id:string;capabilities?:Record<string,unknown>};
    if(packDoc.id!==p.id||canonical(Object.keys(packDoc.capabilities??{}).sort().map(v=>p.id+'/'+v))!==canonical(r.capabilities))throw new Error('Installed capabilities mismatch');
    for(const e of p.selected_executables)if(e.program.kind==='pack_file') {
      const f=tree.find(f=>f.name===(e.program as {path:string}).path);
      if(!f||!(f.mode&0o111)||!/^#!\s*\/bin\/(?:sh|timeout)(?:\s|$)/.test(f.bytes.toString().split('\n')[0]))throw new Error('Unsupported executable closure');
    }
  }
  if(!authored.has(m.config_entrypoint))throw new Error('Config entrypoint missing');
  const config=strictJSON(files.find(f=>f.name===m.config_entrypoint)!.bytes.toString()) as Record<string,unknown>;
  if(typeof config.ai_config!=='string'||!path.safeParse(config.ai_config).success||['providers','tiers','model','compact_at','credentials_dir'].some(k=>k in config))throw new Error('C1 requires a relative inventoried shared AI config without inline policy');
  const aiFile=files.find(f=>f.name===join(dirname(m.config_entrypoint),config.ai_config as string));
  if(!aiFile)throw new Error('C1 shared AI file must be inventoried');
  const ai=strictJSON(aiFile.bytes.toString()) as Record<string,unknown>;
  // C3 preserves host state/auth; authored listener and vault must also retain
  // the fixed mount identity so API readiness remains reachable after commit.
  if(config.listen!=='0.0.0.0:7788'||ai.credentials_dir!=='/credentials'||config.token_env!==spec.tokenEnv
    ||!['data','state','/state'].includes(String(config.data_dir)))throw new Error('Bundle must bind the documented VM listener, state, vault and token reference');
  files.push({name:'soot.bundle.json',...manifestFile});files.sort(byName);
  return {manifest:m,files,directories:[...directories].sort(),archives,treeDigest:framedDigest('2server.soot.stage.v1',canonical(m),[...files,...archives.map(a=>({name:'obtained-archives/'+a.digest+'.tar',mode:0o600,bytes:a.bytes}))]),
    receipt,receiptBytes:receiptFile.bytes,receiptDigest:sha256(receiptFile.bytes)};
}

// Installed receipt paths are materialization facts, not source digest inputs.
export function stageFiles(bundle:CheckedBundle,target:string):BundleFile[] {
  return bundle.files.map(f=>{
    if(!f.name.endsWith('/.soot-source.json'))return f;
    const r=packReceiptSchema.parse(strictJSON(f.bytes.toString()));const p=bundle.manifest.packs.find(p=>p.id===r.id)!;
    r.directory=target+'/'+p.installed_path;if(p.source.kind==='local_archive')r.repository=target+'/'+p.source.path;
    return {...f,mode:0o600,bytes:Buffer.from(JSON.stringify(r))};
  });
}
