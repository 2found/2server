import { resourceContext } from "../../../shared/cli/resource-context";
import { type Request } from "../../../shared/cli/resource-request";
import { configSchema,type Config } from "../../config/application/config";
import { saveManifest } from "../../config/infrastructure/save";
import { extensionAuth } from "../../extensions/application/deploy";
import { withExtensionDomains } from "../../extensions/application/registry";
import { cloudflareClient,inspectDomains,reconcileDomains } from "../application/reconcile";
import { retireDomain } from "../application/retire";
import { domainSchema } from "../domain/schema";
import { requireCloudflareToken } from "../infrastructure/cloudflare";
import { preflightEdge } from "../infrastructure/edge";
import { resolveOrigin } from "../infrastructure/origin";
export async function domainResource(r: Request, c: Config, state: string, original: string): Promise<void> {
  const { verb, resource, name, options } = r;
  const { inspect, dry, emit, needName, spec } = resourceContext(r, c.name);
  if (resource === "domain") {
    const d = c.domains.find((d) => d.name === name);
    if (inspect) {
      const domains = withExtensionDomains(c).domains;
      const found = domains.find((d) => d.name === name);
      if (name && !found) throw new Error("Domain not found");
      emit(found ?? domains);
      return;
    }
    needName();
    if (!["create", "update", "delete", "reload"].includes(verb))
      throw new Error(`Unsupported domain operation: ${verb}`);
    let next = d;
    if (["create", "update"].includes(verb)) {
      if ((verb === "create") === !!d)
        throw new Error(d ? "Domain exists; use update" : "Domain not found");
      next = domainSchema.parse(await spec());
      if (next.name !== name) throw new Error("Spec name must match NAME");
      if (
        d &&
        (d.zone !== next.zone || d.hosts.some((h) => !next!.hosts.includes(h)))
      )
        throw new Error(
          "Retire old hosts explicitly before changing zone/removing hosts",
        );
    }
    if (!next) throw new Error("Domain not found");
    const updated = configSchema.parse({
      ...c,
      domains:
        verb === "delete"
          ? c.domains.filter((d) => d.name !== name)
          : [...c.domains.filter((d) => d.name !== name), next],
    });
    if (dry()) return;
    const cf = cloudflareClient(c);
    // A previous attempt may have published the new hostname before public DNS
    // verification failed. Include the proposed hosts so that retry can resume;
    // retirement still checks the old set until DNS has been removed.
    await preflightEdge(withExtensionDomains(verb === "delete" ? c : updated));
    if (verb === "delete") await retireDomain(c, next, cf);
    else {
      requireCloudflareToken(c.cloudflare.originTokenEnv);
      const full = withExtensionDomains(updated);
      await resolveOrigin(full);
      const selected = { ...full, domains: [next] };
      await reconcileDomains(
        selected,
        state,
        cf,
        await inspectDomains(cf, selected),
        await extensionAuth(full, state),
        true,
      );
    }
    await saveManifest(r.file, original, updated);
    return;
  }
  throw new Error(`Unsupported operation: ${verb} ${resource}`);
}
