import type { Config } from "../../config/application/config";
import type { Domain } from "../../domains/domain/schema";
import type { App } from "./schema";
export function assertAppUnreferenced(c: Config, a: App) {
  const uses = (u: Domain["upstream"]) =>
    u.kind === "import"
      ? (u.name === `up_two_${a.name}` || u.name === a.compose?.upstreamName)
      : u.target.startsWith(`two-${c.name}-${a.name}-`);
  if (
    c.domains.some(
      (d) => uses(d.upstream) || d.routes.some((r) => uses(r.upstream)),
    )
  )
    throw new Error(
      "Remove or reroute domains referencing this app before deletion",
    );
}
