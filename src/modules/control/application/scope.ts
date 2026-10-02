import { posix } from 'node:path';
import { parseResource } from '../../../shared/cli/resource-request';
import type { App } from '../../apps/domain/schema';
import type { Config } from '../../config/application/config';

export function appResources(app: Pick<App,'name'|'compose'>): string[] {
  return [`app:${app.name}`, ...(app.compose ? [
    ...Object.values(app.compose.services).map(service=>`compose:${app.compose!.project}/${service}`),
    `upstream:${posix.normalize(app.compose.upstreamFile)}`,
    ...Object.values(app.compose.containers).map(name=>`container:${name}`),
  ] : [])].sort();
}
// Operations that can replace shared infrastructure/dependencies remain
// exclusive. Add a scoped route only after identifying all its write targets.
export function controlResources(args:string[], c:Config):string[] {
  if (args[0] === 'secret' && args.includes('--app')) {
    const name = args[args.indexOf('--app')+1];
    if (/^[a-z][a-z0-9-]{0,47}$/.test(name??'')) return [`app:${name}`];
  }
  // Connected --env-file may change server-scoped references used by other apps.
  if (args.includes('--env-file')) return ['server'];
  const r = parseResource([...args,'-f','session.json']);
  if (r?.resource === 'domain') return ['domains'];
  if (r?.resource === 'app' && r.name && ['deploy','reload','rollback','scale'].includes(r.verb)) {
    const app = c.apps.find(a=>a.name===r.name);
    if (app) return appResources(app);
  }
  return ['server'];
}
