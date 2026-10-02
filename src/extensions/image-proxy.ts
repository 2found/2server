import { z } from "zod";
import { envKey, image } from "../schema";
import type { Config } from "../config";
import { upload } from "../edge";
import { remote, quote } from "../process";
import { withExtensionDomains } from "./index";
import type { Extension } from "./types";

export const imageProxySchema = z
  .object({
    image: image.default('darthsim/imgproxy:v3.27.2'),
    allowedSources: z.array(z.string().url()).min(1),
    keyEnv: envKey,
    saltEnv: envKey,
  })
  .strict()
  .optional();

export const imageProxyExtension = {
  name: "imageProxy",
  cliName: "image-proxy",
  schema: imageProxySchema,
  template: {
    allowedSources: ["https://example.com/"],
    keyEnv: "IMGPROXY_KEY",
    saltEnv: "IMGPROXY_SALT",
  },
  scoped: (c) => ({
    monitoring: false,
    webhooks: [],
    imageProxy: c.extensions.imageProxy,
  }),
  logTarget: (c) => `two-${c.name}-imgproxy`,
  async deploy(c) {
    const ext = c.extensions.imageProxy!;
    const key = process.env[ext.keyEnv],
      salt = process.env[ext.saltEnv];
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
        imgproxy: {
          image: ext.image,
          container_name: `two-${c.name}-imgproxy`,
          restart: "unless-stopped",
          mem_limit: "256m",
          cpus: 0.5,
          security_opt: ["no-new-privileges:true"],
          cap_drop: ["ALL"],
          env_file: ["imgproxy.env"],
          networks: [c.edge.network],
          logging: {
            driver: "json-file",
            options: { "max-size": "10m", "max-file": "3" },
          },
        },
      },
      networks: { [c.edge.network]: { external: true } },
    };
    await upload(
      c,
      {
        "compose.json": JSON.stringify(compose),
        "imgproxy.env": `IMGPROXY_PATH_PREFIX=/i\nIMGPROXY_KEY=${key}\nIMGPROXY_SALT=${salt}\nIMGPROXY_ALLOWED_SOURCES=${sources.join(",")}\nIMGPROXY_ALLOW_LOOPBACK_SOURCE_ADDRESSES=false\nIMGPROXY_ALLOW_PRIVATE_SOURCE_ADDRESSES=false\nIMGPROXY_ALLOW_LINK_LOCAL_SOURCE_ADDRESSES=false\nIMGPROXY_MAX_SRC_RESOLUTION=25\nIMGPROXY_CONCURRENCY=2\nIMGPROXY_TTL=31536000\n`,
      },
      "/opt/2server/imgproxy",
    );
    await remote(
      c,
      "docker compose -p two-server-imgproxy -f /opt/2server/imgproxy/compose.json up -d",
    );
  },
  // `c` arrives normalized by withExtensionDomains (remove-domain ownership).
  async remove(c) {
    const target = `two-${c.name}-imgproxy`;
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
docker compose -p two-server-imgproxy -f /opt/2server/imgproxy/compose.json down`,
    );
  },
} satisfies Extension;
