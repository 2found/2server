import { expect,test } from 'bun:test';
import { configSchema } from '../src/modules/config/application/config';
import { controlResources } from '../src/modules/control/application/scope';
import { mutatesControl } from '../src/modules/control/application/session';
import { mergeControl } from '../src/modules/control/domain/merge';
const config=configSchema.parse({version:1,name:'test',ssh:{kind:'ssh',host:'vm.example',user:'ops'},edge:{mode:'managed'},apps:['api','web'].map(name=>({name,image:'example/app@sha256:'+'a'.repeat(64),port:8080,memoryMb:128,cpus:1}))});
const base={config,env:{TOKEN:'hidden'},appSecrets:{api:{PASSWORD:'hidden'}},state:{'compose/api/template.json':'old','deployments/old.json':'old'}};
test('merge retains unrelated concurrent edits, removals and history; same-resource conflicts fail without leaking values',()=>{
 const a=structuredClone(base),b=structuredClone(base);
 a.config.apps[0].replicas=2;b.config.apps[1].replicas=3;
 a.state['compose/api/template.json']='new';
 delete (a.state as any)['deployments/old.json'];
 (b.state as any)['deployments/new.json']='new';
 (b.appSecrets as any).web={PASSWORD:'new-secret'};
 const merged=mergeControl(base,a,b);
 expect(merged.config.apps.map(a=>a.replicas)).toEqual([2,3]);
 expect(merged.state as Record<string,string>).toEqual({'compose/api/template.json':'new','deployments/new.json':'new'});
 expect(merged.appSecrets).toEqual(b.appSecrets);
 b.config.apps[0].replicas=4;
 expect(()=>mergeControl(base,a,b)).toThrow('Concurrent control state conflict');
});
test('scope parser handles aliases, app secrets and shared infrastructure',()=>{
 for(const args of [['deploy','app','api'],['apps','reload','api'],['rollback','app','api'],['scale','app','api','--replicas','2']])
  expect(controlResources([...args,'--apply'],config)).toEqual(['app:api']);
 expect(controlResources(['deploy','app','api','--env-file','private.env','--apply'],config)).toEqual(['server']);
 expect(controlResources(['reload','domain','site','--apply'],config)).toEqual(['domains']);
 expect(mutatesControl(['app-action','postgres','backups','--apply'],config)).toBe(false);
 expect(mutatesControl(['app-action','postgres','backup','--apply'],config)).toBe(true);
 expect(controlResources(['secret','set','--app','web','--apply'],config)).toEqual(['app:web']);
 for(const args of [['setup'],['deploy'],['delete','app','api'],['update','app','api','--spec','spec.json'],['reload','extension','postgres']])
  expect(controlResources([...args,'--apply'],config)).toEqual(['server']);
});
