import { resolve4 } from "node:dns/promises";
import { isIP } from "node:net";
import type { Config } from "./config";
import { run } from "./process";
export async function resolveOrigin(c: Config) {
  if (c.originIp) return;
  if (c.ssh.kind === "gcp") {
    const s = c.ssh;
    c.originIp = (
      await run([
        "gcloud",
        "compute",
        "instances",
        "describe",
        s.instance,
        `--project=${s.project}`,
        `--zone=${s.zone}`,
        "--format=value(networkInterfaces[0].accessConfigs[0].natIP)",
      ])
    ).trim();
  } else if (isIP(c.ssh.host) === 4) c.originIp = c.ssh.host;
  else {
    const addresses = await resolve4(c.ssh.host);
    if (addresses.length !== 1)
      throw new Error(
        "SSH hostname has multiple IPv4 addresses; provide originIp explicitly",
      );
    c.originIp = addresses[0];
  }
  if (!c.originIp || isIP(c.originIp) !== 4)
    throw new Error(
      "Could not discover a public origin IPv4; provide originIp explicitly",
    );
}
