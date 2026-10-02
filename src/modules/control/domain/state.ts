import { z } from "zod";
export const statePath = z.string().regex(/^(monitoring-credentials\.json|monitoring\/[a-z][a-z0-9-]{0,47}\/credentials\.json|certificates\/[a-z][a-z0-9-]{0,47}\/pair\.json|compose\/[a-z][a-z0-9-]{0,47}\/template\.json|deployments\/[a-f0-9-]{36}\.json)$/);
