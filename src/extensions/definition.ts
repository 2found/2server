import {instanceName} from './instance';
import {extensionProject} from '../stateful';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { name } from '../schema';
import { serviceSchema, serviceExtension } from './service';
import { outputSchema } from './outputs';
import type { Config } from '../config';
import { declaredSchema, renderDeclaration, definitionPaths } from "./catalog";
import type { Extension, ExtensionHooks } from './types';

// Definitions are shipped with the CLI, never downloaded or executed from an
// untrusted source document. A recipe uses the same strict Service vocabulary.
export const definitionSchema = z.object({
  apiVersion: z.literal('2server.app/v1'),
  kind: z.literal('ExtensionDefinition'),
  metadata: z.object({ name, key: z.string().max(48).regex(/^[a-z][a-zA-Z0-9]*$/).optional() }).strict(),
  commands: z.record(name.refine(n=>!['help','get','deploy','logs','restart','delete','rollback','scale'].includes(n),'Extension commands cannot shadow core app operations'), z.object({description:z.string(),usage:z.string().optional(),readOnly:z.boolean().optional()}).strict()).optional(),
  order: z.number().int().default(100),
  hook: name.optional(),
  schema: z.record(z.string(), z.unknown()).optional(),
  service: z.record(z.string(), z.unknown()).optional(),
  compose: z.record(z.string(), z.unknown()).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  immutable: z.array(z.string()).optional(),
  dataPathField: z.string().optional(),
  container: name.optional(),
  acceptsWebhooks: z.boolean().optional(),
  runtime: z.object({ engine: z.literal('service'), defaults: serviceSchema }).strict().optional(),
  template: z.record(z.string(), z.unknown()).optional(),
  outputs: z.record(z.string().regex(/^[a-z][a-zA-Z0-9-]{0,63}$/), outputSchema).default({}),
}).strict().refine(d => !!d.hook !== !!d.runtime, 'Choose exactly one hook or service runtime')
  .refine(d => !d.runtime || [d.schema,d.service,d.compose,d.settings,d.immutable,d.dataPathField,d.container,d.acceptsWebhooks].every(v=>v===undefined),
    'Native declaration fields require a hook; service recipes use runtime.defaults');

export function compileDefinition(raw: unknown, hooks: Record<string, ExtensionHooks>): Extension {
  const d = definitionSchema.parse(raw);
  const key = d.metadata.key ?? d.metadata.name;
  if (d.hook) {
    const hook = Object.hasOwn(hooks, d.hook) ? hooks[d.hook] : undefined;
    if (!hook) throw new Error(`Unknown extension hook ${d.hook}`);
    if (d.hook !== d.metadata.name) throw new Error("Native hooks must retain their extension name");
    const base = declaredSchema(d);
    const schema = (hook.refineSpec ? base.superRefine(hook.refineSpec) : base).optional();
    const { refineSpec, ...lifecycle } = hook;
    const ext: Extension = {
      ...lifecycle, name: key, cliName: d.metadata.name, schema,
      template: d.template, container:d.container, commands:d.commands, outputs: d.outputs, immutable: d.immutable,
      acceptsWebhooks: d.acceptsWebhooks,
      containers: c => (d.compose ? Object.keys(d.compose.services as Record<string,unknown>) : [d.container ?? key]).map(n => extensionProject(c,n)),
      logTarget: d.container ? c => extensionProject(c,d.container!) : undefined,
      dataPaths: d.dataPathField ? c => {
        const spec = (c.extensions as Record<string, unknown>)[key] as Record<string, unknown> | undefined;
        const path = spec?.[d.dataPathField!];
        return typeof path === 'string' ? [path] : [];
      } : undefined,
    };
    if (hook.stateful) ext.stateful = {
      ...hook.stateful,
      files: (c, files, service) => {
        const spec = (c.extensions as Record<string, unknown>)[key];
        Object.assign(service, renderDeclaration(d.service ?? {}, {spec, server:c, edge:c.edge}));
        return hook.stateful!.files(c, files, service);
      },
    };
    return ext;
  }
  const defaults = d.runtime!.defaults;
  // Undefined stays disabled; merging happens only for a configured instance.
  const schema = z.preprocess(v => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
    const override = v as Record<string, unknown>;
    for (const field of ['env', 'secrets']) {
      const value = override[field];
      if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) return v;
    }
    return { ...defaults, ...override,
      env: { ...defaults.env, ...override.env as Record<string, string> },
      secrets: { ...defaults.secrets, ...override.secrets as typeof defaults.secrets } };
  }, serviceSchema).optional();
  const spec = (c: Config) => serviceSchema.parse(schema.parse((c.extensions as Record<string, unknown>)[key]));
  return {
    name: key, cliName: d.metadata.name, schema,
    template: d.template ?? {}, commands:d.commands, outputs: d.outputs,
    immutable: ['dataPath'],
    dataPaths: c => (c.extensions as Record<string, unknown>)[key] && spec(c).dataPath ? [spec(c).dataPath!] : [],
    stateful: {
      files: (c, files, service) => serviceExtension(instanceName(c,key), spec(c)).stateful!.files(c, files, service),
    },
  };
}

export function loadDefinitions(directory: string, hooks: Record<string, ExtensionHooks>): Extension[] {
  const definitions = definitionPaths(directory)
    .map(file => definitionSchema.parse(Bun.YAML.parse(readFileSync(file, 'utf8'))))
    .sort((a, b) => a.order - b.order || a.metadata.name.localeCompare(b.metadata.name));
  const keys = new Set<string>();
  for (const d of definitions) {
    for (const alias of new Set([d.metadata.name, d.metadata.key ?? d.metadata.name])) {
      if (keys.has(alias) || ['services', 'webhooks', 'alertWebhookEnv', 'constructor', 'prototype', '__proto__'].includes(alias))
        throw new Error(`Duplicate or reserved extension name ${alias}`);
      keys.add(alias);
    }
  }
  return definitions.map(d => compileDefinition(d, hooks));
}
