#!/usr/bin/env bun
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

// Resolve the operator's installed release, even after the skill is copied alone.
// No cwd search: a consuming project's package.json is not the CLI package.
export function productRoot(executable = Bun.which("2srv") ?? Bun.which("2server")): string {
  if (!executable) throw new Error("2srv is not on PATH; install @2server/cli with npm first.");
  try {
    const root = dirname(dirname(realpathSync(executable)));
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (pkg.name === "@2server/cli" && existsSync(join(root, "src/cli.ts"))) return root;
  } catch {
    // Never disclose file contents or the underlying filesystem error.
  }
  throw new Error("Cannot locate the installed @2server/cli package from its launcher.");
}

if (import.meta.main) {
  try {
    console.log(productRoot());
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
