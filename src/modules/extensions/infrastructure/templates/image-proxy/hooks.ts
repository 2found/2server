import { quote,remote } from "../../../../../shared/infrastructure/process";
import { upload } from "../../../../domains/infrastructure/edge";
import { instanceSecret } from '../../../application/instance';
import { withExtensionDomains } from "../../../application/registry";
import { extensionProject } from '../../../application/stateful';
import { renderDeclaration } from "../../../domain/declaration";
import { instanceRoot } from '../../../domain/instance';
import type { ExtensionHooks } from "../../../domain/types";
import { catalogDefinition } from "../../catalog";

const definition = catalogDefinition("image-proxy");
export const imageProxyHooks = {
  async deploy(c) {
    const ext = c.extensions.imageProxy!;
    const key = instanceSecret(c,ext.keyEnv),
      salt = instanceSecret(c,ext.saltEnv);
    if (
      !key ||
      !salt ||
      ![key, salt].every((v) => /^(?:[a-f0-9]{2}){32,}$/.test(v))
    )
      throw new Error(
        "imgproxy key/salt must be hex secrets of at least 32 bytes",
      );
    const sources = ext.allowedSources;
    if (
      sources.some((s) => {
        const u = new URL(s);
        return (
          u.protocol !== "https:" ||
          !!u.username ||
          !!u.password ||
          !!u.search ||
          !!u.hash ||
          !s.endsWith("/") ||
          /[\n\r,]/.test(s)
        );
      })
    )
      throw new Error(
        "imgproxy sources must be HTTPS path prefixes ending in /, without credentials or query strings",
      );
    const compose = {
      services: {
        [c.instance?extensionProject(c,"imgproxy"):"imgproxy"]: renderDeclaration(definition.service, {spec:ext,server:{...c,name:c.instance?`${c.name}-${c.instance.name}`:c.name},edge:c.edge}),
      },
      networks: { [c.edge.network]: { external: true } },
    };
    await upload(
      c,
      {
        "compose.json": JSON.stringify(compose),
        "imgproxy.env": Object.entries({
          ...definition.settings.environment,
          IMGPROXY_KEY:key, IMGPROXY_SALT:salt, IMGPROXY_ALLOWED_SOURCES:sources.join(","),
        }).map(([name,value]) => `${name}=${value}`).join("\n") + "\n",
      },
      instanceRoot(c,"/opt/2server/imgproxy"),
    );
    await remote(
      c,
      `docker compose -p ${c.instance?extensionProject(c,"imageProxy"):"two-server-imgproxy"} -f ${instanceRoot(c,"/opt/2server/imgproxy")}/compose.json up -d --wait --wait-timeout 150`,
    );
  },
  // `c` arrives normalized by withExtensionDomains (remove-domain ownership).
  async remove(c) {
    const target = extensionProject(c,"imgproxy");
    if (
      withExtensionDomains(c).domains.some((d) =>
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
    await remote(
      c,
      `test "$(cat /opt/2server/edge/owner)" = ${quote(c.name)}
docker compose -p ${c.instance?extensionProject(c,"imageProxy"):"two-server-imgproxy"} -f ${instanceRoot(c,"/opt/2server/imgproxy")}/compose.json down`,
    );
  },
} satisfies ExtensionHooks;
