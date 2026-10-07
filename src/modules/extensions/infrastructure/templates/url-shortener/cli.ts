import type { Config } from "../../../../config/application/config";
import { upsertCustomer } from "./deploy";
import { workerSpecSchema } from "./domain/spec";

export async function run(c: Config, command: string, args: string[]) {
  if (command !== "customers") throw new Error("unknown command");
  if (!c.instance) throw new Error("select the App instance");
  const spec = workerSpecSchema.parse(c.extensionApps[c.instance.name]?.spec);
  const apply = args.includes("--apply");
  const idIndex = args.indexOf("--id");
  const pubIndex = args.indexOf("--public");
  const id = idIndex >= 0 ? args[idIndex + 1] : undefined;
  const pubkey = pubIndex >= 0 ? args[pubIndex + 1] : undefined;
  if (!id || id.startsWith("-") || !pubkey || pubkey.startsWith("-"))
    throw new Error("pass --id and --public to register a customer");
  // The Worker verifies tokens against the same issuer pattern; a customer
  // registered under any other id could never authenticate.
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(id))
    throw new Error("--id must match the issuer pattern [a-z][a-z0-9-]{0,47}");
  if (!/^[A-Za-z0-9_-]{43}=?$/.test(pubkey))
    throw new Error("--public must be a raw-URL base64 Ed25519 public key");
  const result = await upsertCustomer(spec, id, pubkey, apply);
  console.log(JSON.stringify(result, null, 2));
  if (!apply) console.log("Plan only; pass --apply to write the customer row.");
}
