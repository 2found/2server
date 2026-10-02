import { z } from "zod";
import type { Config } from "../../config/application/config";
export const secretValue = z.string().max(65536).refine(v => !/[\r\n\0]/.test(v));
export const envSchema = z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), secretValue);
// Only manifest secret references are portable. Never ship PATH, cloud login
// sessions, SSH private keys, or arbitrary variables from the operator shell.
export function secretKeys(c: unknown): string[] {
  const keys = new Set<string>();
  function visit(v: unknown) {
    if (!v || typeof v !== 'object') return;
    for (const [key, value] of Object.entries(v)) {
      if (key.endsWith('Env') && typeof value === 'string') keys.add(value);
      if (key === 'provider' && value === 'env') keys.add((v as {key: string}).key);
      if (typeof value === 'object') visit(value);
    }
  }
  visit(c);
  for (const key of keys) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) ||
        /^(PATH|HOME|SHELL|ENV|BASH_ENV|IFS|CDPATH|TMPDIR|NODE_OPTIONS|NODE_PATH|BUN_OPTIONS|BUN_INSPECT|LD_.*|DYLD_.*|GIT_.*|SSH_.*|GCLOUD_.*|CLOUDSDK_.*|AWS_.*|GOOGLE_.*)$/.test(key))
      throw new Error('Secret references cannot override process or cloud credential configuration');
  }
  return [...keys].sort();
}
export function selectSecrets(c: Config, source: Record<string, string | undefined>) {
  const result: Record<string, string> = {};
  for (const key of secretKeys(c)) {
    const value = source[key];
    if (value !== undefined) {
      if (!secretValue.safeParse(value).success) throw new Error(`Invalid single-line secret: ${key}`);
      result[key] = value;
    }
  }
  return result;
}
