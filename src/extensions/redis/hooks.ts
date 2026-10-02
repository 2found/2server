import { extensionProject, requiredSecret } from "../../stateful";
import type { ExtensionHooks } from "../types";
import type { ExtensionSpecs } from "../specs.generated";
import {catalogDefinition,renderDeclaration} from "../catalog";

const definition = catalogDefinition("redis");
export const redisHooks = {
  refineSpec(value, ctx) {
    const r = value as NonNullable<ExtensionSpecs["redis"]>;
    if (r.maxmemoryMb > r.memoryMb * 0.5)
      ctx.addIssue({code:"custom", message:"Redis maxmemory must leave at least 50% container overhead for AOF rewrite"});
  },
  stateful: {
    files(c, files, service) {
      const r = c.extensions.redis!;
      files["password"] = requiredSecret(r.passwordEnv,c);
      const config = renderDeclaration(definition.settings.config, {spec:r,server:c,edge:c.edge});
      config.requirepass = JSON.stringify(requiredSecret(r.passwordEnv,c));
      config.maxmemory = `${r.maxmemoryMb}mb`;
      files["redis.conf"] = Object.entries(config).map(([key,value]) => `${key} ${value}`).join("\n") + "\n";
    },
    prepareHost: () =>
      `printf 'vm.overcommit_memory=1\n' > /etc/sysctl.d/60-2server-redis.conf
sysctl -q -p /etc/sysctl.d/60-2server-redis.conf`,
    verify: (c) =>
      `docker exec ${extensionProject(c, "redis")} sh -ec 'export REDISCLI_AUTH=$(cat /run/secrets/redis-password); redis-cli ping | grep -qx PONG'`,
  },
} satisfies ExtensionHooks;
