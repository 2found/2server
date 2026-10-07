import type { Config } from "../../config/application/config";
import { cloudflareClient,inspectDomains,reconcileDomains } from "../../domains/application/reconcile";
import { requireCloudflareToken } from "../../domains/infrastructure/cloudflare";
import { preflightEdge } from "../../domains/infrastructure/edge";
import { resolveOrigin } from "../../domains/infrastructure/origin";
import type { AuthMap,Extension } from "../domain/types";
import { assertBindingsReady,extensionBindings,orderedExtensions } from "./bindings";
import {
enabledExtensions,
extensionFor,
withExtensionDomains,
} from "./registry";
import { deployStateful,statefulFiles } from "./stateful";

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
  // External runtimes own their source lifecycle; the VM engine skips them.
  const vm = selected.filter((ext) => !ext.source);
  // Resolve every stateful secret before any SSH session starts.
  for (const ext of vm)
    if (ext.stateful) await statefulFiles(c, ext);
  for (const ext of vm) {
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
  if (ext.source) throw new Error("External apps must be deployed from their source file with 2server deploy -f FILE --apply");
  // Keep the full config for resolving bindings; select execution separately.
  // Narrowing extensions erased dependencies even though they were configured.
  await deployExtensions(c, state, {
    ...extensionOperations,
    deploy: config => extensionOperations.deploy(config, [ext]),
    auth: async (config, state) => ext.auth?.(config, state) ?? {},
  }, [ext]);
}
