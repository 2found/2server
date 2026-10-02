import { existsSync,readFileSync,readdirSync } from 'node:fs';
import { join } from 'node:path';

// Leaf reader: native hooks can read their declaration without importing the
// registry (which imports those hooks). No filesystem path comes from a manifest.
const catalog = new Map<string, Record<string, any>>();
export function catalogDefinition(name: string): Record<string, any> {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(name)) throw new Error('Invalid definition name');
  if (!catalog.has(name)) {
    const value = Bun.YAML.parse(readFileSync(new URL(`./templates/${name}/extension.yaml`, import.meta.url), 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid definition ${name}`);
    catalog.set(name, value as Record<string, any>);
  }
  return catalog.get(name)!;
}
export function definitionPaths(directory: string): string[] {
  return readdirSync(directory, {withFileTypes:true}).flatMap(entry => {
    const file = join(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith('.yaml')) return [file];
    const nested = join(file, 'extension.yaml');
    return entry.isDirectory() && existsSync(nested) ? [nested] : [];
  }).sort();
}
