import { vmSecret } from '../../../shared/infrastructure/vm-secrets';
import type { Config } from '../../config/application/config';
import { instanceConfig,type TemplateApp } from "../domain/instance";
import type { Extension } from '../domain/types';

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
    summary:ext.summary?(config,state)=>ext.summary!(context(config),state):undefined,
    diagnostics:ext.diagnostics?config=>ext.diagnostics!(context(config)):undefined,
    backupStoragePermissions:ext.backupStoragePermissions?config=>ext.backupStoragePermissions!(context(config)):undefined,
    deploy:ext.deploy?config=>ext.deploy!(context(config)):undefined,
    remove:ext.remove?config=>ext.remove!(context(config)):undefined};
  if(ext.stateful)bound.stateful=Object.fromEntries(Object.entries(ext.stateful).map(([key,fn])=>[key,(config:Config,...args:unknown[])=>(fn as Function)(context(config),...args)])) as unknown as Extension['stateful'];
  if(ext.sourceDeployment)bound.sourceDeployment={
    validate: input=>ext.sourceDeployment!.validate(input),
    plan: input=>ext.sourceDeployment!.plan({...input,config:context(input.config)}),
    apply: input=>ext.sourceDeployment!.apply({...input,config:context(input.config)}),
    verify: ext.sourceDeployment.verify?input=>ext.sourceDeployment!.verify!({...input,config:context(input.config)}):undefined,
  };
  return bound;
}
