#!/usr/bin/env bun
// Derive commands from the product adapter; never execute the supplied command.
import { readConfig } from "../../../src/modules/config/infrastructure/file";
import { quote, sshArgs } from "../../../src/shared/infrastructure/process";
const [manifest, command = "sudo -n true", ...extra] = process.argv.slice(2);
if (!manifest || extra.length) {
  console.error("Usage: ssh-command.ts manifest.json [remote-command]");
  process.exit(2);
}
try {
  console.log(sshArgs(await readConfig(manifest), command).map(quote).join(" "));
} catch {
  console.error("Cannot render SSH command; check manifest path and schema.");
  process.exitCode = 1;
}
