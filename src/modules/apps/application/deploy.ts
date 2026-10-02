import { remote } from "../../../shared/infrastructure/process";
import { type Config } from "../../config/application/config";
import { upload } from "../../domains/infrastructure/edge";
import { assertBindingsReady } from "../../extensions/application/bindings";
import { appSchema,type App } from "../domain/schema";
import { deployCompose,rollbackCompose } from "../infrastructure/compose";
import { deployScript,rollbackScript } from "../infrastructure/runtime";
import { resolveEnv } from "./environment";
export async function deployApp(c: Config, a: App) {
  if (a.replicas) await assertBindingsReady(c, a.bindings);
  if (a.compose) return deployCompose(c,a,await resolveEnv(a, c));
  const oldKind = await remote(
    c,
    `if [ -f /opt/2server/apps/${a.name}/current ]; then color=$(cat /opt/2server/apps/${a.name}/current); jq -r '.kind // "service"' /opt/2server/apps/${a.name}/$color.json; fi`,
  );
  if (oldKind.trim() && oldKind.trim() !== a.kind)
    throw new Error(
      "Changing a workload between service and worker requires a new app name",
    );
  const release = crypto.randomUUID();
  await upload(
    c,
    {
      "app.env": a.replicas ? await resolveEnv(a, c) : "\n",
      "app.json": JSON.stringify(a),
    },
    `/opt/2server/apps/${a.name}/releases/${release}`,
  );
  await remote(c, deployScript(c, a, release));
}
export async function rollbackApp(c: Config, a: App) {
  if (a.compose) return rollbackCompose(c,a);
  const root = `/opt/2server/apps/${a.name}`;
  const previous = await remote(
    c,
    `set -euo pipefail; color=$(cat ${root}/previous); case "$color" in blue|green) cat ${root}/$color.json;; *) exit 1;; esac`,
  );
  const prior = appSchema.parse(JSON.parse(previous));
  await remote(c, rollbackScript(c, a, prior, previous));
  return prior;
}
