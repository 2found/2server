import { z } from "zod";
import { webhookSchema } from "../../../shared/domain/schema";
import { imageReference } from "../../apps/domain/image";
import { appSchema } from "../../apps/domain/schema";
import { domainSchema } from "../../domains/domain/schema";
import { serviceSchema } from "../../extensions/domain/service";
import { zoneSchema } from '../../zones/domain/schema';
const metadata = z.object({name:z.string().regex(/^[a-z][a-z0-9-]{0,47}$/)}).strict();
const base = {apiVersion:z.literal('2server.app/v1'),metadata,requires:z.array(z.object({kind:z.enum(['App','Extension']),name:metadata.shape.name}).strict()).default([])};
// Rebuild shape to preserve defaults and strict validation while accepting tags.
const spec = z.object({...appSchema.shape,name:z.never().optional(),image:imageReference}).strict();
export const documentSchema = z.discriminatedUnion('kind',[
 z.object({...base,kind:z.literal('App'),spec, runtimeFile:z.string().min(1).optional(),domains:z.array(domainSchema).default([])}).strict(),
 z.object({...base,kind:z.literal('Extension'),template:metadata.shape.name.optional(),domains:z.array(domainSchema).default([]),spec:z.record(z.string(),z.unknown()),webhooks:z.array(webhookSchema).default([]),secrets:z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/),z.object({provider:z.literal('vm'),key:z.string().regex(/^[A-Z_][A-Z0-9_]*$/)}).strict()).default({})}).strict(),
 z.object({...base,kind:z.literal('Service'),spec:serviceSchema}).strict(),
 z.object({...base,kind:z.literal('Domain'),spec:z.record(z.string(),z.unknown())}).strict(),
 z.object({...base,kind:z.literal('Zone'),spec:zoneSchema}).strict(),
]);
export type Document = z.infer<typeof documentSchema>;
