#!/usr/bin/env bun
// Derive commands from the product adapter; never execute the supplied command.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { productRoot } from "./product-root";
const [manifest, command = "sudo -n true", ...extra] = process.argv.slice(2);
if (!manifest || extra.length) {
  console.error("Usage: ssh-command.ts manifest.json [remote-command]");
  process.exit(2);
}
try {
  const root = productRoot();
  const { readConfig } = await import(pathToFileURL(join(root, "src/modules/config/infrastructure/file.ts")).href);
  const { quote, sshArgs } = await import(pathToFileURL(join(root, "src/shared/infrastructure/process.ts")).href);
  console.log(sshArgs(await readConfig(manifest), command).map(quote).join(" "));
} catch {
  console.error("Cannot render SSH command; check the installed @2server/cli, manifest path and schema.");
  process.exitCode = 1;
}
