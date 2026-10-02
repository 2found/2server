import { appSchema } from '../../apps/domain/schema';
import { domainSchema } from '../../domains/domain/schema';
import { extensionCliNames,extensionForCliName } from '../../extensions/application/registry';
import { documentSchema,type Document } from "../domain/document";
export function parseDocument(raw:unknown):Document {
 if(raw&&typeof raw==='object'&&!Array.isArray(raw)&&(raw as any).kind==='App'&&(raw as any).template)raw={...raw,kind:'Extension'};
 const d=documentSchema.parse(raw);
 if(d.kind==='App') {
  if(Object.values(d.spec.secrets).some(s=>s.provider!=='vm'))throw new Error('Source App files use provider: vm secret references; import values with secret set --app NAME');
  appSchema.parse({...d.spec,name:d.metadata.name,image:'example/app@sha256:'+'a'.repeat(64)});
  if (!!d.spec.compose !== !!d.runtimeFile) throw new Error('Compose apps require explicit runtimeFile; native apps must omit it');
  if(d.spec.compose?.sourceFiles || d.spec.compose?.runtime || d.spec.compose?.generated !== undefined || d.spec.compose?.volumeBindings) throw new Error('Runtime control fields belong to VM state, not source documents');
  if(d.runtimeFile && (d.spec.capabilities.length || d.spec.healthCheck || d.spec.volumeMounts.length || Object.keys(d.spec.instanceEnv).length || Object.keys(d.spec.labels).length))throw new Error('Use one App file without compose/runtimeFile for capabilities, healthCheck, volumeMounts, instanceEnv and labels');
 }
 if(d.kind==='Extension') {
  const ext=extensionForCliName(d.template??d.metadata.name);
  if(!ext) throw new Error(`Extension name must be ${extensionCliNames()} (use template with a named App)`);
  if(!ext.acceptsWebhooks&&d.webhooks.length)throw new Error('webhooks belong to the monitoring file');
  if(d.template && !('dataPath' in d.spec)) {
    const defaults=ext.schema.parse(d.spec) as Record<string,unknown>;
    if(defaults.dataPath)d.spec.dataPath=`/opt/2server/data/${d.metadata.name}`;
  }
  d.spec=ext.schema.parse(d.spec) as Record<string,unknown>;
 }
 if(d.kind==='Service'&&extensionForCliName(d.metadata.name))throw new Error(`Service name ${d.metadata.name} conflicts with a declared extension`);
 if(d.kind==='Domain') domainSchema.parse({...d.spec,name:d.metadata.name});
 return d;
}
