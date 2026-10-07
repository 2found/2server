import { z } from 'zod';

// Preserve the original singleton and named-instance paths in snapshots.
export const monitoringControlState = {
  roots: ['monitoring-credentials.json', 'monitoring'],
  schema: z.string().regex(/^(monitoring-credentials\.json|monitoring\/[a-z][a-z0-9-]{0,47}\/credentials\.json)$/),
};
