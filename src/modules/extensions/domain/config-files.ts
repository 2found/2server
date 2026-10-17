import { z } from "zod";
import { path } from "../../../shared/domain/schema";

// A template App can mount operator-authored config files in the workload's
// own format (like a Kubernetes ConfigMap), instead of 2server mirroring every
// upstream option in the template schema. The source file holds no secrets:
// `${NAME}` is replaced at deploy time by the App's declared VM secret NAME,
// and `$${` writes a literal `${`. There is no other expansion.
export const MAX_CONFIG_FILE_BYTES = 256 * 1024;
const REF = /\$\$\{|\$\{([^}]*)\}/g;
const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;

export const configFileSourceSchema = z.object({source: z.string().min(1).max(1024), mountPath: path}).strict();
export const configFileSchema = z.object({
  mountPath: path,
  content: z.string().refine(v => Buffer.byteLength(v) <= MAX_CONFIG_FILE_BYTES && !v.includes("\0"), "Config files are text up to 256 KiB"),
}).strict();
export type ConfigFile = z.infer<typeof configFileSchema>;

export const uniqueMountPaths = (files: {mountPath: string}[]) => new Set(files.map(f => f.mountPath)).size === files.length;

// Secret names a file references, in order of first use. Malformed `${...}`
// fails here so a typo never reaches the workload as literal text.
export function configFileRefs(content: string): string[] {
  const refs = new Set<string>();
  for (const m of content.matchAll(REF)) {
    if (m[0] === "$${") continue;
    if (!ENV_KEY.test(m[1])) throw new Error(`Invalid config file reference \${${m[1].slice(0, 64)}}; use \${UPPER_CASE_SECRET} or $\${ for a literal`);
    refs.add(m[1]);
  }
  return [...refs];
}

export function renderConfigFile(content: string, value: (key: string) => string): string {
  configFileRefs(content);
  return content.replace(REF, (m, key: string | undefined) => m === "$${" ? "${" : value(key!));
}
