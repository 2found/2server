import { count,resourceContext } from "../../../shared/cli/resource-context";
import { type Request } from "../../../shared/cli/resource-request";
import { remote } from "../../../shared/infrastructure/process";
import { type Config } from "../../config/application/config";
import { provisionBackupStorage } from "../application/backup-storage";
import { gcsBackupStorage } from "../domain/storage";
import { initializeDisk,inspectDisk,resizeDisk,vmAction } from "../infrastructure/vm";
export async function serverResource(r: Request, c: Config, state: string, original: string): Promise<void> {
  const { verb, resource, name, options } = r;
  const { inspect, dry, emit, needName, spec } = resourceContext(r, c.name);
  if (resource === "backup-storage") {
    if (inspect) emit(gcsBackupStorage(c));
    else if (["create", "update"].includes(verb))
      await provisionBackupStorage(c, r.apply, state);
    else throw new Error("Backup storage supports get/create/update; bucket destruction is protected");
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
  throw new Error(`Unsupported operation: ${verb} ${resource}`);
}
