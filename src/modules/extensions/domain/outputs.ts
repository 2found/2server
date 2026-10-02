import { z } from 'zod';
import { databaseName,name } from '../../../shared/domain/schema';

const field = z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/);
const address = {
  protocol: z.enum(['http', 'https', 'redis', 'nats', 'postgresql', 'tcp']),
  port: z.number().int().min(1).max(65535),
  container: name.optional(), // suffix of two-<server>-<container>
};
export const outputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('endpoint'), ...address }).strict(),
  z.object({
    type: z.literal('connection'), ...address,
    usernameField: field.optional(),
    username: databaseName.optional(),
    passwordEnvField: field.regex(/Env$/),
    databaseField: field.optional(),
  }).strict().refine(o => !(o.username && o.usernameField), 'Choose username or usernameField'),
  z.object({ type: z.literal('secret'), envField: field.regex(/Env$/) }).strict(),
]);
export type ExtensionOutput = z.infer<typeof outputSchema>;
