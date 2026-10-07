import { expect, test } from 'bun:test';
import { cp, mkdtemp, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '../src/modules/config/application/config';
import { compileDefinition } from '../src/modules/extensions/infrastructure/definition';
import { emailRoutingRuntime } from '../src/modules/extensions/infrastructure/templates/email-routing/source';

test('unknown external engines, inherited adapter keys and invalid provider defaults fail closed', () => {
  const definition = {
    apiVersion: '2server.app/v1', kind: 'ExtensionDefinition', metadata: {name: 'mail'},
    runtime: {engine: 'unregistered', defaults: {}},
  };
  expect(() => compileDefinition(definition, {})).toThrow('Unknown extension runtime');
  const inherited = Object.create({unregistered: emailRoutingRuntime});
  expect(() => compileDefinition(definition, {}, inherited)).toThrow('Unknown extension runtime');
  expect(() => compileDefinition(definition, {}, {unregistered: emailRoutingRuntime})).toThrow();
  expect(() => compileDefinition({...definition, outputs: {url: {type: 'endpoint', protocol: 'http', port: 8080}}}, {}, {unregistered: emailRoutingRuntime})).toThrow('External recipes');
});

test('another external runtime needs only its template and registration; VM paths and unsupported commands refuse effects', async () => {
  const root = new URL('../', import.meta.url).pathname;
  const dir = await mkdtemp(join(tmpdir(), 'external-runtime-'));
  try {
    await cp(join(root, 'src'), join(dir, 'src'), {recursive: true});
    await symlink(join(root, 'node_modules'), join(dir, 'node_modules'));
    const template = join(dir, 'src/modules/extensions/infrastructure/templates/test-provider');
    await mkdir(template, {recursive: true});
    await writeFile(join(template, 'extension.yaml'), Bun.YAML.stringify({
      apiVersion: '2server.app/v1', kind: 'ExtensionDefinition', metadata: {name: 'test-provider'},
      runtime: {engine: 'test-provider', defaults: {resource: 'example'}},
    }));
    await writeFile(join(template, 'source.ts'), `
      import {z} from 'zod';
      export const calls=[];
      export const runtime={schema:z.object({resource:z.string().min(1)}).strict(),source:{
        operations:['plan','apply','deploy','get'],connection:'none',initHint:'provider setup',planMessage:'provider plan',
        validateDocument(d){if(d.domains.length||d.requires.length||Object.keys(d.secrets).length)throw Error('No VM resources');},
        async run(input){calls.push(input);return {resource:input.spec.resource,apply:input.apply};}
      }};
    `);
    // Composition is the only shared file edited when registering the new adapter.
    const registry = join(dir, 'src/modules/extensions/application/registry.ts');
    await writeFile(registry, `import {runtime} from '../infrastructure/templates/test-provider/source';\n` +
      (await Bun.file(registry).text()).replace('{ worker: workerRuntime,', "{ 'test-provider': runtime, worker: workerRuntime,"));
    await writeFile(join(dir, 'app.yaml'), Bun.YAML.stringify({
      apiVersion: '2server.app/v1', kind: 'App', metadata: {name: 'test-app'},
      template: 'test-provider', spec: {resource: 'desired'},
    }));
    const base = configSchema.parse({version: 1, name: 'test', ssh: {kind: 'ssh', host: 'host.example', user: 'operator'}, edge: {mode: 'managed'}});
    const proc = Bun.spawn([process.execPath, '-e', `
      import {fileCommand,fileOperations} from './src/modules/source/cli/command';
      import {configSchema} from './src/modules/config/application/config';
      import {deployAll,deployExtension} from './src/modules/extensions/application/deploy';
      import {appResource} from './src/modules/apps/cli/resource';
      import {extensionResource} from './src/modules/extensions/cli/resource';
      import {parseDocument} from './src/modules/source/application/documents';
      import {calls} from './src/modules/extensions/infrastructure/templates/test-provider/source';
      fileOperations.connectedCommand=async()=>{throw Error('Unexpected VM connection');};
      globalThis.fetch=async()=>{throw Error('Unexpected network access');};
      const c=configSchema.parse({...${JSON.stringify(base)},extensionApps:{'test-app':{template:'test-provider',spec:{resource:'desired'}}}});
      await Bun.write('manifest.json',JSON.stringify(c));
      const before=await Bun.file('manifest.json').text();
      for(const args of [
        ['validate'],['plan'],['deploy'],['deploy','--apply'],['apply','--apply'],['get']
      ])await fileCommand([args[0],'-f','app.yaml',...args.slice(1)]);
      if(calls.length!==5||JSON.stringify(calls.map(x=>x.apply))!==JSON.stringify([false,false,true,true,false]))throw Error('Apply gate failed');
      for(const args of [['delete','--apply'],['rollback','--apply'],['get','--apply'],['deploy','--connection','vm.json'],['deploy','--port','2222'],['deploy','--image','example:1']]){
        let refused=false;try{await fileCommand([args[0],'-f','app.yaml',...args.slice(1)]);}catch{refused=true;}
        if(!refused)throw Error('Unsupported operation accepted: '+args);
      }
      if(calls.length!==5)throw Error('Rejected command dispatched to provider');
      await deployAll(c);
      let refused=false;try{await deployExtension(c,'test-app','unused');}catch{refused=true;}
      if(!refused)throw Error('Targeted VM deploy accepted');
      for(const resource of ['app','extension'])for(const verb of ['deploy','reload','logs','delete','create','update']){
        const request={verb,resource,name:'test-app',options:{},apply:true,file:'manifest.json'};
        let refused=false;try{await (resource==='app'?appResource:extensionResource)(request,c,'unused',before);}catch{refused=true;}
        if(!refused)throw Error('VM lifecycle accepted: '+resource+' '+verb);
      }
      const doc=Bun.YAML.parse(await Bun.file('app.yaml').text());
      refused=false;try{parseDocument({...doc,requires:[{kind:'App',name:'api'}]});}catch{refused=true;}
      if(!refused)throw Error('Provider document validation skipped');
      if(await Bun.file('manifest.json').text()!==before)throw Error('VM state changed');
      console.log('external runtime isolated');
    `], {cwd: dir, stdout: 'pipe', stderr: 'pipe'});
    const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(out).toContain('external runtime isolated');
  } finally { await rm(dir, {recursive: true, force: true}); }
});
