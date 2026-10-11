import { z } from "zod";
import { hostname,name,path } from "../../../shared/domain/schema";
export const upstream = z.discriminatedUnion("kind", [
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
    // Readiness path the origin and public checks expect 2xx/3xx from; for API
    // origins that serve nothing at "/". Defaults to "/".
    healthPath: path.optional(),
    // Drop the edge's X-Frame-Options DENY so an embeddable widget can be
    // framed; the upstream must send its own CSP frame-ancestors allowlist.
    allowFraming: z.boolean().optional(),
    // DNS records are adopted only with an explicit manifest decision.
    adoptDns: z.boolean().default(false),
    requireAuth: z.boolean().default(false),
    certificate: z
      .object({
        scope: z.enum(["hosts", "zone"]).default("hosts"),
        validityDays: z
          .union([z.literal(365), z.literal(730), z.literal(1095), z.literal(5475)])
          .default(365),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    for (const h of d.hosts)
      if (h !== d.zone && !h.endsWith(`.${d.zone}`))
        ctx.addIssue({ code: "custom", message: `${h} is outside ${d.zone}` });
    if (d.healthPath && (d.cache !== "app" || d.requireAuth))
      ctx.addIssue({
        code: "custom",
        message: "healthPath applies only to app domains without requireAuth",
      });
    if (d.allowFraming && (d.cache !== "app" || d.requireAuth))
      ctx.addIssue({
        code: "custom",
        message: "allowFraming applies only to app domains without requireAuth",
      });
    if (d.cache !== "app" && d.routes.length)
      ctx.addIssue({
        code: "custom",
        message: "Proxy cache presets have fixed path boundaries",
      });
  });
export type Domain = z.infer<typeof domainSchema>;
