import { chmod,mkdir,rm } from "node:fs/promises";
import { join } from "node:path";
import { appResource } from "../modules/apps/cli/resource";
import { confirmComposeMigrations } from "../modules/apps/infrastructure/compose";
import { configSchema,type Config } from "../modules/config/application/config";
import { domainResource } from "../modules/domains/cli/resource";
import { extensionKey } from "../modules/extensions/application/registry";
import { extensionResource } from "../modules/extensions/cli/resource";
import { serverResource } from "../modules/server/cli/resource";
import { provision } from "../modules/server/infrastructure/provision";
import { parseResource as parseRequest,type Request } from "../shared/cli/resource-request";
import { operatorState } from "../shared/infrastructure/operator-state";


export const resourceHelp = `Resource commands (verb-first or resource-first):
  2srv get <app|pod|domain|vm|extension|disk|monitor> [NAME] -f server.json
  2srv <create|update> <app|domain|extension> NAME -f server.json --spec resource.json [--apply]
  2srv <delete|reload|get-log> <app|pod|domain|extension> NAME -f server.json [--apply]
  2srv adopt app NAME --spec compose-app.json [--apply] # uses connected VM
  2srv deploy app NAME -f server.json [--image repository@sha256:...] [--apply]
  2srv scale app NAME -f server.json --replicas 0..32 [--apply]
  2srv rollback app NAME -f server.json [--apply]
  2srv <create|update|delete|scale> vm <gcp|aws> -f server.tfvars [--apply]
  2srv <start|stop|reload|get-log> vm -f server.json [--apply]
  2srv create disk NAME -f server.json [--apply]  # initialize EMPTY attached disk
  2server resize disk NAME -f server.json --size-gb N [--apply]
  2srv <get|create|update> backup-storage -f server.json [--apply]
  Installed template commands: app NAME help.
  Logs: --tail 1..10000 (default 100). Specs are JSON; pods are NDJSON; monitor is a summary. Secrets are omitted.
  Pod create/update/delete reconcile its owning app; see README operation matrix.`;
export function parseResource(args: string[]): Request | undefined {
  const request = parseRequest(args);
  if (request?.resource === "extension" && request.name)
    request.name = extensionKey(request.name) ?? request.name;
  return request;
}
export async function resourceCommand(args: string[]): Promise<boolean> {
  const r = parseResource(args);
  if (!r) return false;
  if (
    r.resource === "vm" &&
    ["create", "update", "delete", "scale"].includes(r.verb)
  ) {
    if (!r.name || !["gcp", "aws"].includes(r.name))
      throw new Error(
        "VM create/update/delete/scale requires provider gcp|aws and -f original.tfvars",
      );
    await provision(r.name, r.file, r.apply, r.verb === "delete");
    return true;
  }
  const original = await Bun.file(r.file).text();
  const c = configSchema.parse(JSON.parse(original));
  if (r.resource === "vm" && r.name && r.name !== c.name)
    throw new Error("VM name must match the manifest name");
  if (["postgres", "monitor", "backup-storage"].includes(r.resource) && r.name)
    throw new Error(
      `${r.resource} does not take a NAME; the manifest selects the target`,
    );
  const state = operatorState(c.name);
  const readOnly = ["get", "describe", "logs"].includes(r.verb);
  // Validation/dry-run occurs within dispatch before any external action.
  if (readOnly || !r.apply) {
    await dispatch(r, c, state, original);
    return true;
  }
  await mkdir(state, { recursive: true, mode: 0o700 });
  await chmod(state, 0o700);
  const lock = join(state, "lock");
  try {
    await mkdir(lock);
  } catch {
    throw new Error(`Another operation holds ${lock}`);
  }
  try {
    confirmComposeMigrations(r.options["migrations-applied"] === "true");
    await dispatch(r, c, state, original);
  } finally {
    confirmComposeMigrations(false);
    await rm(lock, { recursive: true, force: true });
  }
  return true;
}
async function dispatch(r: Request, c: Config, state: string, original: string) {
  switch (r.resource) {
    case "app": case "pod": return appResource(r, c, state, original);
    case "domain": return domainResource(r, c, state, original);
    case "webhook": case "extension": case "postgres": case "recovery": case "monitor":
      return extensionResource(r, c, state, original);
    case "backup-storage": case "vm": case "disk": return serverResource(r, c, state, original);
    default: throw new Error(`Unsupported operation: ${r.verb} ${r.resource}`);
  }
}
