import { configSchema, type Config, type Domain } from "./config";
import { resolveOrigin } from './origin';
import {
  Cloudflare,
  inspectDomains,
  applyPolicies,
  publishDns,
  type DomainPlan,
  requireCloudflareToken,
} from "./cloudflare";
import { certificate } from "./certificates";
import { installDomains, verifyOrigin, rollbackDomains } from "./edge";
import { verifyPublic } from "./verify";
import type { AuthMap } from "./extensions/types";
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
  const token = requireCloudflareToken(c.cloudflare.originTokenEnv);
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
  return new Cloudflare(requireCloudflareToken(c.cloudflare.tokenEnv));
}
// Source plans must exercise the same DNS ownership/zone checks as publication,
// before a successful application rollout can be followed by a predictable error.
export async function planSourceDomains(c: Config, domains: Domain[]) {
  if (!domains.length) return;
  for (const next of domains) {
    const old = c.domains.find(d => d.name === next.name);
    if (old && (old.zone !== next.zone || old.hosts.some(h => !next.hosts.includes(h))))
      throw new Error('Retire old hosts explicitly before changing zone/removing hosts');
  }
  const updated = configSchema.parse({...c, domains:[...c.domains.filter(d => !domains.some(next => next.name === d.name)), ...domains]});
  requireCloudflareToken(c.cloudflare.originTokenEnv);
  const cf = cloudflareClient(c);
  await resolveOrigin(updated);
  const plans = await inspectDomains(cf, {...updated,domains});
  console.log(JSON.stringify(plans.map(p => ({domain:p.domain.name,zone:p.domain.zone,
    dns:p.dns.map(d=>({host:d.host,action:d.change?'upsert':'keep'})),
    ssl:p.sslChange?'set zone Full (strict)':'keep strict',cache:p.domain.cache})),null,2));
}
export { inspectDomains };
