import { z } from "zod";
import { gcsBackupStorage, defaultBackupSchedule } from "./storage-config";
import { isIP } from "node:net";
import {
  name,
  hostname,
  envKey,
  path,
  backupCalendar,
  domainSchema,
  webhookSchema,
  envValue,
  secretsSchema,
  healthCheckSchema,
} from "./schema";
import { extensionRegistry } from "./extensions";
import { postgresSchema } from "./extensions/postgres";
import { redisSchema } from "./extensions/redis";
import { natsSchema } from "./extensions/nats";
import { monitoringSchema } from "./extensions/monitoring";
import { imageProxySchema } from "./extensions/image-proxy";
import { serviceSchema } from "./extensions/service";
export { domainSchema, webhookSchema };
export type { Webhook } from "./schema";
export const appSchema = z
  .object({
    name,
    kind: z.enum(["service", "worker"]).default("service"),
    image: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:\-]+@sha256:[a-f0-9]{64}$/),
    replicas: z.number().int().min(0).max(32).default(1),
    port: z.number().int().min(1).max(65535),
    healthPath: path.default("/healthz"),
    stopTimeoutSeconds: z.number().int().min(10).max(600).default(60),
    drainSeconds: z.number().int().min(0).max(3600).default(70),
    memoryMb: z.number().int().min(32).max(131072),
    cpus: z.number().positive().max(128),
    env: z.record(envKey, envValue).default({}),
    secrets: secretsSchema,
    command: z.array(z.string().refine((v) => !v.includes("\0"))).optional(),
    progressDeadlineSeconds: z.number().int().min(30).max(3600).default(240),
    capabilities: z.array(z.enum(['NET_BIND_SERVICE'])).default([]),
    healthCheck: healthCheckSchema.optional(),
    labels: z.record(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.\/-]*$/).refine(v => !v.startsWith('io.2server.') && !v.startsWith('com.docker.compose.')), z.string().refine(v => !/[\r\n\0]/.test(v))).default({}),
    instanceEnv: z.record(envKey, z.string().refine(v => !/[\r\n\0]/.test(v) && !/\$\{(?!generation\})/.test(v))).default({}),
    volumeMounts: z.array(z.object({name, mountPath:path, readOnly:z.boolean().default(false)}).strict()).default([]),
    preDeploy: z.object({
      command: z.array(z.string().min(1).refine(v => !v.includes("\0"))).min(1).max(64),
      timeoutSeconds: z.number().int().min(1).max(3600).default(300),
    }).strict().optional(),
    compose: z.object({
      generated: z.boolean().optional(),
      volumeBindings: z.record(name, z.object({blue:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/),green:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/)}).strict()).optional(),
      runtime: z.record(z.string(),z.unknown()).optional(),
      project: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
      sourceFiles: z.array(path).min(1).max(5).optional(),
      services: z.object({blue: name, green: name}).strict(),
      containers: z.object({blue: name, green: name}).strict(),
      upstreamFile: path,
      upstreamName: z.string().regex(/^up_[a-z0-9_-]+$/),
      gateTimeoutSeconds: z.number().int().min(30).max(3600).default(240),
      migrationRequired: z.boolean().default(false),
    }).strict().optional(),
  })
  .strict()
  .refine(a => Object.keys(a.instanceEnv).every(k => !(k in a.env) && !(k in a.secrets)), 'instanceEnv keys must not overlap env or secrets')
  .refine(a => new Set(a.volumeMounts.map(v => v.name)).size === a.volumeMounts.length && new Set(a.volumeMounts.map(v => v.mountPath)).size === a.volumeMounts.length, 'Volume names and mount paths must be unique')
  .refine(a => !a.compose || (a.kind === "service" && a.replicas === 1 && a.compose.services.blue !== a.compose.services.green && a.compose.containers.blue !== a.compose.containers.green), "Adopted Compose apps require one replica and distinct blue/green service/container names");
const diskSchema = z
  .object({
    name,
    provider: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("gcp"),
          project: name,
          zone: z.string().regex(/^[a-z0-9-]+$/),
          disk: name,
        })
        .strict(),
      z
        .object({
          kind: z.literal("aws"),
          region: z.string().regex(/^[a-z]+-[a-z]+-[0-9]+$/),
          volumeId: z.string().regex(/^vol-[a-f0-9]+$/),
          instanceId: z.string().regex(/^i-[a-f0-9]+$/),
        })
        .strict(),
    ]),
    // Existing mounted filesystems only. Provisioning new disks is Terraform's job.
    device: path.refine((v) => v.startsWith("/dev/")),
    mountPath: path.refine(
      (v) => v !== "/" && v !== "/opt/2server" && !v.endsWith("/"),
    ),
  })
  .strict();
export const sshSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ssh"),
      host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/),
      user: z.string().regex(/^[a-z_][a-z0-9_-]*$/),
      port: z.number().int().min(1).max(65535).default(22),
      identityFile: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("gcp"),
      instance: name,
      project: name,
      zone: z.string().regex(/^[a-z0-9-]+$/),
      iap: z.boolean().default(true),
    })
    .strict(),
]);

export const configSchema = z
  .object({
    version: z.literal(1),
    name,
    ssh: sshSchema,
    backupStorage: z.object({
      kind: z.literal("gcs"),
      storageClass: z.enum(["STANDARD", "NEARLINE", "COLDLINE", "ARCHIVE"]).default("STANDARD"),
      retentionDays: z.number().int().min(1).max(36500).default(7),
      schedule: backupCalendar.default(defaultBackupSchedule),
    }).strict().optional(),
    vm: z
      .object({
        kind: z.literal("aws"),
        region: z.string().regex(/^[a-z]+-[a-z]+-[0-9]+$/),
        instanceId: z.string().regex(/^i-[a-f0-9]+$/),
      })
      .strict()
      .optional(),
    disks: z.array(diskSchema).default([]),
    originIp: z
      .string()
      .refine((v) => isIP(v) === 4, "IPv4 origin address required")
      .optional(),
    edge: z
      .object({
        mode: z.enum(["existing", "managed"]),
        container: name.default("caddy"),
        network: name.default("edge"),
        configPath: path.default("/etc/caddy/Caddyfile"),
      })
      .strict(),
    cloudflare: z
      .object({
        tokenEnv: envKey.default("CLOUDFLARE_API_TOKEN"),
        originTokenEnv: envKey.default("CLOUDFLARE_API_TOKEN"),
      })
      .strict()
      .default({
        tokenEnv: "CLOUDFLARE_API_TOKEN",
        originTokenEnv: "CLOUDFLARE_API_TOKEN",
      }),
    domains: z.array(domainSchema).default([]),
    apps: z.array(appSchema).default([]),
    // One field per declared extension (src/extensions/), plus monitoring's
    // alert-receiver keys. Adding an extension = a registry entry in
    // src/extensions/index.ts plus one line here mounting its declared schema.
    extensions: z
      .object({
        postgres: postgresSchema.optional(),
        redis: redisSchema.optional(),
        nats: natsSchema.optional(),
        monitoring: monitoringSchema,
        alertWebhookEnv: envKey.optional(),
        webhooks: z.array(webhookSchema).max(20).default([]),
        imageProxy: imageProxySchema,
        // Generic single-container service extensions, keyed by instance name.
        services: z.record(name, serviceSchema).default({}),
      })
      .strict()
      .default({ monitoring: false, webhooks: [], services: {} }),
  })
  .strict()
  .superRefine((c, ctx) => {
    // Per-extension cross-field rules live in each declaration's validate().
    for (const ext of extensionRegistry) ext.validate?.(c, ctx);
    if (c.backupStorage) {
      try { gcsBackupStorage(c); }
      catch (error) {
        ctx.addIssue({ code: "custom", path: ["backupStorage"], message: (error as Error).message });
      }
    }
    if (
      c.edge.mode === "managed" &&
      c.edge.configPath !== "/etc/caddy/Caddyfile"
    )
      ctx.addIssue({
        code: "custom",
        message: "Managed edge configPath must be /etc/caddy/Caddyfile",
      });
    for (const values of [
      c.domains.map((d) => d.name),
      c.domains.flatMap((d) => d.hosts),
      c.apps.map((a) => a.name),
    ])
      if (new Set(values).size !== values.length)
        ctx.addIssue({
          code: "custom",
          message: "Duplicate domain name, hostname or app name",
        });
    if (c.vm && c.ssh.kind !== "ssh")
      ctx.addIssue({
        code: "custom",
        message: "AWS VM requires direct SSH configuration",
      });
    if (new Set(c.disks.map((d) => d.name)).size !== c.disks.length)
      ctx.addIssue({ code: "custom", message: "Duplicate disk name" });
    // A service instance name must not shadow a declared extension.
    for (const svc of Object.keys(c.extensions.services))
      if (extensionRegistry.some((e) => e.name === svc))
        ctx.addIssue({
          code: "custom",
          message: `Service ${svc} conflicts with a declared extension name`,
        });
    for (const svc of Object.keys(c.extensions.services)) {
      // A service container is named two-<server>-<svc>; refuse names that
      // collide with an app's container names (native two-<srv>-<app>-<color>[-N]
      // or an adopted Compose app's declared container names).
      for (const a of c.apps) {
        const collides = a.compose
          ? Object.values(a.compose.containers).includes(svc)
          : new RegExp(`^${a.name}-(blue|green)(-\\d+)?$`).test(svc) || svc === a.name;
        if (collides)
          ctx.addIssue({
            code: "custom",
            message: `Service ${svc} conflicts with an app container name`,
          });
      }
    }
    // Declared data paths must not nest or collide across extensions.
    const paths = [
      ...extensionRegistry.flatMap((e) => e.dataPaths?.(c) ?? []),
      ...Object.values(c.extensions.services)
        .map((s) => s.dataPath)
        .filter((p): p is string => !!p),
    ];
    if (
      paths.some(
        (p) =>
          p === "/" ||
          p === "/opt/2server" ||
          paths.some((q) => p !== q && p.startsWith(q + "/")),
      ) ||
      new Set(paths).size !== paths.length
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Stateful data paths must be distinct, non-overlapping directories",
      });
    for (const a of c.apps)
      for (const key of Object.keys(a.secrets))
        if (key in a.env)
          ctx.addIssue({
            code: "custom",
            message: `${a.name}: ${key} appears in both env and secrets`,
          });
  });
export type Config = z.infer<typeof configSchema>;
export type Domain = z.infer<typeof domainSchema>;
export type App = z.infer<typeof appSchema>;
export async function readConfig(file: string): Promise<Config> {
  return configSchema.parse(await Bun.file(file).json());
}
