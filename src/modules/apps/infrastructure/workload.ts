import { quote } from '../../../shared/infrastructure/process';
import { type Config } from '../../config/application/config';
import { type App } from '../domain/schema';
import { containerHealth,instanceEnv,type Color } from "../domain/workload";

export function desiredService(c:Config,a:App,color:Color,env:Record<string,string>) {
 const p=a.compose!;
 return {
  container_name:p.containers[color],image:a.image,environment:{...env,...instanceEnv(a,color)},
  init:true,restart:'unless-stopped',networks:{[c.edge.network]:{}},
  mem_limit:`${a.memoryMb}m`,cpus:a.cpus,stop_grace_period:`${a.stopTimeoutSeconds}s`,
  pids_limit:256,security_opt:['no-new-privileges:true'],cap_drop:['ALL'],cap_add:a.capabilities,
  logging:{driver:'json-file',options:{'max-size':'10m','max-file':'3'}},
  labels:{...a.labels,'io.2server.owner':c.name,'io.2server.app':a.name,'io.2server.generation':color,'io.2server.runtime':'compose','io.2server.cloud-metadata':(a.labels['cloud-metadata']==='allow')?'allow':'deny'},
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
