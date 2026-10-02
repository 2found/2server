import { z } from "zod";
import { envKey, image, path } from "../schema";
import { extensionProject, requiredSecret } from "../stateful";
import type { Extension } from "./types";

export const redisSchema = z
  .object({
    image: image.default("redis:8.2-alpine"),
    passwordEnv: envKey,
    memoryMb: z.number().int().min(64).max(131072).default(256),
    maxmemoryMb: z.number().int().min(16).default(128),
    appendfsync: z.enum(["everysec", "always"]).default("everysec"),
    cpus: z.number().positive().max(128).default(0.5),
    dataPath: path.default("/opt/2server/data/redis"),
  })
  .strict()
  .refine(
    (v) => v.maxmemoryMb <= v.memoryMb * 0.5,
    "Redis maxmemory must leave at least 50% container overhead for AOF rewrite",
  );

export const redisExtension = {
  name: "redis",
  schema: redisSchema.optional(),
  template: { passwordEnv: "REDIS_PASSWORD" },
  immutable: ["dataPath", "disk", "database", "username"],
  scoped: (c) => ({ redis: c.extensions.redis }),
  dataPaths: (c) => (c.extensions.redis ? [c.extensions.redis.dataPath] : []),
  stateful: {
    files(c, files, service) {
      const r = c.extensions.redis!;
      files["password"] = requiredSecret(r.passwordEnv);
      files["redis.conf"] =
        `bind 0.0.0.0\nprotected-mode yes\nport 6379\nrequirepass ${JSON.stringify(requiredSecret(r.passwordEnv))}\nappendonly yes\nappendfsync ${r.appendfsync}\nno-appendfsync-on-rewrite no\naof-load-truncated no\nsave ""\ntcp-keepalive 60\ndir /data\nmaxmemory ${r.maxmemoryMb}mb\nmaxmemory-policy noeviction\n`;
      // The official entrypoint switches to redis after the root-only input is copied.
      service.entrypoint = [
        "sh",
        "-ec",
        "chown redis:redis /data; chmod 700 /data; cp /run/secrets/redis.conf /data/redis.conf; chown redis:redis /data/redis.conf; exec /usr/local/bin/docker-entrypoint.sh redis-server /data/redis.conf",
      ];
      service.volumes = [
        `${r.dataPath}:/data`,
        "./redis.conf:/run/secrets/redis.conf:ro",
        "./password:/run/secrets/redis-password:ro",
      ];
      // Readiness must authenticate and detect failed persistence, not just a listener.
      service.healthcheck = {
        test: ["CMD-SHELL", 'export REDISCLI_AUTH=$(cat /run/secrets/redis-password); test "$(redis-cli ping)" = PONG && redis-cli --raw INFO persistence | tr -d "\\r" | grep -qx aof_last_write_status:ok'],
        interval: "5s",
        timeout: "3s",
        retries: 24,
      };
    },
    prepareHost: () =>
      `printf 'vm.overcommit_memory=1\n' > /etc/sysctl.d/60-2server-redis.conf
sysctl -q -p /etc/sysctl.d/60-2server-redis.conf`,
    verify: (c) =>
      `docker exec ${extensionProject(c, "redis")} sh -ec 'export REDISCLI_AUTH=$(cat /run/secrets/redis-password); redis-cli ping | grep -qx PONG'`,
  },
} satisfies Extension;
