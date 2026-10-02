import type { Config } from "../config";
import type { Extension } from "./types";
import { postgresExtension } from "./postgres";
import { redisExtension } from "./redis";
import { natsExtension } from "./nats";
import { monitoringExtension } from "./monitoring";
import { imageProxyExtension } from "./image-proxy";
import { serviceExtension, serviceSpecOf } from "./service";

// The single list of manifest extensions. Order matters: this is the deploy
// order — stateful data services first, then observers, then derived services.
// See docs/extensions.md for the declaration contract.
export const extensionRegistry: Extension[] = [
  postgresExtension,
  redisExtension,
  natsExtension,
  monitoringExtension,
  imageProxyExtension,
];

const byName: Record<string, Extension> = {};
const byCliName: Record<string, Extension> = {};
for (const ext of extensionRegistry) {
  if (byName[ext.name]) throw new Error(`Duplicate extension name ${ext.name}`);
  const cliName = ext.cliName ?? ext.name;
  if (byCliName[cliName]) throw new Error(`Duplicate extension name ${cliName}`);
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(cliName))
    throw new Error(`Invalid extension name ${cliName}`);
  byName[ext.name] = ext;
  byCliName[cliName] = ext;
}

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
  const ext = byName[name];
  if (ext) return ext;
  const spec = serviceSpecOf(c, name);
  return spec ? serviceExtension(name, spec) : undefined;
}
// Merge every enabled extension's published domains into the manifest. Owned
// names are replaced wholesale so disabled extensions shed stale declarations.
export function withExtensionDomains(c: Config): Config {
  const owned = extensionRegistry
    .filter((e) => e.domains)
    .flatMap((e) => e.domains!(c));
  if (!owned.length) return c;
  const names = new Set(owned.map((d) => d.name));
  return {
    ...c,
    domains: [...c.domains.filter((d) => !names.has(d.name)), ...owned],
  };
}
