import { count,resourceContext } from "../../../shared/cli/resource-context";
import { type Request } from "../../../shared/cli/resource-request";
import { quote,remote } from "../../../shared/infrastructure/process";
import { configSchema,type Config } from "../../config/application/config";
import { saveManifest } from "../../config/infrastructure/save";
import { assertExtensionUnused } from "../application/bindings";
import { deployExtension } from "../application/deploy";
import { extensionFor,withExtensionDomains } from "../application/registry";
import { extensionProject,removeStateful } from "../application/stateful";
import { serviceSchema } from "../domain/service";
export async function extensionResource(r: Request, c: Config, state: string, original: string): Promise<void> {
  const { verb, resource, name, options } = r;
  const { inspect, dry, emit, needName, spec } = resourceContext(r, c.name);
  if (resource === "webhook") {
    const {legacyWebhookCommand}=await import('../infrastructure/templates/monitoring/cli');
    await legacyWebhookCommand(c,r,state,original,saveManifest);return;
  }
  if (resource === "extension") {
    if (inspect) {
      const e = name ? extensionFor(c, name) : undefined;
      if (name && !e) throw new Error("Extension not configured");
      emit(
        name
          ? { name, config: e!.spec?.(c) ?? c.extensions[name as keyof Config["extensions"]] }
          : c.extensions,
      );
      return;
    }
    needName();
    const ext = extensionFor(c, name!);
    // An unregistered name denotes a generic service extension instance;
    // existing services resolve through ext.spec as well.
    const isService = !ext || !!ext.spec;
    if (!ext && !["create", "update"].includes(verb))
      throw new Error("Unknown extension");
    if (isService && ["create", "update"].includes(verb)) {
      const parsed = serviceSchema.parse(await spec());
      const existing = c.extensions.services[name!];
      if ((verb === "create") === !!existing)
        throw new Error(
          "Use create for absent extensions and update for configured extensions",
        );
      if (existing && existing.dataPath !== parsed.dataPath)
        throw new Error(
          "Changing dataPath requires explicit stateful data migration; refusing implicit replacement",
        );
      const updated = configSchema.parse({
        ...c,
        extensions: {
          ...c.extensions,
          services: { ...c.extensions.services, [name!]: parsed },
        },
      });
      if (dry()) return;
      await deployExtension(updated, name!, state);
      await saveManifest(r.file, original, updated);
      return;
    }
    if (!ext) throw new Error("Unknown extension");
    if (!["create", "update", "delete", "reload", "logs"].includes(verb))
      throw new Error(`Unsupported extension operation: ${verb}`);
    if (["create", "update"].includes(verb)) {
      const configured = c.extensions[ext.name as keyof Config["extensions"]];
      if ((verb === "create") === !!configured)
        throw new Error(
          "Use create for absent extensions and update for configured extensions",
        );
      const updated = configSchema.parse({
        ...c,
        extensions: { ...c.extensions, [ext.name]: await spec() },
      });
      if (dry()) return;
      await deployExtension(updated, ext.name, state);
      await saveManifest(r.file, original, updated);
      return;
    }
    if (!ext.spec?.(c) && !c.extensions[ext.name as keyof Config["extensions"]])
      throw new Error("Extension not configured");
    if (verb === "logs") {
      const tail = count(options.tail ?? "100", 1, 10000, "--tail");
      const ctr = ext.logTarget?.(c) ?? extensionProject(c, ext.name);
      console.log(
        await remote(c, `docker logs --tail ${tail} ${quote(ctr)} 2>&1`),
      );
      return;
    }
    if (verb === "delete") assertExtensionUnused(c, ext.name);
    if (dry()) return;
    if (verb === "reload") {
      await deployExtension(c, ext.name, state);
      return;
    }
    if (ext.stateful) await removeStateful(c, ext);
    else await ext.remove!(withExtensionDomains(c));
    const remaining = { ...c.extensions };
    if (ext.spec)
      delete (remaining.services = { ...remaining.services })[ext.name];
    else delete remaining[ext.name as keyof Config["extensions"]];
    await saveManifest(
      r.file,
      original,
      configSchema.parse({ ...c, extensions: remaining }),
    );
    return;
  }
  if (resource === "postgres") {
    if(!c.extensions.postgres)throw new Error('App postgres is not installed');
    const {run}=await import('../infrastructure/templates/postgres/cli');
    const flags=Object.entries(options).filter(([key])=>key!=='file').flatMap(([key,value])=>[`--${key}`,value]);
    await run(c,inspect?'backups':verb,[...flags,...(r.apply?['--apply']:[])]);return;
  }
  if (resource === "recovery") throw new Error('Select the database app: app NAME recoveries or app NAME remove-recovery --recovery NAME');
  if (resource === "monitor" && inspect) {
    console.log(
      await remote(
        c,
        `set -euo pipefail\nprintf 'HOST\\n'; uptime; free -m; df -h -x tmpfs -x devtmpfs\nprintf '\\nCONTAINERS\\n'; docker stats --no-stream --format '{{json .}}'\nprintf '\\nRUNTIME HEALTH (first 200 lines)\\n'; head -n 200 /opt/2server/metrics/runtime.prom 2>/dev/null || true\nprintf '\\nLAST POSTGRES BACKUP\\n'; cat /opt/2server/backups/postgres-last-success 2>/dev/null || true\n${c.extensions.postgres?.backup ? `systemctl show two-${c.name}-postgres-backup.service -p Result -p ExecMainStatus -p ActiveState` : ""}`,
      ),
    );
    return;
  }
  throw new Error(`Unsupported operation: ${verb} ${resource}`);
}
