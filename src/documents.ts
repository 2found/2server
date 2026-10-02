import {z} from 'zod';
import {appSchema, domainSchema, webhookSchema} from './config';
import {extensionForCliName, extensionCliNames} from './extensions';
import {serviceSchema} from './extensions/service';
export const imageReference = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:\-]*(?::[a-zA-Z0-9_][a-zA-Z0-9_.-]*|@sha256:[a-f0-9]{64})$/);
const metadata = z.object({name:z.string().regex(/^[a-z][a-z0-9-]{0,47}$/)}).strict();
const base = {apiVersion:z.literal('2server.app/v1'),metadata,requires:z.array(z.object({kind:z.enum(['App','Extension']),name:metadata.shape.name}).strict()).default([])};
// Rebuild shape to preserve defaults and strict validation while accepting tags.
const spec = z.object({...appSchema.shape,name:z.never().optional(),image:imageReference}).strict();
export const documentSchema = z.discriminatedUnion('kind',[
 z.object({...base,kind:z.literal('App'),spec, runtimeFile:z.string().min(1).optional(),domains:z.array(domainSchema).default([])}).strict(),
 z.object({...base,kind:z.literal('Extension'),spec:z.record(z.string(),z.unknown()),webhooks:z.array(webhookSchema).default([]),secrets:z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/),z.object({provider:z.literal('vm'),key:z.string().regex(/^[A-Z_][A-Z0-9_]*$/)}).strict()).default({})}).strict(),
 z.object({...base,kind:z.literal('Service'),spec:serviceSchema}).strict(),
 z.object({...base,kind:z.literal('Domain'),spec:z.record(z.string(),z.unknown())}).strict(),
]);
export type Document = z.infer<typeof documentSchema>;
export function parseData(text:string):unknown { return Bun.YAML.parse(text); }
export function parseDocument(raw:unknown):Document {
 const d=documentSchema.parse(raw);
 if(d.kind==='App') {
  if(Object.values(d.spec.secrets).some(s=>s.provider!=='vm'))throw new Error('Source App files use provider: vm secret references; import values with secret set --app NAME');
  appSchema.parse({...d.spec,name:d.metadata.name,image:'example/app@sha256:'+'a'.repeat(64)});
  if (!!d.spec.compose !== !!d.runtimeFile) throw new Error('Compose apps require explicit runtimeFile; native apps must omit it');
  if(d.spec.compose?.sourceFiles || d.spec.compose?.runtime || d.spec.compose?.generated !== undefined || d.spec.compose?.volumeBindings) throw new Error('Runtime control fields belong to VM state, not source documents');
  if(d.runtimeFile && (d.spec.capabilities.length || d.spec.healthCheck || d.spec.volumeMounts.length || Object.keys(d.spec.instanceEnv).length || Object.keys(d.spec.labels).length))throw new Error('Use one App file without compose/runtimeFile for capabilities, healthCheck, volumeMounts, instanceEnv and labels');
 }
 if(d.kind==='Extension') {
  const ext=extensionForCliName(d.metadata.name);
  if(!ext) throw new Error(`Extension name must be ${extensionCliNames()} (one instance per VM)`);
  if(!ext.acceptsWebhooks&&d.webhooks.length)throw new Error('webhooks belong to the monitoring file');
  d.spec=ext.schema.parse(d.spec) as Record<string,unknown>;
 }
 if(d.kind==='Service'&&extensionForCliName(d.metadata.name))throw new Error(`Service name ${d.metadata.name} conflicts with a declared extension`);
 if(d.kind==='Domain') domainSchema.parse({...d.spec,name:d.metadata.name});
 return d;
}
