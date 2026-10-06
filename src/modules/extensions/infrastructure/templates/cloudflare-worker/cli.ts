import type { Config } from "../../../../config/application/config";
import { upsertCustomer, type WorkerSpec } from "../../../application/edge";

export async function run(c: Config, command: string, args: string[]) {
  if (command !== "customers") throw new Error("unknown command");
  if (!c.instance) throw new Error("select the App instance");
  const spec = c.extensionApps[c.instance.name]?.spec as WorkerSpec | undefined;
  if (!spec) throw new Error("missing cloudflare-worker spec");
  const apply = args.includes("--apply");
  const id = flag(args, "--id");
  const pubkey = flag(args, "--public");
  if (!id !== !pubkey) throw new Error("provide both --id and --public, or neither to refuse");
  if (!id || !pubkey) throw new Error("list is not implemented; pass --id and --public to register");
  const result = await upsertCustomer(spec, id, pubkey, apply);
  console.log(JSON.stringify(result, null, 2));
  if (!apply) console.log("Plan only; pass --apply to write the customer row.");
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith("-")) throw new Error(`${name} needs a value`);
  return v;
}
