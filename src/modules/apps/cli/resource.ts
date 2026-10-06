import { count,resourceContext } from "../../../shared/cli/resource-context";
import { type Request } from "../../../shared/cli/resource-request";
import { quote,remote } from "../../../shared/infrastructure/process";
import { configSchema,type Config } from "../../config/application/config";
import { saveManifest } from "../../config/infrastructure/save";
import { preflightEdge } from "../../domains/infrastructure/edge";
import { assertExtensionUnused } from "../../extensions/application/bindings";
import { deployExtension } from "../../extensions/application/deploy";
import { enabledExtensions,withExtensionDomains } from "../../extensions/application/registry";
import { extensionProject,removeStateful } from "../../extensions/application/stateful";
import { deployApp,rollbackApp } from "../application/deploy";
import { retireApp } from "../application/retire";
import { replicaNames } from "../domain/replicas";
import { appSchema } from "../domain/schema";
import { adoptCompose,composePods } from "../infrastructure/compose";
const publicApp = (a: Config["apps"][number]) => ({
  name: a.name,
  kind: a.kind,
  image: a.image,
  replicas: a.replicas,
  port: a.port,
  memoryMb: a.memoryMb,
  cpus: a.cpus,
  cloudMetadata: a.labels['cloud-metadata']==='allow',
  envKeys: Object.keys(a.env),
  secretKeys: Object.keys(a.secrets),
  runtime: a.compose ? "compose" : "docker",
});
export function podQueryScript(c: Config, name?: string) {
  return `docker ps -a --filter label=io.2server.owner=${c.name}${name ? ` --filter name=^/${name}$` : ""} --format '{"id":{{json .ID}},"name":{{json .Names}},"image":{{json .Image}},"status":{{json .Status}}}'`;
}
export async function appResource(r: Request, c: Config, state: string, original: string): Promise<void> {
  const { verb, resource, name, options } = r;
  const { inspect, dry, emit, needName, spec } = resourceContext(r, c.name);
  if (resource === "app") {
    const a = c.apps.find((a) => a.name === name);
    const templateApps=enabledExtensions(c);
    const ext=templateApps.find(e=>e.name===name);
    const publicTemplate=(e:typeof templateApps[number])=>({name:e.name,template:c.extensionApps[e.name]?.template??e.cliName??e.name,runtime:'template',commands:Object.keys(e.commands??{})});
    if (inspect) {
      if (name && !a && !ext) throw new Error("App not found");
      emit(a ? publicApp(a) : ext?publicTemplate(ext):[...c.apps.map(publicApp),...templateApps.map(publicTemplate)]);
      return;
    }
    if(ext) {
      // A worker app has no VM workload: it deploys from its source file through
      // the Cloudflare path, and retirement is explicit in Cloudflare.
      const worker=ext.runtimeEngine==='worker';
      if(worker&&verb!=='delete')throw new Error('Worker apps have no VM workload; deploy them from their source file with 2server deploy -f FILE --apply');
      if(verb==='logs') {
        const tail=count(options.tail??'100',1,10000,'--tail');
        console.log(await remote(c,`docker logs --tail ${tail} ${quote(ext.logTarget?.(c)??extensionProject(c,ext.name))} 2>&1`));return;
      }
      if(!['deploy','reload','delete'].includes(verb))throw new Error('Template apps use deploy/restart/delete; use app NAME help for template-specific operations');
      if(options.image)throw new Error('Edit the template App file to change its image');
      if(verb==='delete')assertExtensionUnused(c,ext.name);
      if(dry())return;
      if(verb!=='delete'){await deployExtension(c,ext.name,state);return;}
      if(!worker){
        if(ext.stateful)await removeStateful(c,ext);else await ext.remove!(withExtensionDomains(c));
      }
      const updated=structuredClone(c);
      if(updated.extensionApps[ext.name])delete updated.extensionApps[ext.name];
      else if(updated.extensions.services[ext.name])delete updated.extensions.services[ext.name];
      else delete (updated.extensions as Record<string,unknown>)[ext.name];
      await saveManifest(r.file,original,configSchema.parse(updated));return;
    }
    needName();
    if (verb === "adopt") {
      if (a) throw new Error("App already registered; use deploy/update instead of re-adopting");
      const next = appSchema.parse(await spec());
      if (next.name !== name || !next.compose) throw new Error("Adoption requires matching name and compose spec");
      if (dry()) return;
      const adopted = await adoptCompose(c,next);
      await saveManifest(r.file,original,configSchema.parse({...c,apps:[...c.apps,adopted]}));
      console.log(`Adopted ${name}; running containers and routes preserved`);
      return;
    }
    if (["create", "update"].includes(verb)) {
      if ((verb === "create") === !!a)
        throw new Error(
          a ? "App already exists; use update" : "App not found; use create",
        );
      const next = appSchema.parse(await spec());
      if (next.name !== name) throw new Error("Spec name must match NAME");
      if (!a && next.compose) throw new Error("Use adopt app for an existing Compose pair");
      if (a?.compose && JSON.stringify(a.compose) !== JSON.stringify(next.compose)) throw new Error("Compose bindings cannot be changed through app update");
      const updated = configSchema.parse({
        ...c,
        apps: [...c.apps.filter((x) => x.name !== name), next],
      });
      if (dry()) return;
      await preflightEdge(withExtensionDomains(c), false);
      await deployApp(updated, next);
      await saveManifest(r.file, original, updated);
      return;
    }
    if (!a) throw new Error("App not found");
    if (verb === "deploy") {
      const next = appSchema.parse({...a, image: options.image ?? a.image});
      if (dry()) return;
      await preflightEdge(withExtensionDomains(c), false);
      await deployApp(c, next);
      await saveManifest(r.file, original, {...c, apps: c.apps.map(x => x.name === name ? next : x)});
      return;
    }
    if (verb === "logs") {
      const tail = count(options.tail ?? "100", 1, 10000, "--tail");
      if (a.compose) {
        const p=a.compose;
        console.log(await remote(c, `set -euo pipefail
color=$(cat /opt/2server/apps/${a.name}/current)
case "$color" in blue) n=${quote(p.containers.blue)};; green) n=${quote(p.containers.green)};; *) exit 1;; esac
test "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$n")" = ${quote(p.project)}
docker logs --tail ${tail} "$n" 2>&1`));
        return;
      }

      console.log(
        await remote(
          c,
          `set -euo pipefail\ncolor=$(cat /opt/2server/apps/${a.name}/current)\ncase "$color" in blue|green) ;; *) exit 1;; esac\nfor n in $(docker ps -aq --filter label=io.2server.owner=${c.name} --filter label=io.2server.app=${a.name} --filter label=io.2server.generation="$color"); do docker logs --tail ${tail} "$n" 2>&1; done`,
        ),
      );
      return;
    }
    if (verb === "scale") {
      if (a.compose) throw new Error("Compose pairs have one replica; native apps support scale 0..32");
      const next = {
        ...a,
        replicas: count(options.replicas, 0, 32, "--replicas"),
      };
      if (dry()) return;
      await preflightEdge(withExtensionDomains(c), false);
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
    await preflightEdge(withExtensionDomains(c), false);
    if (verb === "delete") {
      await retireApp(withExtensionDomains(c), a);
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
      const composeNames=new Set(c.apps.flatMap(a=>a.compose?Object.values(a.compose.containers):[]));
      const rows=(await remote(c,podQueryScript(c,name))).trim().split("\n").filter(Boolean);
      console.log(rows.filter(row=>!composeNames.has(JSON.parse(row).name)).join("\n"));
      for (const app of c.apps.filter(a=>a.compose && (!name || Object.values(a.compose.containers).includes(name)))) console.log(await remote(c,composePods(c,app,name)));
      return;
    }
    needName();
    if (!["logs", "create", "update", "reload", "delete"].includes(verb))
      throw new Error(`Unsupported pod operation: ${verb}`);
    if (verb === "create") {
      // A pod is owned by an app. Adding one updates desired replica count atomically.
      const app = c.apps.find((a) => a.name === name);
      if (!app) throw new Error("pod create takes an existing app NAME");
      return appResource(
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
      const adopted=c.apps.find(a=>a.compose && Object.values(a.compose.containers).includes(name!));
      if (adopted?.compose) {
        console.log(await remote(c, `set -euo pipefail
test "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' ${quote(name!)})" = ${quote(adopted.compose.project)}
docker logs --tail ${tail} ${quote(name!)} 2>&1`));
        return;
      }

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
      return appResource(
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
    await preflightEdge(withExtensionDomains(c), false);
    await deployApp(c, a);
    return;
  }
  throw new Error(`Unsupported operation: ${verb} ${resource}`);
}
