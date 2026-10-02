import {
createPrivateKey,
createPublicKey,
X509Certificate,
} from "node:crypto";
import { chmod,mkdir,rename,rm } from "node:fs/promises";
import { join } from "node:path";
import { run } from "../../../shared/infrastructure/process";
import type { Domain } from "../domain/schema";
import { Cloudflare } from "./cloudflare";
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
      hosts.every((h) =>
        h.startsWith("*.")
          ? x.subjectAltName?.split(", ").includes(`DNS:${h}`)
          : !!x.checkHost(h),
      ) &&
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
export function certificateHosts(d: Domain): string[] {
  return d.certificate?.scope === "zone"
    ? [...new Set([d.zone, `*.${d.zone}`, ...d.hosts])]
    : d.hosts;
}
export async function certificate(cf: Cloudflare, d: Domain, state: string) {
  const hosts = certificateHosts(d);
  const validity = d.certificate?.validityDays ?? 365;
  const dir = join(state, "certificates", d.name);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const file = join(dir, "pair.json");
  if (await Bun.file(file).exists()) {
    await chmod(file, 0o600);
    const pair = await Bun.file(file).json();
    if (
      (pair.requestedValidity ?? 365) >= validity &&
      validPair(pair.cert, pair.key, hosts)
    )
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
        hostnames: hosts,
        request_type: "origin-rsa",
        requested_validity: validity,
      },
    );
    const pair = {
      cert: result.certificate,
      key: await Bun.file(join(tmp, "key.pem")).text(),
    };
    if (!validPair(pair.cert, pair.key, hosts))
      throw new Error(
        "Issued certificate failed key/hostname/expiry validation",
      );
    await Bun.write(
      join(tmp, "pair.json"),
      JSON.stringify({ ...pair, id: result.id, requestedValidity: validity }),
      { mode: 0o600 },
    );
    await chmod(join(tmp, "pair.json"), 0o600);
    await rename(join(tmp, "pair.json"), file);
    return pair;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
