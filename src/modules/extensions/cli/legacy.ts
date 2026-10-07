import type { Request } from '../../../shared/cli/resource-request';
import type { Config } from '../../config/application/config';
import { legacyMonitoringResource } from '../infrastructure/templates/monitoring/legacy';
import { legacyPostgresResource } from '../infrastructure/templates/postgres/legacy';

// Frozen compatibility composition. New commands use the definition's command
// map and app NAME; do not extend the core resource grammar or this adapter list.
export async function legacyExtensionResource(r: Request, c: Config, state: string, original: string) {
  for (const handler of [legacyMonitoringResource,legacyPostgresResource])
    if (await handler(r,c,state,original)) return true;
  return false;
}
