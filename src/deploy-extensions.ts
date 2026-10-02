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
// deployExtension scopes the manifest to one declared extension. Extensions
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
async function extensionAuth(c: Config, state: string): Promise<AuthMap> {
  const map: AuthMap = {};
  for (const ext of enabledExtensions(c))
    if (ext.auth) Object.assign(map, await ext.auth(c, state));
  return map;
}
export async function deployAll(c: Config) {
  // Resolve every stateful secret before any SSH session starts.
  for (const ext of enabledExtensions(c))
    if (ext.stateful) await statefulFiles(c, ext);
  for (const ext of enabledExtensions(c)) {
    if (ext.stateful) await deployStateful(c, ext);
    else await ext.deploy!(c);
  }
}
export async function deployExtensions(
  config: Config,
  state: string,
  ops = extensionOperations,
) {
  const c = withExtensionDomains(config);
  const owned = enabledExtensions(c).flatMap((e) => e.domains?.(c) ?? []);
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
// is narrowed by the declaration's `scoped` so a single-extension deploy never
// touches siblings; published domains still come from the full manifest so the
// edge keeps every live route.
export async function deployExtension(
  c: Config,
  name: string,
  state: string,
) {
  const ext = extensionFor(c, name);
  if (!ext) throw new Error("Unknown extension");
  const selected: Config = {
    ...c,
    domains: withExtensionDomains(c).domains,
    // Deliberately narrow: a scoped manifest carries only the keys this
    // extension reads, so a single-extension deploy never touches siblings.
    extensions: ext.scoped(c) as Config["extensions"],
  };
  await deployExtensions(selected, state);
}
