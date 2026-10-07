import { z } from 'zod';
import { extensionRegistry } from '../../extensions/application/registry';
import type { Extension } from '../../extensions/domain/types';
import { statePath } from '../domain/state';

export function portableStatePolicy(extensions: readonly Extension[] = extensionRegistry) {
  const contributions = extensions.flatMap(ext => ext.controlState ? [ext.controlState] : []);
  const rootSchema = z.string().regex(/^[a-z0-9][a-z0-9._/-]{0,255}$/)
    .refine(root => root.split('/').every(segment => segment !== '.' && segment !== '..' && segment !== '')
      && !['lock','operation.lock','backup-storage','terraform'].includes(root.split('/')[0]));
  for (const contribution of contributions)
    for (const root of contribution.roots) rootSchema.parse(root);
  const roots = [...new Set(['certificates','compose','deployments',...contributions.flatMap(c => [...c.roots])])];
  const schema = z.string().refine(value => rootSchema.safeParse(value).success &&
    (statePath.safeParse(value).success || contributions.some(c =>
      c.roots.some(root => value === root || value.startsWith(`${root}/`)) && c.schema.safeParse(value).success)));
  return {roots,schema};
}
