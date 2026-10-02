import type { Config } from './config';
import type { Bindings } from './schema';
import type { Extension } from './extensions/types';
import { enabledExtensions, extensionFor, extensionKey } from './extensions';
import { requiredSecret, extensionProject } from './stateful';
import { remote, quote } from './process';

export const bindingOperations = { remote };
const keyOf = (name: string,c:Config) => c.extensionApps[name]?name:extensionKey(name) ?? name;
export function extensionSpec(c: Config, ext: Extension): unknown {
  return ext.spec?.(c) ?? (c.extensions as Record<string, unknown>)[ext.name];
}
export function extensionBindings(c: Config, ext: Extension): Bindings {
  const spec = extensionSpec(c, ext);
  return spec && typeof spec === 'object' && 'bindings' in spec ? (spec.bindings as Bindings) : {};
}
function provider(c: Config, ref: Bindings[string]) {
  const ext = extensionFor(c, keyOf(ref.extension,c));
  if (!ext || !extensionSpec(c, ext)) throw new Error(`Missing binding extension ${ref.extension}`);
  const output = Object.hasOwn(ext.outputs ?? {}, ref.output) ? ext.outputs![ref.output] : undefined;
  if (!output) throw new Error(`Unknown output ${ref.extension}.${ref.output}`);
  return { ext, output };
}

// Used by config validation as well as runtime entry points. Nothing resolves
// secrets here, so plans/state/history only retain references.
export function validateBindings(c: Config) {
  for (const a of c.apps) for (const ref of Object.values(a.bindings)) provider(c, ref);
  orderedExtensions(c);
}
export function orderedExtensions(c: Config): Extension[] {
  const visiting = new Set<string>(), visited = new Set<string>(), result: Extension[] = [];
  const visit = (ext: Extension) => {
    if (visiting.has(ext.name)) throw new Error(`Extension binding cycle at ${ext.name}`);
    if (visited.has(ext.name)) return;
    visiting.add(ext.name);
    for (const ref of Object.values(extensionBindings(c, ext))) visit(provider(c, ref).ext);
    visiting.delete(ext.name); visited.add(ext.name); result.push(ext);
  };
  for (const ext of enabledExtensions(c)) visit(ext);
  return result;
}
export function assertExtensionUnused(c: Config, name: string) {
  const target = keyOf(name,c);
  const consumers = [
    ...c.apps.map(a => ({ name: `App/${a.name}`, bindings: a.bindings })),
    ...enabledExtensions(c).filter(e => e.name !== target).map(e => ({ name: `Extension/${e.cliName ?? e.name}`, bindings: extensionBindings(c, e) })),
  ].filter(a => Object.values(a.bindings).some(r => keyOf(r.extension,c) === target));
  if (consumers.length) throw new Error(`Extension ${name} is used by ${consumers.map(a => a.name).join(', ')}; remove its bindings first`);
}
export function resolveBindings(c: Config, bindings: Bindings): Record<string, string> {
  return Object.fromEntries(Object.entries(bindings).map(([key, ref]) => {
    const { ext, output } = provider(c, ref);
    const spec = extensionSpec(c, ext) as Record<string, unknown>;
    const field = (name: string) => {
      const value = spec[name];
      if (typeof value !== 'string' || !value) throw new Error(`Invalid output field ${ext.name}.${name}`);
      return value;
    };
    if (output.type === 'secret') return [key, requiredSecret(field(output.envField),ext.context?.(c)??c)];
    const host = extensionProject(ext.context?.(c)??c, output.container ?? (ext.context?.(c).instance?.template??ext.name));
    let credentials = '', path = '';
    if (output.type === 'connection') {
      const user = encodeURIComponent(output.usernameField ? field(output.usernameField) : output.username ?? '');
      credentials = `${user}:${encodeURIComponent(requiredSecret(field(output.passwordEnvField),ext.context?.(c)??c))}@`;
      if (output.databaseField) path = `/${encodeURIComponent(field(output.databaseField))}`;
    }
    return [key, `${output.protocol}://${credentials}${host}:${output.port}${path}`];
  }));
}

// Do not silently deploy dependencies from an app rollout. Require their
// declared health checks to have passed; fail before hooks or traffic changes.
export async function assertBindingsReady(c: Config, bindings: Bindings) {
  const containers = new Set<string>();
  for (const ref of Object.values(bindings)) {
    const { ext, output } = provider(c, ref);
    containers.add(output.type !== 'secret' && output.container
      ? extensionProject(ext.context?.(c)??c, output.container) : ext.logTarget?.(c) ?? extensionProject(c, ext.name));
  }
  if (!containers.size) return;
  await bindingOperations.remote(c, `set -euo pipefail
${[...containers].map(container => `test "$(docker inspect -f '{{if .State.Running}}{{if .State.Health}}{{.State.Health.Status}}{{end}}{{end}}' ${quote(container)})" = healthy || { echo ${quote(`Binding dependency ${container} is not healthy; apply its extension with a health check first`)} >&2; exit 1; }`).join('\n')}`);
}
