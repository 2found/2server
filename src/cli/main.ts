import { chmod,mkdir,rm } from "node:fs/promises";
import { join } from "node:path";
import { deployApp,rollbackApp } from "../modules/apps/application/deploy";
import { appCommand,appHelp } from '../modules/apps/cli/command';
import { readConfig } from "../modules/config/infrastructure/file";
import { cloudflareClient,inspectDomains,reconcileDomains } from "../modules/domains/application/reconcile";
import { requireCloudflareToken } from "../modules/domains/infrastructure/cloudflare";
import { preflightEdge } from "../modules/domains/infrastructure/edge";
import { resolveOrigin } from "../modules/domains/infrastructure/origin";
import { verifyPublic } from "../modules/domains/infrastructure/verify";
import { deployExtensions,extensionAuth } from "../modules/extensions/application/deploy";
import { withExtensionDomains } from "../modules/extensions/application/registry";
import { extensionSummaries } from "../modules/extensions/application/contributions";
import { setup } from "../modules/server/application/setup";
import { fileCommand,fileHelp } from "../modules/source/cli/command";
import { operatorState } from "../shared/infrastructure/operator-state";
import { remote } from "../shared/infrastructure/process";

import { provision } from "../modules/server/infrastructure/provision";
import { resourceCommand,resourceHelp } from "./resources";

import { connectedCommand,mutatesControl } from "../modules/control/application/session";
import { controlCommand,controlHelp } from "../modules/control/cli/command";

export async function main(args = process.argv.slice(2)) {
  const [command, file, ...flags] = args;
  if (!command || command === "help" || command === "--help") {
    if(file==='legacy') console.log(fileHelp+'\n'+controlHelp+'\n'+resourceHelp);
    else console.log(`2server — infrastructure and deployment by 2found
Use 2srv (2server is a compatibility alias).
  init server NAME -o server.local.json
  init app NAME [--template TEMPLATE] -o FILE
  validate -f FILE | plan -f FILE | deploy -f FILE [--apply]
  apply -f platform/zone.yaml [--apply]  # zone policy only; no app rollout
  ${appHelp}
  secret <list|set|delete> [--app NAME] [--env-file FILE|--key KEY] [--apply]
  server <bootstrap|publish|env|config|backup|restore|lock|unlock> ...
  connect --ssh user@host | --connection FILE
  provision <gcp|aws> TFVARS [--output FILE] [--ssh-user USER] [--apply]

App commands come from the installed template: app NAME help.
Use help legacy for compatibility/provider commands. Remote changes require --apply.`);
    return;
  }
  if (await appCommand(args,main)) return;
  if (await fileCommand(args)) return;
  if (await controlCommand(args)) return;
  if (await connectedCommand(args, main)) return;
  if(command === "app-action")throw new Error("No VM connection; connect before using app commands");
  if(command === "secret")throw new Error("No VM connection; run connect --ssh user@host or pass --connection FILE");
  if (await resourceCommand(args)) return;
  if (command === "provision") {
    if (!flags[0] || flags[0].startsWith('-')) throw new Error('provision requires gcp|aws|gcs-backup and a tfvars path');
    const options: Record<string,string> = {};
    for(let i=1;i<flags.length;i++) {
      const key=flags[i];
      if(!['--apply','--output','--ssh-user'].includes(key)||key in options) throw new Error('Unknown or duplicate provision option');
      if(key==='--apply') options[key]='true';
      else { const value=flags[++i]; if(!value||value.startsWith('-'))throw new Error(`Missing ${key}`);options[key]=value; }
    }
    await provision(file, flags[0], !!options['--apply'], false, {output:options['--output'],sshUser:options['--ssh-user']});
    return;
  }
  if (!file || flags.some((f) => f !== "--apply"))
    throw new Error("Expected manifest path and optional --apply");
  const c = withExtensionDomains(await readConfig(file));
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
      await extensionAuth(c, state, false),
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
      `${command}: ${c.name}; ${c.edge.mode} Caddy; extensions: ${extensionSummaries(c,state).join("; ") || "none"}; apps: ${c.apps.map((a) => a.name).join(", ") || "none"}. Pass --apply to execute.`,
    );
    return;
  }
  const lock = join(state, "lock");
  const mutate = mutatesControl(args);
  if (mutate) {
    await mkdir(state, { recursive: true, mode: 0o700 });
    await chmod(state, 0o700);
    try {
      await mkdir(lock);
    } catch {
      throw new Error(
        `Another operation holds ${lock}; only remove it after confirming no operation is running`,
      );
    }
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
      for (const summary of extensionSummaries(c,state)) console.log(summary);
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
    const auth = await extensionAuth(c, state);
    const release = await reconcileDomains(c, state, cf, plans, auth);
    console.log(
      `Domains published; edge release ${release}. Public HTTPS passed; verify app login before retiring any old domain.`,
    );
  } finally {
    if (mutate) await rm(lock, { recursive: true, force: true });
  }
}
