import { z } from "zod";
import { bindingsSchema,envKey,envValue,healthCheckSchema,name,path,secretsSchema } from "../../../shared/domain/schema";
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
    bindings: bindingsSchema,
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
  .refine(a => Object.keys(a.instanceEnv).every(k => !(k in a.env) && !(k in a.secrets) && !(k in a.bindings)), 'instanceEnv keys must not overlap env, secrets or bindings')
  .refine(a => Object.keys(a.bindings).every(k => !(k in a.env) && !(k in a.secrets)), 'Binding keys must not overlap env or secrets')
  .refine(a => new Set(a.volumeMounts.map(v => v.name)).size === a.volumeMounts.length && new Set(a.volumeMounts.map(v => v.mountPath)).size === a.volumeMounts.length, 'Volume names and mount paths must be unique')
  .refine(a => !a.compose || (a.kind === "service" && a.replicas === 1 && a.compose.services.blue !== a.compose.services.green && a.compose.containers.blue !== a.compose.containers.green), "Adopted Compose apps require one replica and distinct blue/green service/container names");
export type App = z.infer<typeof appSchema>;
