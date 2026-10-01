import type { Config } from "./config";
import { extensions } from "./extensions";
import { preflightEdge } from "./edge";
import { cloudflareClient, inspectDomains, reconcileDomains } from "./domains";
import { monitoringAuth, monitoringDomain, withMonitoring } from "./monitoring";
import { resolveOrigin } from "./origin";

export const extensionOperations = {
  extensions,
  preflightEdge,
  cloudflareClient,
  inspectDomains,
  reconcileDomains,
  monitoringAuth,
  resolveOrigin,
};
export async function deployExtensions(
  config: Config,
  state: string,
  ops = extensionOperations,
) {
  const c = withMonitoring(config);
  const monitoring = monitoringDomain(c);
  if (!monitoring) {
    await ops.preflightEdge(c);
    await ops.extensions(c);
    return;
  }
  // Validate provider access, DNS ownership and credentials before changing the VM.
  const cf = ops.cloudflareClient(c);
  if (!process.env[c.cloudflare.originTokenEnv])
    throw new Error(`Missing ${c.cloudflare.originTokenEnv}`);
  await ops.resolveOrigin(c);
  const scoped = { ...c, domains: [monitoring] };
  const plans = await ops.inspectDomains(cf, scoped);
  const auth = await ops.monitoringAuth(c, state);
  await ops.preflightEdge(c);
  await ops.extensions(c); // Includes the internal Prometheus readiness probe.
  await ops.reconcileDomains(scoped, state, cf, plans, auth, true);
}
