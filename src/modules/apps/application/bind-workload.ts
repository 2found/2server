import { join } from 'node:path';
import { operatorState } from '../../../shared/infrastructure/operator-state';
import { type Config } from '../../config/application/config';
import { appSchema,type App } from '../domain/schema';

import { volumeName,type Color } from "../domain/workload";
// Only infrastructure identities are inherited from VM state. Desired fields
// (including omissions) always come from the caller's source checkout.
export async function bindWorkload(c:Config,a:App,old?:App):Promise<App> {
 if(a.compose || !old?.compose)return a;
 const p=old.compose;
 const t=await Bun.file(join(operatorState(c.name),'compose',a.name,'template.json')).json();
 if(t['x-2server']?.owner!==c.name || t['x-2server']?.app!==a.name)throw new Error('Compose template ownership mismatch');
 const volumeBindings:Record<string,Record<Color,string>>={...p.volumeBindings};
 for(const mount of a.volumeMounts) {
  const names={} as Record<Color,string>;
  for(const color of ['blue','green'] as const) {
   const matches=(t.services[p.services[color]]?.volumes??[]).filter((v:any)=>v.target===mount.mountPath);
   if(matches.length>1)throw new Error(`Ambiguous VM volume binding for ${mount.name}`);
   const saved=p.volumeBindings?.[mount.name]?.[color];
   const existing=matches[0];
   if(existing && (existing.type!=='volume' || !t.volumes?.[existing.source]?.external || !t.volumes?.[existing.source]?.name))throw new Error(`Cannot bind ${mount.name}: explicit external VM volume required`);
   names[color]=saved??(existing?t.volumes[existing.source].name:volumeName(c,a,mount.name,color));
  }
  if(!mount.readOnly && names.blue===names.green)throw new Error('Blue/green writers cannot share a writable volume');
  volumeBindings[mount.name]=names;
 }
 return appSchema.parse({...a,compose:{project:p.project,services:p.services,containers:p.containers,upstreamFile:p.upstreamFile,upstreamName:p.upstreamName,generated:true,volumeBindings,gateTimeoutSeconds:a.progressDeadlineSeconds,migrationRequired:p.migrationRequired}});
}
