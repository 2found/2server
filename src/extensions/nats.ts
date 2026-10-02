import { z } from "zod";
import { envKey, image, path } from "../schema";
import { extensionProject, requiredSecret } from "../stateful";
import type { Extension } from "./types";

export const natsSchema = z
  .object({
    image: image.default("nats:2.11-alpine"),
    tokenEnv: envKey,
    jetstream: z.boolean().default(false),
    syncInterval: z.union([z.literal("always"), z.string().regex(/^[1-9][0-9]*(ms|s)$/)]).default("always"),
    maxConnections: z.number().int().min(1).max(1000000).default(1024),
    maxPayloadKb: z.number().int().min(1).max(8192).default(1024),
    memoryMb: z.number().int().min(64).max(131072).default(256),
    cpus: z.number().positive().max(128).default(0.5),
    maxMemoryMb: z.number().int().min(16).default(64),
    maxFileGb: z.number().int().min(1).max(65536).default(5),
    dataPath: path.default("/opt/2server/data/nats"),
  })
  .strict()
  .refine(
    (v) => v.maxMemoryMb <= v.memoryMb * 0.5,
    "JetStream memory must leave at least 50% container overhead",
  );

export const natsExtension = {
  name: "nats",
  schema: natsSchema.optional(),
  template: { tokenEnv: "NATS_TOKEN", jetstream: true },
  immutable: ["dataPath", "disk", "database", "username"],
  scoped: (c) => ({ nats: c.extensions.nats }),
  dataPaths: (c) => (c.extensions.nats ? [c.extensions.nats.dataPath] : []),
  stateful: {
    files(c, files, service) {
      const n = c.extensions.nats!;
      files["nats.conf"] = JSON.stringify({
        server_name: extensionProject(c, "nats"),
        port: 4222,
        max_connections: n.maxConnections,
        max_payload: n.maxPayloadKb * 1024,
        max_pending: 8 * 1024 * 1024,
        write_deadline: "10s",
        http: "127.0.0.1:8222",
        authorization: { token: requiredSecret(n.tokenEnv) },
        ...(n.jetstream
          ? {
              jetstream: {
                store_dir: "/data/jetstream",
                sync_interval: n.syncInterval,
                max_memory_store: n.maxMemoryMb * 1024 * 1024,
                max_file_store: n.maxFileGb * 1024 ** 3,
              },
            }
          : {}),
      });
      service.user = "0:0";
      service.cap_drop = ["ALL"];
      service.command = ["-c", "/etc/nats/nats.conf"];
      service.volumes = [
        `${n.dataPath}:/data`,
        "./nats.conf:/etc/nats/nats.conf:ro",
      ];
      service.healthcheck = {
        test: [
          "CMD-SHELL",
          `wget -T 2 -qO- 'http://127.0.0.1:8222/healthz${n.jetstream ? "?js-enabled-only=true" : ""}' >/dev/null`,
        ],
        interval: "5s",
        timeout: "3s",
        retries: 24,
      };
    },
  },
} satisfies Extension;
