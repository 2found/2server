import type { Config } from "./config";
import {
  Cloudflare,
  inspectDomains,
  applyPolicies,
  publishDns,
  type DomainPlan,
} from "./cloudflare";
import { certificate } from "./certificates";
import { installDomains, verifyOrigin, rollbackDomains } from "./edge";
import { verifyPublic } from "./verify";
import type { AuthMap } from "./monitoring";
// Shared by domain reconciliation and extension deployment: the latter supplies
// only its own domain and merges the release instead of replacing other sites.
export const domainOperations = {
  certificate,
  applyPolicies,
  installDomains,
  verifyOrigin,
  rollbackDomains,
  publishDns,
  verifyPublic,
};
export async function reconcileDomains(
  c: Config,
  state: string,
  cf: Cloudflare,
  plans: DomainPlan[],
  auth: AuthMap = {},
  merge = false,
  ops = domainOperations,
) {
  const token = process.env[c.cloudflare.originTokenEnv];
  if (!token) throw new Error(`Missing ${c.cloudflare.originTokenEnv}`);
  const pairs: Record<string, { cert: string; key: string }> = {};
  for (const d of c.domains)
    pairs[d.name] = await ops.certificate(new Cloudflare(token), d, state);
  await ops.applyPolicies(cf, plans);
  const release = await ops.installDomains(c, pairs, auth, merge);
  try {
    await ops.verifyOrigin(c, auth);
  } catch (error) {
    await ops.rollbackDomains(c, release);
    throw error;
  }
  await ops.publishDns(cf, c, plans);
  await ops.verifyPublic(c, undefined, undefined, undefined, auth);
  return release;
}
export function cloudflareClient(c: Config) {
  const token = process.env[c.cloudflare.tokenEnv];
  if (!token)
    throw new Error(`Missing environment variable ${c.cloudflare.tokenEnv}`);
  return new Cloudflare(token);
}
export { inspectDomains };
