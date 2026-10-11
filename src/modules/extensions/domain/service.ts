import { z } from "zod";
import {
bindingsSchema,
envKey,
envValue,
healthCheckSchema,
image,
path,
secretsSchema,
} from "../../../shared/domain/schema";

export const serviceSchema = z
  .object({
    image,
    memoryMb: z.number().int().min(32).max(131072).default(256),
    cpus: z.number().positive().max(128).default(0.5),
    env: z.record(envKey, envValue).default({}),
    secrets: secretsSchema,
    bindings: bindingsSchema,
    command: z.array(z.string().refine((v) => !v.includes("\0"))).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    healthCheck: healthCheckSchema.optional(),
    // A writable host directory mounted at /data. Omit for ephemeral services.
    dataPath: path.optional(),
    // Opt-in hardening; each field maps to one Compose key.
    user: z.string().regex(/^\d{1,10}:\d{1,10}$/, 'user must be numeric UID:GID').optional(),
    readOnly: z.boolean().optional(),
    capDropAll: z.boolean().optional(),
    pidsLimit: z.number().int().min(16).max(32768).optional(),
  })
  .strict()
  .refine(s => Object.keys(s.bindings).every(k => !(k in s.env) && !(k in s.secrets)), 'Binding keys must not overlap env or secrets');
export type ServiceSpec = z.infer<typeof serviceSchema>;
