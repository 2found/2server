import type { z } from "zod";
import type { Config } from "../../config/application/config";
import type { ExtensionSpecs } from "../domain/specs.generated";
import type { Extension } from "../domain/types";
import { serviceExtension,serviceSpecOf } from "../infrastructure/service";
import { imageProxyHooks } from "../infrastructure/templates/image-proxy/hooks";
import { monitoringHooks } from "../infrastructure/templates/monitoring/hooks";
import { natsHooks } from "../infrastructure/templates/nats/hooks";
import { postgresHooks } from "../infrastructure/templates/postgres/hooks";
import { redisHooks } from "../infrastructure/templates/redis/hooks";
import { sootHooks } from "../infrastructure/templates/soot/hooks";
import { emailRoutingRuntime } from '../infrastructure/templates/email-routing/source';
import { workerRuntime } from '../infrastructure/templates/url-shortener/source';
import { bindInstance } from './instance';

import { fileURLToPath } from "node:url";
import { loadDefinitions } from "../infrastructure/definition";

export const extensionRegistry: Extension[] = loadDefinitions(
  fileURLToPath(new URL('../infrastructure/templates/', import.meta.url)),
  { postgres: postgresHooks, redis: redisHooks, nats: natsHooks,
    monitoring: monitoringHooks, 'image-proxy': imageProxyHooks, soot: sootHooks },
  { worker: workerRuntime, 'email-routing': emailRoutingRuntime },
);
// Preserve builtin inference for their native hooks while runtime registration
// and config validation come from the same discovered definitions.
export const extensionSchemas = Object.fromEntries(extensionRegistry.map(e => [e.name, e.schema])) as Record<string, z.ZodType> & {
  [K in keyof ExtensionSpecs]: undefined extends ExtensionSpecs[K]
    ? z.ZodOptional<z.ZodType<Exclude<ExtensionSpecs[K], undefined>>>
    : z.ZodType<ExtensionSpecs[K]>;
};

const byName: Record<string, Extension> = Object.create(null);
const byCliName: Record<string, Extension> = Object.create(null);
for (const ext of extensionRegistry) {
  if (byName[ext.name]) throw new Error(`Duplicate extension name ${ext.name}`);
  const cliName = ext.cliName ?? ext.name;
  if (byCliName[cliName]) throw new Error(`Duplicate extension name ${cliName}`);
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(cliName))
    throw new Error(`Invalid extension name ${cliName}`);
  byName[ext.name] = ext;
  byCliName[cliName] = ext;
}

// Compatibility names for engine callers; each is the compiled YAML definition.
export const postgresExtension = byName.postgres;
export const redisExtension = byName.redis;
export const natsExtension = byName.nats;

export function extensionByName(name: string): Extension | undefined {
  return byName[name];
}
// Source documents and CLI identify extensions by cliName ("image-proxy");
// the manifest key is Extension.name ("imageProxy").
export function extensionKey(nameOrCliName: string): string | undefined {
  return (byCliName[nameOrCliName] ?? byName[nameOrCliName])?.name;
}
export function extensionForCliName(cliName: string): Extension | undefined {
  return byCliName[cliName];
}
export function extensionCliNames(): string {
  const names = extensionRegistry.map((e) => e.cliName ?? e.name);
  return names.length > 1
    ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`
    : (names[0] ?? "");
}
export function enabledExtensions(c: Config): Extension[] {
  return [
    ...extensionRegistry.filter(
      (e) => (c.extensions as Record<string, unknown>)[e.name],
    ),
    ...serviceInstances(c),
    ...Object.entries(c.extensionApps??{}).filter(([,app])=>byCliName[app.template]).map(([name,app])=>bindInstance(c,name,byCliName[app.template],app)),
  ];
}
// Generic service extensions live in config.extensions.services[name]; they
// resolve to a per-instance Extension view so engines and CLI dispatch treat
// them identically to declared extensions.
export function serviceInstances(c: Config): Extension[] {
  return Object.entries(c.extensions.services ?? {}).map(([name, spec]) =>
    serviceExtension(name, spec),
  );
}
// Registered extension first, then a configured service instance.
export function extensionFor(c: Config, name: string): Extension | undefined {
  const instance=c.extensionApps?.[name];
  if(instance)return bindInstance(c,name,byCliName[instance.template],instance);
  const ext = byName[name];
  if (ext) return ext;
  const spec = serviceSpecOf(c, name);
  return spec ? serviceExtension(name, spec) : undefined;
}
// Merge every enabled extension's published domains into the manifest. Owned
// names are replaced wholesale so disabled extensions shed stale declarations.
export function withExtensionDomains(c: Config): Config {
  const owned = enabledExtensions(c)
    .filter((e) => e.domains)
    .flatMap((e) => e.domains!(c));
  if (!owned.length) return c;
  const names = new Set(owned.map((d) => d.name));
  return {
    ...c,
    domains: [...c.domains.filter((d) => !names.has(d.name)), ...owned],
  };
}
