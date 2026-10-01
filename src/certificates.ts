import { mkdir, chmod, rename, rm } from "node:fs/promises";
import {
  createPrivateKey,
  createPublicKey,
  X509Certificate,
} from "node:crypto";
import { join } from "node:path";
import type { Domain } from "./config";
import { Cloudflare } from "./cloudflare";
import { run } from "./process";
export function validPair(
  cert: string,
  key: string,
  hosts: string[],
  now = Date.now(),
): boolean {
  try {
    const x = new X509Certificate(cert);
    return (
      Date.parse(x.validFrom) <= now &&
      Date.parse(x.validTo) > now + 30 * 86400000 &&
      hosts.every((h) => !!x.checkHost(h)) &&
      x.publicKey.export({ type: "spki", format: "pem" }) ===
        createPublicKey(createPrivateKey(key)).export({
          type: "spki",
          format: "pem",
        })
    );
  } catch {
    return false;
  }
}
export async function certificate(cf: Cloudflare, d: Domain, state: string) {
  const dir = join(state, "certificates", d.name);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const file = join(dir, "pair.json");
  if (await Bun.file(file).exists()) {
    const pair = await Bun.file(file).json();
    if (validPair(pair.cert, pair.key, d.hosts))
      return pair as { cert: string; key: string };
  }
  const tmp = join(dir, `pending-${crypto.randomUUID()}`);
  await mkdir(tmp, { mode: 0o700 });
  try {
    await run([
      "openssl",
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(tmp, "key.pem"),
      "-out",
      join(tmp, "request.pem"),
      "-subj",
      `/CN=${d.hosts[0]}`,
    ]);
    await chmod(join(tmp, "key.pem"), 0o600);
    const result = await cf.call<{ certificate: string; id: string }>(
      "POST",
      "/certificates",
      {
        csr: await Bun.file(join(tmp, "request.pem")).text(),
        hostnames: d.hosts,
        request_type: "origin-rsa",
        requested_validity: 365,
      },
    );
    const pair = {
      cert: result.certificate,
      key: await Bun.file(join(tmp, "key.pem")).text(),
    };
    if (!validPair(pair.cert, pair.key, d.hosts))
      throw new Error(
        "Issued certificate failed key/hostname/expiry validation",
      );
    await Bun.write(
      join(tmp, "pair.json"),
      JSON.stringify({ ...pair, id: result.id }),
      { mode: 0o600 },
    );
    await rename(join(tmp, "pair.json"), file);
    return pair;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
