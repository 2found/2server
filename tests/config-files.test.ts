import {afterEach, expect, test} from 'bun:test';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configSchema} from '../src/modules/config/application/config';
import {extensionFor} from '../src/modules/extensions/application/registry';
import {statefulFiles} from '../src/modules/extensions/application/stateful';
import {configFileRefs, renderConfigFile} from '../src/modules/extensions/domain/config-files';
import {parseDocument} from '../src/modules/source/application/documents';
import {templateApp} from '../src/modules/source/application/templates';
import {fileCommand, fileOperations} from '../src/modules/source/cli/command';
import {setSessionState} from '../src/shared/infrastructure/operator-state';
import {setVmSecrets} from '../src/shared/infrastructure/vm-secrets';

const base={version:1,name:'cf-test',ssh:{kind:'ssh',host:'unused.example',user:'operator'},edge:{mode:'managed'}};
const keys={CLIPROXY_CLIENT_KEY:'synthetic-client-key-1234567890',CLIPROXY_MANAGEMENT_KEY:'synthetic-manage-key-1234567890'};
function entry(extra:Record<string,unknown>={}){
 const d=parseDocument(templateApp('ai','cliproxy'));if(d.kind!=='Extension')throw Error();
 return {template:'cliproxy',spec:d.spec,secrets:d.secrets,...extra};
}
const native='api-keys: ["${CLIPROXY_CLIENT_KEY}"]\nremote-management: {secret-key: "${MGMT_HASH}"}\nnote: "$${LITERAL}"\n';
const original={...fileOperations};
afterEach(()=>{setVmSecrets();setSessionState();Object.assign(fileOperations,original);});

test('references are UPPER_CASE names; $${ is a literal and anything else malformed fails',()=>{
 expect(configFileRefs(native)).toEqual(['CLIPROXY_CLIENT_KEY','MGMT_HASH']);
 expect(renderConfigFile('a=${A} b=$${A} c=${A}',()=>'v$1')).toBe('a=v$1 b=${A} c=v$1');
 expect(()=>configFileRefs('x: ${lower}')).toThrow('Invalid config file reference');
 expect(()=>configFileRefs('x: ${A:-default}')).toThrow('Invalid config file reference');
});

test('a config file replaces the template mount at its path and renders only declared VM secrets',async()=>{
 const c=configSchema.parse({...base,extensionApps:{ai:entry({
  secrets:{...entry().secrets,MGMT_HASH:{provider:'vm',key:'MGMT_HASH'}},
  configFiles:[{mountPath:'/run/secrets/config.yaml',content:native},{mountPath:'/etc/extra.txt',content:'plain\n'}]})}});
 setVmSecrets({ai:{...keys,MGMT_HASH:'$2b$10$synthetic.bcrypt.hash.value'}});
 const files=await statefulFiles(c,extensionFor(c,'ai')!);
 const svc=JSON.parse(files['compose.json']).services['two-cf-test-ai'];
 expect(svc.volumes).toEqual(['/opt/2server/data/ai:/data','./config-file-0:/run/secrets/config.yaml:ro','./config-file-1:/etc/extra.txt:ro']);
 expect(files['config-file-0']).toBe('api-keys: ["synthetic-client-key-1234567890"]\nremote-management: {secret-key: "$2b$10$synthetic.bcrypt.hash.value"}\nnote: "${LITERAL}"\n');
 expect(files['config-file-1']).toBe('plain\n');
 expect(files['compose.json']+files['extension.json']).not.toContain('synthetic-client-key');
});

test('undeclared references, missing values and duplicate mounts fail before any VM change',async()=>{
 expect(()=>configSchema.parse({...base,extensionApps:{ai:entry({configFiles:[{mountPath:'/c.yaml',content:'k: ${NOPE}'}]})}})).toThrow('undeclared secret NOPE');
 expect(()=>configSchema.parse({...base,extensionApps:{ai:entry({configFiles:[{mountPath:'/c',content:'a'},{mountPath:'/c',content:'b'}]})}})).toThrow('unique');
 expect(()=>configSchema.parse({...base,extensionApps:{ai:entry({configFiles:[]})}})).toThrow();
 const c=configSchema.parse({...base,extensionApps:{ai:entry({secrets:{...entry().secrets,MGMT_HASH:{provider:'vm',key:'MGMT_HASH'}},configFiles:[{mountPath:'/c.yaml',content:native}]})}});
 setVmSecrets({ai:keys});
 await expect(statefulFiles(c,extensionFor(c,'ai')!)).rejects.toThrow('secret set --app ai');
});

test('source files load configFiles beside the App file and store their text, never secret values',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'config-files-'));
 try {
  const app={...templateApp('ai','cliproxy'),configFiles:[{source:'cliproxy.yaml',mountPath:'/run/secrets/config.yaml'}]} as any;
  app.secrets.MGMT_HASH={provider:'vm',key:'MGMT_HASH'};
  const file=join(dir,'ai.yaml'),server=join(dir,'server.json');
  await writeFile(file,Bun.YAML.stringify(app));
  await expect(fileCommand(['validate','-f',file])).rejects.toThrow('Config file not found: cliproxy.yaml');
  await writeFile(join(dir,'cliproxy.yaml'),native.replace('${MGMT_HASH}','${UNDECLARED}'));
  await expect(fileCommand(['validate','-f',file])).rejects.toThrow('Declare secrets.UNDECLARED');
  await writeFile(join(dir,'cliproxy.yaml'),native);
  expect(await fileCommand(['validate','-f',file])).toBe(true);
  await writeFile(server,JSON.stringify(configSchema.parse(base)));
  fileOperations.connectedCommand=async(args,fn)=>{await fn([...args,'-f',server]);return true;};
  fileOperations.resolveImage=async(_c,ref)=>ref+'@sha256:'+'a'.repeat(64);
  let deployed:any;fileOperations.deployExtension=async(c,name)=>{deployed=c.extensionApps[name];};
  setVmSecrets({ai:keys});
  await expect(fileCommand(['deploy','-f',file,'--ssh','operator@host','--apply'])).rejects.toThrow('Missing VM secret MGMT_HASH');
  setVmSecrets({ai:{...keys,MGMT_HASH:'$2b$10$synthetic.bcrypt.hash.value'}});
  setSessionState(join(dir,'state'));
  try {await fileCommand(['deploy','-f',file,'--ssh','operator@host','--apply']);}finally{setSessionState();}
  expect(deployed.configFiles).toEqual([{mountPath:'/run/secrets/config.yaml',content:native}]);
  const saved=await Bun.file(server).text();
  expect(JSON.parse(saved).extensionApps.ai.configFiles[0].content).toBe(native);
  expect(saved).not.toContain('synthetic');
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('configFiles are rejected on templates without a container',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'config-files-'));
 try {
  const file=join(dir,'short.yaml');
  await writeFile(join(dir,'x.txt'),'x');
  await writeFile(file,Bun.YAML.stringify({...templateApp('links','url-shortener'),configFiles:[{source:'x.txt',mountPath:'/x'}]}));
  await expect(fileCommand(['validate','-f',file])).rejects.toThrow('template runs a container');
 } finally {await rm(dir,{recursive:true,force:true});}
});
