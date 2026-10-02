import {parseDocument} from './documents';
import {extensionForCliName, extensionRegistry} from './extensions';
import {serviceSchema} from './extensions/service';
import {secretKeys} from './control';
import {configSchema} from './config';
export function serverTemplate(name:string) {
 const template={version:1,name,ssh:{kind:'ssh',host:'203.0.113.10',user:'ubuntu'},edge:{mode:'managed'}};
 configSchema.parse(template);return template;
}
export function appTemplate(name:string) {
 const template={apiVersion:'2server.app/v1',kind:'App',metadata:{name},
  spec:{image:`ghcr.io/example/${name}:latest`,port:8080,healthPath:'/healthz',memoryMb:256,cpus:0.5},
  domains:[{name,zone:'example.com',hosts:[`${name}.example.com`],upstream:{kind:'import',name:`up_two_${name}`}}]};
 parseDocument(template);return template;
}
export function extensionTemplate(name:string) {
 const ext=extensionForCliName(name);
 if(!ext?.template)throw new Error(`Unknown extension template; use ${extensionRegistry.filter(e=>e.template).map(e=>e.cliName??e.name).join(', ')}`);
 const spec=ext.schema.parse(ext.template) as Record<string,unknown>;
 const refs=Object.fromEntries(secretKeys(spec).map(key=>[key,{provider:'vm',key}]));
 return parseDocument({apiVersion:'2server.app/v1',kind:'Extension',metadata:{name:ext.cliName??ext.name},spec,secrets:refs});
}
export function serviceTemplate(name:string) {
 const spec=serviceSchema.parse({image:'ghcr.io/example/service:latest'});
 return parseDocument({apiVersion:'2server.app/v1',kind:'Service',metadata:{name},spec});
}

export function templateApp(name:string,template:string) {
 const ext=extensionForCliName(template);
 if(!ext?.template)throw new Error('Unknown app template');
 const source={apiVersion:'2server.app/v1',kind:'App',metadata:{name},template,spec:{...ext.template} as Record<string,unknown>,secrets:{}};
 const parsed=parseDocument(source);
 if(parsed.kind!=='Extension')throw new Error('Invalid template');
 source.spec=parsed.spec;
 source.secrets=Object.fromEntries(secretKeys([source.spec,parsed.webhooks]).map(key=>[key,{provider:'vm',key}]));
 return source;
}
