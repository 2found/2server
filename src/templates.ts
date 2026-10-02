import {parseDocument} from './documents';
import {extensionForCliName, extensionRegistry} from './extensions';
import {serviceSchema} from './extensions/service';
import {secretKeys} from './control';
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
