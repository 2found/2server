import { mkdir, rm, chmod, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { configSchema, appSchema, domainSchema, type Config } from "./config";
import { deployApp, rollbackApp, replicaNames } from "./apps";
import { remote, quote } from "./process";
import { preflightEdge } from "./edge";
import { withMonitoring, monitoringAuth, monitoringDomain } from "./monitoring";
import { cloudflareClient, inspectDomains, reconcileDomains } from "./domains";
import { resolveOrigin } from "./origin";
import { requireCloudflareToken } from "./cloudflare";
import { retireApp, retireDomain } from "./retire";
import { deployExtensions } from "./deploy-extensions";
import {
  deployStateful,
  removeStateful,
  statefulNames,
  extensionProject,
  extensionRoot,
  type Stateful,
} from "./stateful";
import { runBackup, restoreScript } from "./backups";
import { vmAction, initializeDisk, inspectDisk, resizeDisk } from "./vm";
import { provision } from "./provision";
import { provisionBackupStorage } from "./backup-storage";
import { gcsBackupStorage } from "./storage-config";
import { physicalRestoreScript, removeRecoveryScript } from "./pgbackrest";

const verbs = [
  "get",
  "describe",
  "create",
  "update",
  "delete",
  "reload",
  "get-log",
  "logs",
  "scale",
  "start",
  "stop",
  "backup",
  "check-backup",
  "restore",
  "resize",
  "rollback",
];
const aliases: Record<string, string> = {
  apps: "app",
  service: "app",
  services: "app",
  pods: "pod",
  workload: "pod",
  instance: "pod",
  domains: "domain",
  vms: "vm",
  extensions: "extension",
  disks: "disk",
  monitoring: "monitor",
};
const nouns = [
  "app",
  "pod",
  "domain",
  "vm",
  "extension",
  "disk",
  "monitor",
  "postgres",
  "backup-storage",
  "recovery",
];
const valueFlags = [
  "-f",
  "--file",
  "--spec",
  "--replicas",
  "--tail",
  "--database",
  "--id",
  "--recovery",
  "--target-time",
  "--size-gb",
];
export const resourceHelp = `Resource commands (verb-first or resource-first):
  2server get <app|pod|domain|vm|extension|disk|monitor> [NAME] -f server.json
  2server <create|update> <app|domain|extension> NAME -f server.json --spec resource.json [--apply]
  2server <delete|reload|get-log> <app|pod|domain|extension> NAME -f server.json [--apply]
  2server scale app NAME -f server.json --replicas 0..32 [--apply]
  2server rollback app NAME -f server.json [--apply]
  2server <create|update|delete|scale> vm <gcp|aws> -f server.tfvars [--apply]
  2server <start|stop|reload|get-log> vm -f server.json [--apply]
  2server create disk NAME -f server.json [--apply]  # initialize EMPTY attached disk
  2server resize disk NAME -f server.json --size-gb N [--apply]
  2server backup postgres -f server.json [--apply]
  2server restore postgres -f server.json --id BACKUP_ID --database NEW_DB [--apply]
  2server restore postgres -f server.json --recovery NAME [--target-time ISO_UTC] [--id BACKUP_LABEL] [--apply]
  2server check-backup postgres -f server.json [--apply]
  2server <get|delete> recovery [NAME] -f server.json [--apply]
  2server <get|create|update> backup-storage -f server.json [--apply]
  Logs: --tail 1..10000 (default 100). Specs are JSON; pods are NDJSON; monitor is a summary. Secrets are omitted.
  Pod create/update/delete reconcile its owning app; see README operation matrix.`;
export type Request = {
  verb: string;
  resource: string;
  name?: string;
  file: string;
  apply: boolean;
  options: Record<string, string>;
};
export function parseResource(args: string[]): Request | undefined {
  let [verb, resource, ...rest] = args;
  if (nouns.includes(aliases[verb] ?? verb) && verbs.includes(resource))
    [verb, resource] = [resource, verb];
  resource = aliases[resource] ?? resource;
  if (!verbs.includes(verb) || !nouns.includes(resource)) return undefined;
  // Preserve the old `rollback <manifest>` entrypoint.
  const options: Record<string, string> = {};
  let name: string | undefined,
    apply = false;
  while (rest.length) {
    const arg = rest.shift()!;
    if (arg === "--apply") {
      if (apply) throw new Error("Duplicate --apply");
      apply = true;
    } else if (valueFlags.includes(arg)) {
      const value = rest.shift();
      if (!value || value.startsWith("--"))
        throw new Error(`Missing value for ${arg}`);
      const key = ["-f", "--file"].includes(arg) ? "file" : arg.slice(2);
      if (key in options) throw new Error(`Duplicate ${arg}`);
      options[key] = value;
    } else if (arg.startsWith("-") || name)
      throw new Error(`Unexpected argument: ${arg}`);
    else name = arg;
  }
  if (!options.file)
    throw new Error("Resource commands require -f <manifest.json>");
  const allowed = new Set(["file"]);
  if (
    ["create", "update"].includes(verb) &&
    ["app", "domain", "extension"].includes(resource)
  )
    allowed.add("spec");
  if (verb === "scale" && resource === "app") allowed.add("replicas");
  if (["logs", "get-log"].includes(verb)) allowed.add("tail");
  if (verb === "restore") {
    allowed.add("id");
    allowed.add("database");
    allowed.add("recovery");
    allowed.add("target-time");
  }
  if (verb === "resize") allowed.add("size-gb");
  for (const key of Object.keys(options))
    if (!allowed.has(key)) throw new Error(`--${key} is not valid for ${verb}`);
  if (name && !/^[a-z][a-z0-9-]{0,150}$/.test(name))
    throw new Error("Invalid resource name");
  if (resource === "extension" && name === "image-proxy") name = "imageProxy";
  return {
    verb: verb === "get-log" ? "logs" : verb,
    resource,
    name,
    file: options.file,
    apply,
    options,
  };
}
const count = (
  value: string | undefined,
  min: number,
  max: number,
  flag: string,
) => {
  if (!value || !/^\d+$/.test(value) || +value < min || +value > max)
    throw new Error(`${flag} must be ${min}..${max}`);
  return +value;
};
const publicApp = (a: Config["apps"][number]) => ({
  name: a.name,
  kind: a.kind,
  image: a.image,
  replicas: a.replicas,
  port: a.port,
  memoryMb: a.memoryMb,
  cpus: a.cpus,
  envKeys: Object.keys(a.env),
  secretKeys: Object.keys(a.secrets),
});
export function podQueryScript(c: Config, name?: string) {
  return `docker ps -a --filter label=io.2server.owner=${c.name}${name ? ` --filter name=^/${name}$` : ""} --format '{"id":{{json .ID}},"name":{{json .Names}},"image":{{json .Image}},"status":{{json .Status}}}'`;
}
async function saveManifest(file: string, original: string, c: Config) {
  if ((await Bun.file(file).text()) !== original)
    throw new Error(
      "Manifest changed while the operation ran; remote operation succeeded, reconcile local changes before retrying",
    );
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await Bun.write(temp, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
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
  const state = join(homedir(), ".local", "state", "2server", c.name);
  const readOnly = ["get", "describe", "logs"].includes(r.verb);
  // Validation/dry-run occurs within dispatch before any external action.
  if (readOnly) {
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
    await dispatch(r, c, state, original);
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
  return true;
}
async function deploySelectedExtension(c: Config, name: string, state: string) {
  if (statefulNames.includes(name as Stateful))
    return deployStateful(c, name as Stateful);
  const selected: Config =
    name === "monitoring"
      ? {
          ...c,
          extensions: {
            monitoring: c.extensions.monitoring,
            alertWebhookEnv: c.extensions.alertWebhookEnv,
          },
        }
      : {
          ...c,
          domains: withMonitoring(c).domains,
          extensions: {
            monitoring: false,
            imageProxy: c.extensions.imageProxy,
          },
        };
  await deployExtensions(selected, state);
}
async function dispatch(
  r: Request,
  c: Config,
  state: string,
  original: string,
) {
  const { verb, resource, name, options } = r;
  const inspect = ["get", "describe"].includes(verb);
  const dry = () => {
    if (r.apply) return false;
    console.log(
      `${verb} ${resource} ${name ?? c.name}: pass --apply to execute`,
    );
    return true;
  };
  const emit = (x: unknown) => console.log(JSON.stringify(x, null, 2));
  const needName = () => {
    if (!name) throw new Error(`${verb} ${resource} requires NAME`);
    return name;
  };
  const spec = async () => {
    if (!options.spec) throw new Error("--spec <resource.json> is required");
    return Bun.file(options.spec).json();
  };
  if (resource === "backup-storage") {
    if (inspect) emit(gcsBackupStorage(c));
    else if (["create", "update"].includes(verb))
      await provisionBackupStorage(c, r.apply, state);
    else throw new Error("Backup storage supports get/create/update; bucket destruction is protected");
    return;
  }
  if (resource === "app") {
    const a = c.apps.find((a) => a.name === name);
    if (inspect) {
      if (name && !a) throw new Error("App not found");
      emit(a ? publicApp(a) : c.apps.map(publicApp));
      return;
    }
    needName();
    if (["create", "update"].includes(verb)) {
      if ((verb === "create") === !!a)
        throw new Error(
          a ? "App already exists; use update" : "App not found; use create",
        );
      const next = appSchema.parse(await spec());
      if (next.name !== name) throw new Error("Spec name must match NAME");
      const updated = configSchema.parse({
        ...c,
        apps: [...c.apps.filter((x) => x.name !== name), next],
      });
      if (dry()) return;
      await preflightEdge(withMonitoring(c));
      await deployApp(updated, next);
      await saveManifest(r.file, original, updated);
      return;
    }
    if (!a) throw new Error("App not found");
    if (verb === "logs") {
      const tail = count(options.tail ?? "100", 1, 10000, "--tail");
      console.log(
        await remote(
          c,
          `set -euo pipefail\ncolor=$(cat /opt/2server/apps/${a.name}/current)\ncase "$color" in blue|green) ;; *) exit 1;; esac\nfor n in $(docker ps -aq --filter label=io.2server.owner=${c.name} --filter label=io.2server.app=${a.name} --filter label=io.2server.generation="$color"); do docker logs --tail ${tail} "$n" 2>&1; done`,
        ),
      );
      return;
    }
    if (verb === "scale") {
      const next = {
        ...a,
        replicas: count(options.replicas, 0, 32, "--replicas"),
      };
      if (dry()) return;
      await preflightEdge(withMonitoring(c));
      await deployApp(c, next);
      await saveManifest(r.file, original, {
        ...c,
        apps: c.apps.map((x) => (x.name === name ? next : x)),
      });
      return;
    }
    if (!["delete", "reload", "rollback"].includes(verb))
      throw new Error(`Unsupported app operation: ${verb}`);
    if (dry()) return;
    await preflightEdge(withMonitoring(c));
    if (verb === "delete") {
      await retireApp(withMonitoring(c), a);
      await saveManifest(r.file, original, {
        ...c,
        apps: c.apps.filter((x) => x.name !== name),
      });
    } else if (verb === "rollback") {
      const prior = await rollbackApp(c, a);
      await saveManifest(r.file, original, {
        ...c,
        apps: c.apps.map((x) => (x.name === name ? prior : x)),
      });
    } else await deployApp(c, a);
    return;
  }
  if (resource === "pod") {
    if (inspect) {
      console.log(await remote(c, podQueryScript(c, name)));
      return;
    }
    needName();
    if (!["logs", "create", "update", "reload", "delete"].includes(verb))
      throw new Error(`Unsupported pod operation: ${verb}`);
    if (verb === "create") {
      // A pod is owned by an app. Adding one updates desired replica count atomically.
      const app = c.apps.find((a) => a.name === name);
      if (!app) throw new Error("pod create takes an existing app NAME");
      return dispatch(
        {
          ...r,
          verb: "scale",
          resource: "app",
          options: { ...options, replicas: String(app.replicas + 1) },
        },
        c,
        state,
        original,
      );
    }
    if (verb === "logs") {
      const tail = count(options.tail ?? "100", 1, 10000, "--tail");
      console.log(
        await remote(
          c,
          `set -euo pipefail\ntest "$(docker inspect -f '{{index .Config.Labels "io.2server.owner"}}' ${quote(name!)})" = ${quote(c.name)}\ndocker logs --tail ${tail} ${quote(name!)} 2>&1`,
        ),
      );
      return;
    }
    const a = c.apps.find((a) =>
      ["blue", "green"].some((color) =>
        replicaNames(c, a, color).includes(name!),
      ),
    );
    if (!a) throw new Error("Pod is not in a declared app generation");
    if (dry()) return;
    const generation = (
      await remote(c, `cat /opt/2server/apps/${a.name}/current`)
    ).trim();
    if (!replicaNames(c, a, generation).includes(name!))
      throw new Error("Only active-generation pods can be reconciled");
    // No resident scheduler: replace the generation to avoid dangling Caddy upstreams.
    if (verb === "delete")
      return dispatch(
        {
          ...r,
          verb: "scale",
          resource: "app",
          name: a.name,
          options: {
            ...options,
            replicas: String(Math.max(0, a.replicas - 1)),
          },
        },
        c,
        state,
        original,
      );
    await preflightEdge(withMonitoring(c));
    await deployApp(c, a);
    return;
  }
  if (resource === "domain") {
    const d = c.domains.find((d) => d.name === name);
    if (inspect) {
      const domains = withMonitoring(c).domains;
      const found = domains.find((d) => d.name === name);
      if (name && !found) throw new Error("Domain not found");
      emit(found ?? domains);
      return;
    }
    needName();
    if (!["create", "update", "delete", "reload"].includes(verb))
      throw new Error(`Unsupported domain operation: ${verb}`);
    let next = d;
    if (["create", "update"].includes(verb)) {
      if ((verb === "create") === !!d)
        throw new Error(d ? "Domain exists; use update" : "Domain not found");
      next = domainSchema.parse(await spec());
      if (next.name !== name) throw new Error("Spec name must match NAME");
      if (
        d &&
        (d.zone !== next.zone || d.hosts.some((h) => !next!.hosts.includes(h)))
      )
        throw new Error(
          "Retire old hosts explicitly before changing zone/removing hosts",
        );
    }
    if (!next) throw new Error("Domain not found");
    const updated = configSchema.parse({
      ...c,
      domains:
        verb === "delete"
          ? c.domains.filter((d) => d.name !== name)
          : [...c.domains.filter((d) => d.name !== name), next],
    });
    if (dry()) return;
    const cf = cloudflareClient(c);
    // A previous attempt may have published the new hostname before public DNS
    // verification failed. Include the proposed hosts so that retry can resume;
    // retirement still checks the old set until DNS has been removed.
    await preflightEdge(withMonitoring(verb === "delete" ? c : updated));
    if (verb === "delete") await retireDomain(c, next, cf);
    else {
      requireCloudflareToken(c.cloudflare.originTokenEnv);
      const full = withMonitoring(updated);
      await resolveOrigin(full);
      const selected = { ...full, domains: [next] };
      await reconcileDomains(
        selected,
        state,
        cf,
        await inspectDomains(cf, selected),
        await monitoringAuth(full, state),
        true,
      );
    }
    await saveManifest(r.file, original, updated);
    return;
  }
  if (resource === "extension") {
    if (inspect) {
      if (name && !Object.hasOwn(c.extensions, name))
        throw new Error("Extension not configured");
      emit(
        name
          ? { name, config: c.extensions[name as keyof Config["extensions"]] }
          : c.extensions,
      );
      return;
    }
    needName();
    if (![...statefulNames, "monitoring", "imageProxy"].includes(name!))
      throw new Error("Unknown extension");
    if (!["create", "update", "delete", "reload", "logs"].includes(verb))
      throw new Error(`Unsupported extension operation: ${verb}`);
    const key = name as keyof Config["extensions"];
    if (["create", "update"].includes(verb)) {
      if ((verb === "create") === !!c.extensions[key])
        throw new Error(
          "Use create for absent extensions and update for configured extensions",
        );
      const updated = configSchema.parse({
        ...c,
        extensions: { ...c.extensions, [name!]: await spec() },
      });
      if (dry()) return;
      await deploySelectedExtension(updated, name!, state);
      await saveManifest(r.file, original, updated);
      return;
    }
    if (!c.extensions[key]) throw new Error("Extension not configured");
    if (verb === "logs") {
      const tail = count(options.tail ?? "100", 1, 10000, "--tail");
      const ctr = statefulNames.includes(name as Stateful)
        ? extensionProject(c, name as Stateful)
        : `two-${c.name}-${name === "monitoring" ? "prometheus" : "imgproxy"}`;
      console.log(
        await remote(c, `docker logs --tail ${tail} ${quote(ctr)} 2>&1`),
      );
      return;
    }
    if (dry()) return;
    if (verb === "reload") {
      await deploySelectedExtension(c, name!, state);
      return;
    }
    if (statefulNames.includes(name as Stateful))
      await removeStateful(c, name as Stateful);
    else {
      if (name === "monitoring") {
        await preflightEdge(withMonitoring(c));
        const d = monitoringDomain(c)!;
        await retireDomain(c, d, cloudflareClient(c));
      }
      if (name === "imageProxy") {
        const target = `two-${c.name}-imgproxy`;
        if (
          withMonitoring(c).domains.some((d) =>
            JSON.stringify(d).includes(target),
          )
        )
          throw new Error(
            "Retire or reroute image proxy domains before removal",
          );
        await remote(
          c,
          `if grep -RF ${quote(target)} /opt/2server/edge/current/sites/; then echo 'Published route uses imgproxy' >&2; exit 1; fi`,
        );
      }
      const short = name === "monitoring" ? "monitoring" : "imgproxy";
      await remote(
        c,
        `test "$(cat /opt/2server/edge/owner)" = ${quote(c.name)}\ndocker compose -p two-server-${short} -f /opt/2server/${short}/compose.json down`,
      );
    }
    const ext = { ...c.extensions };
    delete ext[key];
    await saveManifest(
      r.file,
      original,
      configSchema.parse({ ...c, extensions: ext }),
    );
    return;
  }
  if (resource === "postgres") {
    if (inspect) {
      if (c.extensions.postgres?.backup?.engine !== "pgbackrest") throw new Error("get postgres requires pgBackRest; use get extension postgres for config");
      console.log(await remote(c, `docker exec --user postgres two-${c.name}-postgres pgbackrest --stanza=main --output=json info`));
      return;
    }
    if (verb === "check-backup") {
      const script = physicalRestoreScript(c, { name: "drill", check: true });
      if (!dry()) console.log(await remote(c, script));
      return;
    }
    if (verb === "backup") {
      if (!c.extensions.postgres?.backup)
        throw new Error("PostgreSQL backup is not configured");
      if (!dry()) console.log(await runBackup(c));
      return;
    }
    if (verb === "restore") {
      if (options.database && (options.recovery || options["target-time"])) throw new Error("Choose logical --database or physical --recovery, not both");
      const script = options.database
        ? restoreScript(c, options.id ?? "", options.database)
        : physicalRestoreScript(c, { name: options.recovery ?? "", targetTime: options["target-time"], id: options.id });
      if (!dry()) console.log(await remote(c, script));
      return;
    }
    throw new Error("Postgres supports get, backup, restore and check-backup");
  }
  if (resource === "recovery") {
    if (inspect) {
      if (name && !/^[a-z][a-z0-9-]{0,31}$/.test(name)) throw new Error("Invalid recovery name");
      console.log(await remote(c, `docker ps -a --filter label=io.2server.owner=${c.name} --filter label=io.2server.recovery=true ${name ? `--filter name=^/two-${c.name}-recovery-${name}$` : ""} --format '{{json .}}'`));
    }
    else if (verb === "delete") {
      needName();
      const script = removeRecoveryScript(c, name!);
      if (!dry()) console.log(await remote(c, script));
    } else throw new Error("Recovery supports get/delete only");
    return;
  }
  if (resource === "vm") {
    if (inspect) {
      emit(await vmAction(c, "get"));
      return;
    }
    if (verb === "logs") {
      const tail = count(options.tail ?? "100", 1, 10000, "--tail");
      console.log(await remote(c, `journalctl -b --no-pager -n ${tail}`));
      return;
    }
    if (verb === "reload") {
      if (dry()) return;
      await vmAction(c, "stop");
      emit(await vmAction(c, "start"));
      return;
    }
    if (!["start", "stop"].includes(verb))
      throw new Error(
        "Use get/start/stop/reload/logs vm; create/update/delete/scale use provider + tfvars",
      );
    if (!dry()) emit(await vmAction(c, verb as "start" | "stop"));
    return;
  }
  if (resource === "disk") {
    const d = c.disks.find((d) => d.name === name);
    if (inspect) {
      if (name && !d) throw new Error("Disk not found");
      emit(
        d
          ? { ...d, ...(await inspectDisk(c, d)), deviceCheck: undefined }
          : c.disks,
      );
      return;
    }
    if (!d)
      throw new Error(
        "Declare an attached disk in disks[] and provide its NAME",
      );
    if (!["create", "resize"].includes(verb))
      throw new Error(
        "Disk supports get/create/resize; data deletion is deliberately separate",
      );
    const size =
      verb === "resize"
        ? count(options["size-gb"], 1, 65536, "--size-gb")
        : undefined;
    if (dry()) return;
    if (size) await resizeDisk(c, d, size);
    else await initializeDisk(c, d);
    return;
  }
  if (resource === "monitor" && inspect) {
    console.log(
      await remote(
        c,
        `set -euo pipefail\nprintf 'HOST\\n'; uptime; free -m; df -h -x tmpfs -x devtmpfs\nprintf '\\nCONTAINERS\\n'; docker stats --no-stream --format '{{json .}}'\nprintf '\\nLAST POSTGRES BACKUP\\n'; cat /opt/2server/backups/postgres-last-success 2>/dev/null || true\n${c.extensions.postgres?.backup ? `systemctl show two-${c.name}-postgres-backup.service -p Result -p ExecMainStatus -p ActiveState` : ""}`,
      ),
    );
    return;
  }
  throw new Error(`Unsupported operation: ${verb} ${resource}`);
}
