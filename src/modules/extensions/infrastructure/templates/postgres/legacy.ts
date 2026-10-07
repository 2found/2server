import type { Request } from '../../../../../shared/cli/resource-request';
import type { Config } from '../../../../config/application/config';
import { run } from './cli';

export async function legacyPostgresResource(r: Request, c: Config, _state: string, _original: string) {
  if (r.resource === 'recovery')
    throw new Error('Select the database app: app NAME recoveries or app NAME remove-recovery --recovery NAME');
  if (r.resource !== 'postgres') return false;
  if (!c.extensions.postgres) throw new Error('App postgres is not installed');
  const flags = Object.entries(r.options).filter(([key]) => key !== 'file').flatMap(([key,value]) => [`--${key}`,value]);
  await run(c,['get','describe'].includes(r.verb) ? 'backups' : r.verb,[...flags,...(r.apply ? ['--apply'] : [])]);
  return true;
}
