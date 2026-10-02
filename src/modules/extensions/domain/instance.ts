import type { Config } from "../../config/application/config";
import type { Extension } from "./types";
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
