import { z } from "zod";

// Shared validation primitives for the manifest schema and extension
// declarations. This module must stay a leaf: importing config.ts here would
// reintroduce the config ↔ extensions cycle it exists to break.
export const name = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
export const hostname = z
  .string()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
export const envKey = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
export const path = z
  .string()
  .regex(/^\/[a-zA-Z0-9_./-]*$/)
  .refine((v) => !v.includes(".."));
export const image = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]+$/);
export const databaseName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
export const backupCalendar = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9*,:. \/+-]+$/);
export const webhookSchema = z.object({
  name,
  provider: z.literal("discord"),
  urlEnv: envKey,
  enabled: z.boolean().default(true),
  sendResolved: z.boolean().default(true),
}).strict();
export const envValue = z.string().refine((v) => !/[\r\n\0]/.test(v));
export const secretsSchema = z
  .record(
    envKey,
    z.discriminatedUnion("provider", [
      z.object({ provider: z.literal("env"), key: envKey }).strict(),
      z.object({ provider: z.literal("vm"), key: envKey }).strict(),
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
  .default({});
export const healthCheckSchema = z.object({
  command: z.array(z.string().min(1).refine(v => !v.includes("\0"))).min(1),
  intervalSeconds: z.number().int().min(1).max(3600).default(30),
  timeoutSeconds: z.number().int().min(1).max(300).default(5),
  startPeriodSeconds: z.number().int().min(0).max(3600).default(60),
  failureThreshold: z.number().int().min(1).max(100).default(3),
}).strict();
export type Webhook = z.infer<typeof webhookSchema>;

export const bindingsSchema = z.record(envKey, z.object({
  app: name.optional(),
  extension: name.optional(), // Legacy source spelling.
  output: z.string().regex(/^[a-z][a-zA-Z0-9-]{0,63}$/),
}).strict().refine(v=>!!v.app!==!!v.extension,'Specify exactly one app binding target').transform(v=>({extension:v.app??v.extension!,output:v.output}))).default({});
export type Bindings = z.infer<typeof bindingsSchema>;
