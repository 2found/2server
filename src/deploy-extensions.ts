import { orderedExtensions, extensionBindings, assertBindingsReady } from "./bindings";
import type { Config } from "./config";
import type { AuthMap, Extension } from "./extensions/types";
import {
  enabledExtensions,
  withExtensionDomains,
  extensionFor,
} from "./extensions";
import { deployStateful, statefulFiles } from "./stateful";
import { preflightEdge } from "./edge";
import { cloudflareClient, inspectDomains, reconcileDomains } from "./domains";
import { resolveOrigin } from "./origin";
import { requireCloudflareToken } from "./cloudflare";

// Extension deploy orchestration. deployAll installs every enabled extension;
// deployExtension selects one extension while retaining binding context. Extensions
// that publish domains get provider/DNS validation before any VM change, then
// DNS/TLS/route reconciliation after the stack reports ready.

export const extensionOperations = {
  deploy: deployAll,
  preflightEdge,
  cloudflareClient,
  inspectDomains,
  reconcileDomains,
  auth: extensionAuth,
  resolveOrigin,
};
export async function extensionAuth(c: Config, state: string,create=true): Promise<AuthMap> {
  const map: AuthMap = {};
  for (const ext of enabledExtensions(c))
    if (ext.auth) Object.assign(map, await ext.auth(c, state,create));
  return map;
}
export async function deployAll(c: Config, selected = orderedExtensions(c)) {
  // Resolve every stateful secret before any SSH session starts.
  for (const ext of selected)
    if (ext.stateful) await statefulFiles(c, ext);
  for (const ext of selected) {
    await assertBindingsReady(c, extensionBindings(c, ext));
    if (ext.stateful) await deployStateful(c, ext);
    else await ext.deploy!(c);
  }
}
export async function deployExtensions(
  config: Config,
  state: string,
  ops = extensionOperations,
  selected?: Extension[],
) {
  const c = withExtensionDomains(config);
  const owned = (selected ?? enabledExtensions(c)).flatMap((e) => e.domains?.(c) ?? []);
  const domains = c.domains.filter((d) => owned.some((o) => o.name === d.name));
  if (!domains.length) {
    await ops.preflightEdge(c);
    await ops.deploy(c);
    return;
  }
  // Validate provider access, DNS ownership and credentials before changing the VM.
  const cf = ops.cloudflareClient(c);
  requireCloudflareToken(c.cloudflare.originTokenEnv);
  await ops.resolveOrigin(c);
  const scoped = { ...c, domains };
  const plans = await ops.inspectDomains(cf, scoped);
  const auth = await ops.auth(c, state);
  await ops.preflightEdge(c);
  await ops.deploy(c); // Includes internal readiness probes.
  await ops.reconcileDomains(scoped, state, cf, plans, auth, true);
}
// Deploy one extension through `create|update|reload extension`. The manifest
// remains complete for resolving bindings; the execution list selects exactly
// one extension. Published domains stay available so edge retains live routes.
export async function deployExtension(
  c: Config,
  name: string,
  state: string,
) {
  const ext = extensionFor(c, name);
  if (!ext) throw new Error("Unknown extension");
  // Keep the full config for resolving bindings; select execution separately.
  // Narrowing extensions erased dependencies even though they were configured.
  await deployExtensions(c, state, {
    ...extensionOperations,
    deploy: config => extensionOperations.deploy(config, [ext]),
    auth: async (config, state) => ext.auth?.(config, state) ?? {},
  }, [ext]);
}
