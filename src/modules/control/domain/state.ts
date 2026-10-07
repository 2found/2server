import { z } from "zod";
export const statePath = z.string().regex(/^(certificates\/[a-z][a-z0-9-]{0,47}\/pair\.json|compose\/[a-z][a-z0-9-]{0,47}\/template\.json|deployments\/[a-f0-9-]{36}\.json)$/);
