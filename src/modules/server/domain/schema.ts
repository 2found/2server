import { z } from "zod";
import { name,path } from "../../../shared/domain/schema";
export const diskSchema = z
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
