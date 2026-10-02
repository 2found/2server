import {join} from 'node:path';
import {appSchema, type App, type Config} from './config';
import {operatorState} from './operator-state';
import {quote} from './process';

export type Color = 'blue' | 'green';
export const instanceEnv = (a:App,color:Color) => Object.fromEntries(Object.entries(a.instanceEnv).map(([k,v])=>[k,v.replaceAll('${generation}',color)]));
export const volumeName = (c:Config,a:App,claim:string,color:string) => `two-${c.name}-${a.name}-${claim}-${color}`;
export function containerHealth(a:App) {
 const h=a.healthCheck;
 return h ? {test:['CMD',...h.command],interval:`${h.intervalSeconds}s`,timeout:`${h.timeoutSeconds}s`,start_period:`${h.startPeriodSeconds}s`,retries:h.failureThreshold} : undefined;
}
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
export function desiredService(c:Config,a:App,color:Color,env:Record<string,string>) {
 const p=a.compose!;
 return {
  container_name:p.containers[color],image:a.image,environment:{...env,...instanceEnv(a,color)},
  init:true,restart:'unless-stopped',networks:{[c.edge.network]:{}},
  mem_limit:`${a.memoryMb}m`,cpus:a.cpus,stop_grace_period:`${a.stopTimeoutSeconds}s`,
  pids_limit:256,security_opt:['no-new-privileges:true'],cap_drop:['ALL'],cap_add:a.capabilities,
  logging:{driver:'json-file',options:{'max-size':'10m','max-file':'3'}},
  labels:{...a.labels,'io.2server.owner':c.name,'io.2server.app':a.name,'io.2server.generation':color,'io.2server.runtime':'compose'},
  ...(a.command!==undefined?{command:a.command}:{}),
  ...(a.healthCheck?{healthcheck:containerHealth(a)}:{}),
  volumes:a.volumeMounts.map(m=>({type:'volume',source:`claim-${m.name}-${color}`,target:m.mountPath,read_only:m.readOnly})),
 };
}
// Refuse to silently attach a foreign volume when creating a new claim. Existing
// adopted bindings are checked for existence, never auto-created if lost.
export function ensureVolume(c:Config,a:App,name:string,adopted:boolean):string {
 if(adopted)return `docker volume inspect ${quote(name)} >/dev/null`;
 return `if docker volume inspect ${quote(name)} >/dev/null 2>&1; then
 test "$(docker volume inspect -f '{{index .Labels "io.2server.owner"}}' ${quote(name)})" = ${quote(c.name)}
 test "$(docker volume inspect -f '{{index .Labels "io.2server.app"}}' ${quote(name)})" = ${quote(a.name)}
else
 docker volume create --label io.2server.owner=${quote(c.name)} --label io.2server.app=${quote(a.name)} ${quote(name)} >/dev/null
fi`;
}
