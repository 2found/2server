import { isIP } from "node:net";
import { z } from "zod";
import { backupCalendar,envKey,name,path,webhookSchema } from "../../../shared/domain/schema";
import { appSchema } from "../../apps/domain/schema";
import { domainSchema } from "../../domains/domain/schema";
import { validateBindings } from "../../extensions/application/bindings";
import { enabledExtensions,extensionForCliName,extensionRegistry,extensionSchemas } from "../../extensions/application/registry";
import type { InstanceContext } from '../../extensions/domain/instance';
import { instanceConfig } from '../../extensions/domain/instance';
import { serviceSchema } from "../../extensions/domain/service";
import { diskSchema,sshSchema } from "../../server/domain/schema";
import { defaultBackupSchedule,gcsBackupStorage } from "../../server/domain/storage";
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
    extensionApps: z.record(name,z.object({
      template:name, spec:z.record(z.string(),z.unknown()),
      secrets:z.record(envKey,z.object({provider:z.literal('vm'),key:envKey}).strict()).default({}),
      webhooks:z.array(webhookSchema).default([]),
    }).strict()).default({}),
    // All definition schemas are mounted automatically. The remaining keys
    // are manifest-level receiver settings and arbitrary Service instances.
    // Native hooks import config types/helpers; defer catalog access until parsing.
    extensions: z.lazy(() => z
      .object({
        ...extensionSchemas,
        alertWebhookEnv: envKey.optional(),
        webhooks: z.array(webhookSchema).max(20).default([]),
        // Generic single-container service extensions, keyed by instance name.
        services: z.record(name, serviceSchema).default({}),
      })
      .strict()
      .default({ monitoring: false, webhooks: [], services: {} })),
  })
  .strict()
  .superRefine((c, ctx) => {
    for(const [app,entry] of Object.entries(c.extensionApps)) {
      const ext=extensionForCliName(entry.template);
      if(!ext){ctx.addIssue({code:'custom',message:`Unknown template ${entry.template}`});continue;}
      const parsed=ext.schema.safeParse(entry.spec);
      if(!parsed.success||!parsed.data||typeof parsed.data!=='object'){ctx.addIssue({code:'custom',message:`Invalid template spec for ${app}`});continue;}
      entry.spec={...(parsed.data as Record<string,unknown>),...(!("dataPath" in entry.spec)&&(parsed.data as Record<string,unknown>).dataPath?{dataPath:`/opt/2server/data/${app}`}:{})};
      if(c.apps.some(a=>a.name===app)||c.extensions.services[app]||(c.extensions as Record<string,unknown>)[app])ctx.addIssue({code:'custom',message:`Duplicate app name ${app}`});
      if(!ext.acceptsWebhooks&&entry.webhooks.length)ctx.addIssue({code:'custom',message:'This template does not accept webhooks'});
      ext.validate?.(instanceConfig(c as Config,app,ext,entry),ctx);
    }

    try { validateBindings(c); }
    catch (error) { ctx.addIssue({ code: 'custom', message: (error as Error).message }); }
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
      if (extensionRegistry.some((e) => (e.name === svc || e.cliName === svc)))
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
      ...enabledExtensions(c as Config).flatMap((e) => e.dataPaths?.(c as Config) ?? []),
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
    // Include generated routes: two template instances must not claim one host.
    const published = enabledExtensions(c as Config).flatMap(e => {
      try { return e.domains?.(c as Config) ?? []; } catch { return []; } // validate() reports invalid settings.
    });
    for (const values of [published.map(d => d.name), published.flatMap(d => d.hosts)])
      if (new Set(values).size !== values.length)
        ctx.addIssue({code:'custom',message:'Template apps must have distinct domain names and hostnames'});
    const containers=enabledExtensions(c as Config).flatMap(e=>e.containers?.(c as Config)??[`two-${c.name}-${e.name}`]);
    if(new Set(containers).size!==containers.length || containers.includes(c.edge.container) || c.apps.some(a=>containers.some(n=>a.compose
      ? Object.values(a.compose.containers).includes(n)
      : new RegExp(`^two-${c.name}-${a.name}-(blue|green)(-\\d+)?$`).test(n))))
      ctx.addIssue({code:'custom',message:'Template app containers must not conflict with another app or edge'});
    const identities=[...c.apps.map(a=>a.name),...enabledExtensions(c as Config).map(e=>e.name)];
    if(new Set(identities).size!==identities.length)ctx.addIssue({code:'custom',message:'App names must be unique across images and templates'});
    const destinations=enabledExtensions(c as Config).flatMap(e=>{
      const spec=(e.spec?.(c as Config)??(c.extensions as Record<string,unknown>)[e.name]) as {backup?:{destination?:string}}|undefined;
      return spec?.backup?.destination?[spec.backup.destination]:[];
    });
    if(new Set(destinations).size!==destinations.length)ctx.addIssue({code:'custom',message:'Template apps must not share a backup destination'});
    for (const a of c.apps)
      for (const key of Object.keys(a.secrets))
        if (key in a.env)
          ctx.addIssue({
            code: "custom",
            message: `${a.name}: ${key} appears in both env and secrets`,
          });
  });
export type Config = z.infer<typeof configSchema> & {instance?:InstanceContext};
