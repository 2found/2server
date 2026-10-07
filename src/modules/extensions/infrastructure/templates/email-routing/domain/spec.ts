import { z } from 'zod';

const email = z.email().max(90).transform(value => value.toLowerCase());
export const emailRoutingSpecSchema = z.object({
  accountId: z.string().regex(/^[0-9a-f]{32}$/).optional(),
  zone: z.string().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/),
  manageTokenPermissions: z.boolean().default(false),
  createZoneTokenPolicy: z.boolean().default(false),
  replaceMx: z.array(z.object({content:z.string().regex(/^(?:[a-z0-9-]+\.)+[a-z]{2,}\.?$/),priority:z.number().int().min(0).max(65535)}).strict()).max(10).default([]),
  routes: z.array(z.object({
    address: email,
    destination: email,
    enabled: z.boolean().default(true),
  }).strict()).min(1).max(200),
}).strict().superRefine((spec, ctx) => {
  if(spec.createZoneTokenPolicy&&(!spec.manageTokenPermissions||!spec.accountId))
    ctx.addIssue({code:'custom',path:['createZoneTokenPolicy'],message:'Creating a zone token policy requires manageTokenPermissions and an explicit accountId'});
  const seen = new Set<string>();
  spec.routes.forEach((route, index) => {
    if (route.address.split('@')[1] !== spec.zone)
      ctx.addIssue({code:'custom', path:['routes', index, 'address'], message:'Address must belong to the configured zone apex'});
    if (route.destination.split('@')[1] === spec.zone)
      ctx.addIssue({code:'custom', path:['routes', index, 'destination'], message:'Forward to an external inbox to avoid routing loops'});
    if (seen.has(route.address))
      ctx.addIssue({code:'custom', path:['routes', index, 'address'], message:'Duplicate routing address'});
    seen.add(route.address);
  });
});
export type EmailRoutingSpec = z.infer<typeof emailRoutingSpecSchema>;
