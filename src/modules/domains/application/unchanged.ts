import { createHash } from "node:crypto";
import type { Config } from "../../config/application/config";
import { extensionAuth } from "../../extensions/application/deploy";
import { withExtensionDomains } from "../../extensions/application/registry";
import type { AuthMap } from "../../extensions/domain/types";
import type { Domain } from "../domain/schema";
import { storedCertificate } from "../infrastructure/certificates";
import { inspectDomains,policiesCurrent,requireCloudflareToken } from "../infrastructure/cloudflare";
import { readEdgeDigests,verifyOrigin } from "../infrastructure/edge";
import { resolveOrigin } from "../infrastructure/origin";
import { renderSite } from "../infrastructure/render";
import { verifyPublic } from "../infrastructure/verify";
import { cloudflareClient } from "./reconcile";

// An app deploy re-applies its domains every time. When every write that phase
// would make is already in place, the deploy only needs to verify the routes,
// and that needs neither the `domains` reservation nor a new edge release.
export const unchangedOperations = {
  readEdge: readEdgeDigests,
  inspect: async (c: Config, domains: Domain[]) => {
    requireCloudflareToken(c.cloudflare.originTokenEnv);
    await resolveOrigin(c);
    return inspectDomains(cloudflareClient(c), { ...c, domains });
  },
  auth: (c: Config, state: string) => extensionAuth(c, state, false),
  verifyOrigin,
  verifyPublic: (c: Config, auth: AuthMap) => verifyPublic(c, undefined, undefined, undefined, auth),
};
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
// Keys are compared so a reordered but equal spec is not a change.
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}
// Returns why the domain phase must run under its reservation, or undefined
// when the committed spec, stored certificate, live edge files, DNS, SSL mode and
// cache rules already match. Any failed read is a reason, never a skip.
export async function domainChanges(
  c: Config,
  domains: Domain[],
  state: string,
  ops = unchangedOperations,
): Promise<{ reason: string } | { auth: AuthMap }> {
  try {
    for (const d of domains) {
      const old = c.domains.find((x) => x.name === d.name);
      if (!old || canonical(old) !== canonical(d)) return { reason: `${d.name} spec changed` };
    }
    const pairs: Record<string, { cert: string; key: string }> = {};
    for (const d of domains) {
      const pair = await storedCertificate(d, state);
      if (!pair) return { reason: `${d.name} certificate needs issuing or renewal` };
      pairs[d.name] = pair;
    }
    const full = withExtensionDomains(c);
    const auth = await ops.auth(full, state);
    const expected: Record<string, string> = {};
    for (const d of domains) {
      const pair = pairs[d.name]!;
      if (d.requireAuth && !auth[d.name]) return { reason: `${d.name} credentials unavailable` };
      expected[`sites/${d.name}.caddy`] = sha256(renderSite(d, auth[d.name]));
      expected[`tls/${d.name}/cert.pem`] = sha256(pair.cert);
      expected[`tls/${d.name}/key.pem`] = sha256(pair.key);
    }
    const edge = await ops.readEdge(c, domains.map((d) => d.name));
    for (const [file, digest] of Object.entries(expected))
      if (edge.digests[file] !== digest) return { reason: `edge ${file} differs` };
    for (const d of domains)
      if (d.hosts.some((h) => !edge.hosts.includes(h))) return { reason: `${d.name} hosts not published on the edge` };
    for (const p of await ops.inspect(full, domains)) {
      if (p.dns.some((r) => r.change)) return { reason: `${p.domain.name} DNS needs an update` };
      if (p.sslChange) return { reason: `${p.domain.zone} SSL mode needs strict` };
      if (!policiesCurrent(p)) return { reason: `${p.domain.name} cache rules need an update` };
    }
    return { auth };
  } catch (e) {
    return { reason: `check failed: ${String((e as Error)?.message ?? e).split("\n")[0]!.slice(0, 200)}` };
  }
}
// Verifies unchanged domains read-only. False means the routes did not answer
// as expected: the caller reconciles under the reservation, which republishes
// the edge, checks again and rolls back on failure.
export async function verifyUnchanged(c: Config, domains: Domain[], auth: AuthMap, ops = unchangedOperations) {
  const selected = { ...withExtensionDomains(c), domains };
  try {
    await ops.verifyOrigin(selected, auth);
    await ops.verifyPublic(selected, auth);
    return true;
  } catch {
    return false;
  }
}
