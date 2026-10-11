import type { Config } from "../../config/application/config";

// Pure rules for `delete --purge`. A purge removes only paths this server can
// prove it owns; anything else is refused before any effect.
const reserved = ["control", "edge", "extensions", "apps", "backups", "metrics"];
export function purgeDataPathIssue(path: string): string | undefined {
  if (!/^\/[A-Za-z0-9_.\/-]+$/.test(path) || path.endsWith("/") || path.split("/").slice(1).some(s => !s || s === "." || s === ".."))
    return "must be a normalized absolute path";
  const opt = path.startsWith("/opt/2server/"), segments = path.split("/").slice(opt ? 3 : 2);
  if (!opt && !path.startsWith("/srv/")) return "must be under /opt/2server/ or /srv/";
  if (opt && reserved.includes(segments[0])) return `must not be inside /opt/2server/${segments[0]}`;
  if (opt && segments[0] === "data" && segments.length < 2) return "must not be /opt/2server/data itself";
  return undefined;
}
// Docker lists Docker Hub images without the registry and library prefixes.
export function imageRepository(image: string): string {
  let ref = image.split("@")[0];
  const colon = ref.lastIndexOf(":");
  if (colon > ref.lastIndexOf("/")) ref = ref.slice(0, colon);
  return ref.replace(/^(?:docker\.io|index\.docker\.io)\//, "").replace(/^library\//, "");
}
export function domainsRoutingTo(c: Config, containers: string[]): string[] {
  return c.domains
    .filter(d => [d.upstream, ...d.routes.map(r => r.upstream)].some(u => u.kind === "proxy" && containers.some(n => u.target.startsWith(`${n}:`))))
    .map(d => d.name);
}
