import type { Config } from '../config';
import type { Extension } from './types';
import { vmSecret } from '../vm-secrets';

export type TemplateApp = {template:string; spec:Record<string,unknown>; secrets:Record<string,{provider:'vm';key:string}>; webhooks:Config['extensions']['webhooks']};
// Runtime-only context. Never serialized into the server schema.
export type InstanceContext = {name:string; template:string};
export function instanceConfig(c:Config,name:string,ext:Extension,app:TemplateApp):Config {
  return {...c,instance:{name,template:ext.name},
    extensions:{...c.extensions,[ext.name]:app.spec,...(ext.acceptsWebhooks?{webhooks:app.webhooks,alertWebhookEnv:undefined}:{})}};
}
export function instanceName(c:Config,legacy:string):string {
  const i=c.instance;
  if(!i)return legacy;
  return legacy===i.template?i.name:`${i.name}-${legacy}`;
}
export function instanceRoot(c:Config,legacy:string):string {
  return c.instance?`/opt/2server/extensions/${c.instance.name}`:legacy;
}
export function backupRoot(c:Config):string {return c.instance?`/opt/2server/backups/${c.instance.name}`:'/opt/2server/backups';}
export function instanceSecret(c:Config,key:string):string|undefined {
  if(!c.instance)return process.env[key];
  const app=c.extensionApps[c.instance.name];
  const ref=app?.secrets[key];
  return ref?vmSecret(c.instance.name,ref.key):undefined;
}
export function bindInstance(c:Config,name:string,ext:Extension,app:TemplateApp):Extension {
  const context=(config:Config)=>instanceConfig(config,name,ext,app);
  const bound:Extension={...ext,name,cliName:name,spec:()=>app.spec,context,
    containers:ext.containers?config=>ext.containers!(context(config)):undefined,
    dataPaths:ext.dataPaths?config=>ext.dataPaths!(context(config)):undefined,
    logTarget:config=>ext.logTarget?.(context(config))??`two-${config.name}-${name}`,
    domains:ext.domains?config=>ext.domains!(context(config)):undefined,
    auth:ext.auth?(config,state,create)=>ext.auth!(context(config),state,create):undefined,
    deploy:ext.deploy?config=>ext.deploy!(context(config)):undefined,
    remove:ext.remove?config=>ext.remove!(context(config)):undefined};
  if(ext.stateful)bound.stateful=Object.fromEntries(Object.entries(ext.stateful).map(([key,fn])=>[key,(config:Config,...args:unknown[])=>(fn as Function)(context(config),...args)])) as unknown as Extension['stateful'];
  return bound;
}
