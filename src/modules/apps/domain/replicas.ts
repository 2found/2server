import type { Config } from "../../config/application/config";
import type { App } from "./schema";
// Replica 1 keeps the original container name, so existing deployments upgrade in place.
export function replicaNames(c: Config, a: App, color: string): string[] {
  if (a.compose) return [a.compose.containers[color as "blue"|"green"]];
  return Array.from(
    { length: a.replicas },
    (_, i) => `two-${c.name}-${a.name}-${color}${i ? `-${i + 1}` : ""}`,
  );
}
