#!/usr/bin/env bun
import { mkdir, chmod, rm } from "node:fs/promises";
import { operatorState } from "./operator-state";
import { join } from "node:path";
import { readConfig } from "./config";
import { cloudflareClient, inspectDomains, reconcileDomains } from "./domains";
import { preflightEdge } from "./edge";
import {
  withMonitoring,
  monitoringAuth,
  monitoringSettings,
  monitoringCredentialPath,
} from "./monitoring";
import { deployExtensions } from "./deploy-extensions";
import { setup } from "./setup";
import { verifyPublic } from "./verify";
import { deployApp, rollbackApp } from "./apps";
import { remote } from "./process";
import { resolveOrigin } from "./origin";
import { requireCloudflareToken } from "./cloudflare";

import { provision } from "./provision";
import { resourceCommand, resourceHelp } from "./resources";

import { controlCommand, connectedCommand, controlHelp } from "./control";

async function main(args = process.argv.slice(2)) {
  const [command, file, ...flags] = args;
  if (!command || command === "help" || command === "--help") {
    console.log(
      controlHelp + "\n\n" + resourceHelp +
        "\n\nLegacy commands:\n" +
        "2server.app\n  bun src/cli.ts <validate|plan|setup|domains|deploy|rollback|extensions|verify|status> <manifest.json> [--apply]\n  bun src/cli.ts provision <gcp|aws> <terraform.tfvars> [--apply]\nAll mutations require --apply. SSH host keys must already be trusted.",
    );
    return;
  }
  if (await controlCommand(args)) return;
  if (await connectedCommand(args, main)) return;
  if (await resourceCommand(args)) return;
  if (command === "provision") {
    if (!flags[0] || flags.slice(1).some((f) => f !== "--apply"))
      throw new Error(
        "provision requires gcp|aws, a tfvars path and optional --apply",
      );
    await provision(file, flags[0], flags.includes("--apply"));
    return;
  }
  if (!file || flags.some((f) => f !== "--apply"))
    throw new Error("Expected manifest path and optional --apply");
  const c = withMonitoring(await readConfig(file));
  const state = operatorState(c.name);
  const apply = flags.includes("--apply");
  if (command === "validate") {
    console.log(`Valid manifest: ${c.name}`);
    return;
  }
  if (command === "verify") {
    await verifyPublic(
      c,
      undefined,
      undefined,
      undefined,
      await monitoringAuth(c, state, false),
    );
    console.log("Public HTTPS checks passed");
    return;
  }
  if (command === "status") {
    console.log(
      await remote(
        c,
        'docker ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Image}}"',
      ),
    );
    return;
  }
  if (
    ["setup", "deploy", "rollback", "extensions"].includes(command) &&
    !apply
  ) {
    console.log(
      `${command}: ${c.name}; ${c.edge.mode} Caddy; monitoring: ${monitoringSettings(c)?.hostname ?? "disabled"}; apps: ${c.apps.map((a) => a.name).join(", ") || "none"}. Pass --apply to execute.`,
    );
    return;
  }
  await mkdir(state, { recursive: true, mode: 0o700 });
  await chmod(state, 0o700);
  const lock = join(state, "lock");
  try {
    await mkdir(lock);
  } catch {
    throw new Error(
      `Another operation holds ${lock}; only remove it after confirming no operation is running`,
    );
  }
  try {
    if (command === "setup") {
      await setup(c);
      console.log("VM and edge ready");
      return;
    }
    if (command === "rollback") {
      await preflightEdge(c);
      for (const a of [...c.apps].reverse()) await rollbackApp(c, a);
      console.log("Apps rolled back");
      return;
    }
    if (command === "deploy") {
      await preflightEdge(c);
      for (const a of c.apps) await deployApp(c, a);
      console.log("Apps deployed");
      return;
    }
    if (command === "extensions") {
      await deployExtensions(c, state);
      console.log("Extensions configured");
      const monitoring = monitoringSettings(c);
      if (monitoring)
        console.log(
          `Monitoring: https://${monitoring.hostname}; user: ${monitoring.username}; password: ${monitoring.passwordEnv ? `environment variable ${monitoring.passwordEnv}` : monitoringCredentialPath(state)}`,
        );
      return;
    }
    if (!["plan", "domains"].includes(command))
      throw new Error("Unknown command; use help");
    const cf = cloudflareClient(c);
    if (command === "domains" && apply)
      requireCloudflareToken(c.cloudflare.originTokenEnv);
    await resolveOrigin(c);
    const plans = await inspectDomains(cf, c);
    console.log(
      JSON.stringify(
        plans.map((p) => ({
          domain: p.domain.name,
          zone: p.domain.zone,
          hosts: p.domain.hosts,
          dns: p.dns.map((d) => ({
            host: d.host,
            action: d.change ? "upsert" : "keep",
          })),
          ssl: p.sslChange ? "set zone Full (strict)" : "keep strict",
          cache: p.domain.cache,
        })),
        null,
        2,
      ),
    );
    if (command === "plan" || !apply) return;
    await preflightEdge(c);
    const auth = await monitoringAuth(c, state);
    const release = await reconcileDomains(c, state, cf, plans, auth);
    console.log(
      `Domains published; edge release ${release}. Public HTTPS passed; verify app login before retiring any old domain.`,
    );
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : "Operation failed");
  process.exitCode = 1;
});
