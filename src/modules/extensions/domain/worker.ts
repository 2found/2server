import { z } from "zod";

// Runtime contract for `runtime.engine: worker`. Account, script name and
// hostname are deploy target; they are not the application.
export const workerSpecSchema = z.object({
  accountId: z.string().regex(/^[0-9a-f]{32}$/),
  worker: z.string().regex(/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/),
  hostname: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,251}[a-z0-9]$/),
  zone: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,251}[a-z0-9]$/),
  database: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/),
  compatibilityDate: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/).default("2024-09-23"),
}).strict();
export type WorkerSpec = z.infer<typeof workerSpecSchema>;
