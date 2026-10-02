import { z } from "zod";
export function declaredSchema(definition: { schema?: Record<string, unknown> }): z.ZodType {
  if (!definition.schema) throw new Error('Native definitions require a JSON Schema');
  return z.fromJSONSchema(definition.schema);
}

// Structured references only, never evaluated expressions. A value may be
// copied, or wrapped in a literal prefix/suffix for a container name/volume.
export function renderDeclaration(value: unknown, context: Record<string, unknown>): any {
  if (Array.isArray(value)) return value.map(v => renderDeclaration(v, context));
  if (!value || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  if (Object.hasOwn(object, '$value')) {
    if (typeof object.$value !== 'string' || !/^(spec|server|edge)(\.[a-zA-Z][a-zA-Z0-9]*)+$/.test(object.$value)
      || Object.keys(object).some(k => !['$value', 'prefix', 'suffix'].includes(k))
      || [object.prefix, object.suffix].some(v => v !== undefined && typeof v !== 'string'))
      throw new Error('Invalid declaration reference');
    let result: unknown = context;
    for (const part of object.$value.split('.')) {
      if (!result || typeof result !== 'object' || !Object.hasOwn(result, part)) throw new Error(`Missing declaration value ${object.$value}`);
      result = (result as Record<string, unknown>)[part];
    }
    if (object.prefix !== undefined || object.suffix !== undefined) {
      if (typeof result !== 'string' && typeof result !== 'number') throw new Error('Only scalar values support prefix/suffix');
      return `${object.prefix ?? ''}${result}${object.suffix ?? ''}`;
    }
    return structuredClone(result);
  }
  return Object.fromEntries(Object.entries(object).map(([k,v]) => [k,renderDeclaration(v,context)]));
}
