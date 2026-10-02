import { lstat,readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { statePath } from "../domain/state";
import { envSchema } from "../domain/secrets";
export async function envFile(path?: string) {
  if (!path) return {};
  const parsed = envSchema.safeParse(parseEnv(await Bun.file(path).text()));
  if (!parsed.success) throw new Error('Invalid secret file; use uppercase environment keys and single-line values (maximum 65536 characters). Values hidden.');
  return parsed.data; // Never execute or interpolate dotenv input.
}
export async function captureState(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(prefix: string) {
    const full = join(dir, prefix);
    let info;
    try { info = await lstat(full); } catch (e: any) { if (e.code === 'ENOENT') return; throw e; }
    if (info.isSymbolicLink()) throw new Error('Symlinks are not supported in portable operator state');
    if (info.isDirectory()) {
      for (const entry of await readdir(full)) await walk(prefix ? `${prefix}/${entry}` : entry);
    } else if (statePath.safeParse(prefix).success) {
      if (info.size > 1024 * 1024) throw new Error('Operator state file exceeds 1 MiB');
      result[prefix] = await Bun.file(full).text();
    }
  }
  await walk('certificates');
  await walk('compose');
  await walk('deployments');
  await walk('monitoring-credentials.json');
  await walk('monitoring');
  return result;
}
