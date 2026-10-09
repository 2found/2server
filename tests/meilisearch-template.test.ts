import {afterEach, expect, test} from 'bun:test';
import {configSchema} from '../src/modules/config/application/config';
import {resolveBindings} from '../src/modules/extensions/application/bindings';
import {extensionFor} from '../src/modules/extensions/application/registry';
import {statefulFiles, statefulPreflightScript} from '../src/modules/extensions/application/stateful';
import {parseDocument} from '../src/modules/source/application/documents';
import {templateApp} from '../src/modules/source/application/templates';
import {setVmSecrets} from '../src/shared/infrastructure/vm-secrets';
const base={version:1,name:'search-test',ssh:{kind:'ssh',host:'unused.example',user:'operator'},edge:{mode:'managed'}};
function entry(name:string){const d=parseDocument(templateApp(name,'meilisearch'));if(d.kind!=='Extension')throw Error();return {template:'meilisearch',spec:d.spec,secrets:d.secrets};}
afterEach(()=>setVmSecrets());
test('platform search is a named standalone template with private auth and durable isolated data',async()=>{
 const c=configSchema.parse({...base,extensionApps:{'platform-search':entry('platform-search'),other:entry('other')}});
 setVmSecrets({'platform-search':{MEILISEARCH_MASTER_KEY:'synthetic-platform-key-1234567890'},other:{MEILISEARCH_MASTER_KEY:'synthetic-other-key-1234567890000'}});
 for(const name of ['platform-search','other']){
  const ext=extensionFor(c,name)!;const files=await statefulFiles(c,ext);
  const svc=JSON.parse(files['compose.json']).services[`two-search-test-${name}`];
  expect(svc.image).toBe('getmeili/meilisearch:v1.54.3');
  expect(svc.ports).toBeUndefined();expect(svc.environment).toBeUndefined();
  expect(svc.volumes).toContain(`/opt/2server/data/${name}:/meili_data`);
  expect(svc.command).toEqual(['/bin/meilisearch','--config-file-path','/run/secrets/meilisearch.toml']);
  expect(files['compose.json']).not.toContain('synthetic-');
  expect(files['extension.json']).not.toContain('synthetic-');
  expect(files['meilisearch.toml']).toContain('env = "production"');
  expect(files['meilisearch.toml']).toContain('max_indexing_memory = "512 MiB"');
  expect(files['verify.conf']).toContain(`synthetic-${name==='other'?'other':'platform'}-key`);
  expect(statefulPreflightScript(c,ext)).toContain(`/opt/2server/extensions/${name}/current`);
  expect(ext.stateful!.verify!(ext.context!(c))).toContain(`docker exec two-search-test-${name} curl --config`);
  const endpoint=resolveBindings(c,{SEARCH_URL:{extension:name,output:'endpoint'}}).SEARCH_URL;
  expect(endpoint).toBe(`http://two-search-test-${name}:7700`);
 }
 expect(()=>resolveBindings(c,{KEY:{extension:'platform-search',output:'masterKey'}})).toThrow();
});
test('missing instance secret and unsafe memory settings fail before any remote install',async()=>{
 const c=configSchema.parse({...base,extensionApps:{'platform-search':entry('platform-search')}});
 setVmSecrets({other:{MEILISEARCH_MASTER_KEY:'synthetic-foreign-key-123456789000'}});
 await expect(statefulFiles(c,extensionFor(c,'platform-search')!)).rejects.toThrow('secret set --app platform-search');
 const desired=entry('platform-search');
 expect(()=>configSchema.parse({...base,extensionApps:{'platform-search':{...desired,spec:{...desired.spec,memoryMb:512,indexingMemoryMb:512}}}})).toThrow();
 expect(()=>configSchema.parse({...base,extensionApps:{'platform-search':{...desired,spec:{...desired.spec,soot:{}}}}})).toThrow();
});
