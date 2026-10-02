import { rename,rm } from "node:fs/promises";
import type { Config } from "../application/config";
export async function saveManifest(file: string, original: string, c: Config) {
  if ((await Bun.file(file).text()) !== original)
    throw new Error(
      "Manifest changed while the operation ran; remote operation succeeded, reconcile local changes before retrying",
    );
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await Bun.write(temp, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}
