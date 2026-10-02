import { z } from "zod";
import {
  envKey,
  bindingsSchema,
  envValue,
  healthCheckSchema,
  image,
  path,
  secretsSchema,
} from "../schema";
import type { Config } from "../config";
import type { Extension } from "./types";

// Generic service extensions: one instance per arbitrary name, declared as a
// `kind: Service` source document or `extensions.services.<name>` in the
// manifest. A service is one container on the edge network — no blue/green, no
// published ports, secrets resolved like apps. Lifecycle is the shared
// stateful engine: versioned release bundles, per-extension lock, ownership
// checks, compose up --wait with rollback. See docs/extensions.md.
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
  })
  .strict()
  .refine(s => Object.keys(s.bindings).every(k => !(k in s.env) && !(k in s.secrets)), 'Binding keys must not overlap env or secrets');
export type ServiceSpec = z.infer<typeof serviceSchema>;

export function serviceSpecOf(c: Config, svc: string): ServiceSpec | undefined {
  return (c.extensions.services ?? {})[svc];
}

// One Extension view per configured service, so the engines and CLI dispatch
// treat a named service exactly like a declared extension.
export function serviceExtension(svc: string, spec: ServiceSpec): Extension {
  return {
    name: svc,
    cliName: svc,
    schema: serviceSchema,
    template: {},
    outputs: spec.port ? { endpoint: { type: 'endpoint', protocol: 'http', port: spec.port } } : {},
    immutable: ["dataPath"],
    stateful: {
      async files(c, files, service) {
        const { resolveEnvMap } = await import("../apps");
        service.command = spec.command;
        service.healthcheck = spec.healthCheck
          ? {
              test: ["CMD", ...spec.healthCheck.command],
              interval: `${spec.healthCheck.intervalSeconds}s`,
              timeout: `${spec.healthCheck.timeoutSeconds}s`,
              start_period: `${spec.healthCheck.startPeriodSeconds}s`,
              retries: spec.healthCheck.failureThreshold,
            }
          : undefined;
        if (spec.dataPath) {
          service.user = "0:0";
          service.volumes = [`${spec.dataPath}:/data`];
        }
        // Environment lives inside compose.json, not an env_file: the engine
        // $-escapes compose.json, so secret values stay literal. An env_file
        // would let Compose interpolate/parse secret values and corrupt them.
        service.environment = await resolveEnvMap({
          name: svc,
          env: spec.env,
          secrets: spec.secrets,
          bindings: spec.bindings,
        }, c);
      },
    },
    spec: (c) => serviceSpecOf(c, svc),
  };
}
