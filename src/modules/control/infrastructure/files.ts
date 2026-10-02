import { chmod,mkdir,rename,rm } from "node:fs/promises";
import { basename,dirname,join,resolve } from "node:path";
import type { Config } from "../../config/application/config";
export async function privateWrite(file: string, text: string) {
  // A stateless backup/export can create .2server without a prior connect.
  for (let dir = dirname(resolve(file)); dir !== dirname(dir); dir = dirname(dir)) {
    if (basename(dir) !== '.2server') continue;
    await mkdir(dir, {recursive: true, mode: 0o700});
    await chmod(dir, 0o700);
    const ignore = join(dir, '.gitignore');
    if (resolve(file) !== ignore) {
      const prior = await Bun.file(ignore).exists() ? await Bun.file(ignore).text() : '';
      if (prior.trimEnd().split('\n').at(-1) !== '*') await Bun.write(ignore, prior + '\n*\n', {mode: 0o600});
    }
    break;
  }
  await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await Bun.write(temp, text, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, file);
  } finally { await rm(temp, {force: true}); }
}
export async function findConnection(start = process.cwd()): Promise<string | undefined> {
  let dir = resolve(start);
  for (;;) {
    for (const name of ['connection.yaml','connection.json']) {
      const file=join(dir,'.2server',name);
      if(await Bun.file(file).exists()) return file;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}
export async function saveConnection(ssh: Config['ssh'], dir = join(process.cwd(), '.2server')) {
  await mkdir(dir, {recursive: true, mode: 0o700});
  await chmod(dir, 0o700);
  // Ignore the whole operator directory, including encrypted backups and this file.
  await privateWrite(join(dir, '.gitignore'), '*\n');
  await privateWrite(join(dir, 'connection.yaml'), Bun.YAML.stringify(ssh,null,2) + '\n');
}
