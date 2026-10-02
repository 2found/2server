#!/usr/bin/env bun
import { main } from "./cli/main";

main().catch((e) => {
  console.error(e instanceof Error ? e.message : "Operation failed");
  process.exitCode = 1;
});
