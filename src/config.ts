import { z } from "zod";
import { gcsBackupStorage, defaultBackupSchedule } from "./storage-config";
import { isIP } from "node:net";

const name = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const hostname = z
  .string()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
const envKey = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
const path = z
  .string()
  .regex(/^\/[a-zA-Z0-9_./-]*$/)
  .refine((v) => !v.includes(".."));
const upstream = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("import"),
      name: z.string().regex(/^up_[a-z0-9_-]+$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal("proxy"),
      target: z.string().regex(/^[a-z0-9][a-z0-9.-]*:[0-9]{1,5}$/),
    })
    .strict(),
]);
const originCertificateSchema = z
  .object({
    scope: z.enum(["hosts", "zone"]).default("hosts"),
    validityDays: z
      .union([z.literal(365), z.literal(730), z.literal(1095), z.literal(5475)])
      .default(365),
  })
  .strict();
export const domainSchema = z
  .object({
    name,
    zone: hostname,
    hosts: z.array(hostname).min(1).max(50),
    routes: z
      .array(
        z
          .object({ prefix: path, strip: z.boolean().default(false), upstream })
          .strict(),
      )
      .default([]),
    upstream,
    cache: z.enum(["app", "images", "audio"]).default("app"),
    // DNS records are adopted only with an explicit manifest decision.
    adoptDns: z.boolean().default(false),
    requireAuth: z.boolean().default(false),
    certificate: originCertificateSchema.optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    for (const h of d.hosts)
      if (h !== d.zone && !h.endsWith(`.${d.zone}`))
        ctx.addIssue({ code: "custom", message: `${h} is outside ${d.zone}` });
    if (d.cache !== "app" && d.routes.length)
      ctx.addIssue({
        code: "custom",
        message: "Proxy cache presets have fixed path boundaries",
      });
  });
export const webhookSchema = z.object({
  name,
  provider: z.literal("discord"),
  urlEnv: envKey,
  enabled: z.boolean().default(true),
  sendResolved: z.boolean().default(true),
}).strict();
export type Webhook = z.infer<typeof webhookSchema>;
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
    env: z
      .record(
        envKey,
        z.string().refine((v) => !/[\r\n\0]/.test(v)),
      )
      .default({}),
    secrets: z
      .record(
        envKey,
        z.discriminatedUnion("provider", [
          z.object({ provider: z.literal("env"), key: envKey }).strict(),
          z
            .object({
              provider: z.literal("gcp"),
              project: name,
              secret: name,
              version: z
                .string()
                .regex(/^(latest|[0-9]+)$/)
                .default("latest"),
            })
            .strict(),
          z
            .object({
              provider: z.literal("aws"),
              id: z.string().regex(/^[a-zA-Z0-9/_+=.@:-]+$/),
              region: z.string().regex(/^[a-z]+-[a-z]+-[0-9]+$/),
            })
            .strict(),
        ]),
      )
      .default({}),
    command: z.array(z.string().refine((v) => !v.includes("\0"))).optional(),
    compose: z.object({
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
  .refine(a => !a.compose || (a.kind === "service" && a.replicas === 1 && a.compose.services.blue !== a.compose.services.green && a.compose.containers.blue !== a.compose.containers.green), "Adopted Compose apps require one replica and distinct blue/green service/container names");
const databaseName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const image = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]+$/);
const backupCalendar = z.string().min(1).max(128).regex(/^[a-zA-Z0-9*,:. \/+-]+$/);
export const postgresSchema = z
  .object({
    image: image
      .refine(
        (v) =>
          /^postgres:18(?:\.[0-9]+)?(?:-[a-z0-9.-]+)?(?:@sha256:[a-f0-9]{64})?$/.test(
            v,
          ),
        "PostgreSQL images must pin major 18; major upgrades need an explicit migration",
      )
      .default("postgres:18.6-bookworm"),
    database: databaseName.default("app"),
    username: databaseName.default("app"),
    passwordEnv: envKey,
    adminPasswordEnv: envKey.default("POSTGRES_ADMIN_PASSWORD"),
    migrationPasswordEnv: envKey.default("POSTGRES_MIGRATION_PASSWORD"),
    memoryMb: z.number().int().min(256).max(131072).default(512),
    cpus: z.number().positive().max(128).default(1),
    dataPath: path.default("/opt/2server/data/postgres"),
    disk: name.optional(),
    backup: z
      .object({
        engine: z.enum(["pgbackrest", "dump"]).default("pgbackrest"),
        fullIntervalHours: z.number().int().min(1).max(168).default(24),
        retentionDays: z.number().int().min(1).max(36500).optional(),
        restoreCheckSchedule: backupCalendar.default("Sun *-*-* 03:00:00 UTC"),
        maxAgeHours: z.number().int().min(1).max(8760).default(26),
        restoreCheckMaxAgeHours: z.number().int().min(1).max(8760).default(192),
        destination: z
          .string()
          .regex(
            /^(gs|s3):\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\/[a-zA-Z0-9_/-]+$/,
          )
          .refine((v) => !v.includes("..") && !v.endsWith("/"))
          .optional(),
        // systemd calendar: single-line and no unit-file specifier expansion.
        schedule: backupCalendar.optional(),
        region: z
          .string()
          .regex(/^[a-z]+-[a-z]+-[0-9]+$/)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
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
    extensions: z
      .object({
        postgres: postgresSchema.optional(),
        redis: redisSchema.optional(),
        nats: natsSchema.optional(),
        monitoring: z
          .union([
            z.boolean(),
            z
              .object({
                zone: hostname.optional(),
                hostname: hostname.optional(),
                username: z
                  .string()
                  .regex(/^[a-zA-Z0-9_-]{1,64}$/)
                  .default("admin"),
                passwordEnv: envKey.optional(),
                adoptDns: z.boolean().default(false),
                containers: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/)).max(100).optional(),
                upstreams: z.array(z.object({
                  name,
                  file: path,
                  healthPath: path.default("/healthz"),
                }).strict()).max(100).optional(),
              })
              .strict(),
          ])
          .default(false),
        alertWebhookEnv: envKey.optional(),
        webhooks: z.array(webhookSchema).max(20).default([]),
        imageProxy: z
          .object({
            allowedSources: z.array(z.string().url()).min(1),
            keyEnv: envKey,
            saltEnv: envKey,
          })
          .strict()
          .optional(),
      })
      .strict()
      .default({ monitoring: false, webhooks: [] }),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (new Set(c.extensions.webhooks.map(w => w.name)).size !== c.extensions.webhooks.length)
      ctx.addIssue({ code: "custom", message: "Webhook names must be unique" });
    const postgres = c.extensions.postgres;
    if (postgres) {
      if (["two_admin", "two_migrator", "two_owner", "postgres"].includes(postgres.username))
        ctx.addIssue({ code: "custom", message: "PostgreSQL application username is reserved" });
      if (new Set([postgres.passwordEnv, postgres.adminPasswordEnv, postgres.migrationPasswordEnv]).size !== 3)
        ctx.addIssue({ code: "custom", message: "PostgreSQL app, admin and migration secrets must be distinct" });
      if (postgres.backup?.engine === "pgbackrest" && !postgres.image.includes("-bookworm"))
        ctx.addIssue({ code: "custom", message: "pgBackRest requires the PostgreSQL 18 bookworm image" });
    }
    if (c.backupStorage) {
      try { gcsBackupStorage(c); }
      catch (error) {
        ctx.addIssue({ code: "custom", path: ["backupStorage"], message: (error as Error).message });
      }
    }
    if (c.extensions.postgres?.backup && !c.extensions.postgres.backup.destination && !c.backupStorage)
      ctx.addIssue({ code: "custom", message: "PostgreSQL backup requires destination or server backupStorage" });
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
    if (c.extensions.monitoring) {
      const m =
        typeof c.extensions.monitoring === "object"
          ? c.extensions.monitoring
          : undefined;
      const zones = [...new Set(c.domains.map((d) => d.zone))];
      const zone = m?.zone ?? (zones.length === 1 ? zones[0] : undefined);
      if (!zone)
        ctx.addIssue({
          code: "custom",
          message:
            "Monitoring requires an explicit zone when the manifest has zero or multiple zones",
        });
      else {
        const host = m?.hostname ?? `monitor.${zone}`;
        if (host !== zone && !host.endsWith(`.${zone}`))
          ctx.addIssue({
            code: "custom",
            message: "Monitoring hostname must belong to its zone",
          });
        if (!hostname.safeParse(host).success)
          ctx.addIssue({
            code: "custom",
            message: "Invalid monitoring hostname",
          });
        if (
          c.domains.some(
            (d) => d.name === "two-server-monitoring" || d.hosts.includes(host),
          )
        )
          ctx.addIssue({
            code: "custom",
            message:
              "Monitoring hostname/name conflicts with a declared domain",
          });
      }
    }
    if (c.vm && c.ssh.kind !== "ssh")
      ctx.addIssue({
        code: "custom",
        message: "AWS VM requires direct SSH configuration",
      });
    if (new Set(c.disks.map((d) => d.name)).size !== c.disks.length)
      ctx.addIssue({ code: "custom", message: "Duplicate disk name" });
    const pg = c.extensions.postgres;
    if (pg?.disk) {
      const d = c.disks.find((d) => d.name === pg.disk);
      if (!d || !pg.dataPath.startsWith(d.mountPath + "/"))
        ctx.addIssue({
          code: "custom",
          message:
            "PostgreSQL dataPath must be below its declared disk mountPath",
        });
    }
    const paths = [
      pg?.dataPath,
      c.extensions.redis?.dataPath,
      c.extensions.nats?.dataPath,
    ].filter((p): p is string => !!p);
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
