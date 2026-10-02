import { mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { appSchema, type App, type Config } from './config';
import { remote, quote } from './process';
import { upload } from './edge';
import { operatorState } from './operator-state';

type Template = {name: string; services: Record<string, any>; networks?: Record<string, any>; volumes?: Record<string, any>; 'x-2server': {owner: string; app: string; current: string; previous: string; specs: Record<string, App>}};
export const composeOperations = {remote, upload};
const root = (a: App) => `/opt/2server/apps/${a.name}`;
const stateFile = (c: Config, a: App) => join(operatorState(c.name), 'compose', a.name, 'template.json');
async function saveTemplate(c: Config, a: App, t: Template) {
  const file = stateFile(c,a);
  await mkdir(join(file,'..'), {recursive:true,mode:0o700});
  await Bun.write(file, JSON.stringify(t), {mode:0o600});
  await chmod(file,0o600);
}
async function template(c: Config, a: App): Promise<Template> {
  const t = await Bun.file(stateFile(c,a)).json() as Template;
  if (t['x-2server']?.owner !== c.name || t['x-2server']?.app !== a.name) throw new Error('Compose template ownership mismatch');
  return t;
}
function ownership(c: Config, a: App) {
  const p = a.compose!;
  return `test "$(cat ${root(a)}/owner)" = ${quote(c.name)}
assert_container() {
  test "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$1")" = ${quote(p.project)}
  test "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$1")" = "$2"
}`;
}
export function composeProbe(c: Config, a: App, name: string) {
  return `code=$(docker run --rm --network ${quote(c.edge.network)} curlimages/curl:8.12.1 -s --connect-timeout 2 --max-time 5 -o /dev/null -w '%{http_code}' ${quote(`http://${name}:${a.port}${a.healthPath}`)} 2>/dev/null) && [[ "$code" =~ ^2[0-9][0-9]$ ]]`;
}
export function validateTemplate(t: Template, a: App) {
  const p=a.compose!;
  if (Object.keys(t.services).length !== 2) throw new Error('Compose template must contain only the selected pair');
  for (const color of ['blue','green'] as const) {
    const s=t.services[p.services[color]];
    if (!s || s.container_name !== p.containers[color] || s.build || s.privileged || s.network_mode || s.pid === 'host' || s.ports?.length || s.devices?.length || s.depends_on && Object.keys(s.depends_on).length || s.secrets?.length || s.configs?.length)
      throw new Error('Compose adoption requires isolated services, explicit external dependencies and no host ports/privileges');
    for (const v of s.volumes ?? []) if (v.type !== 'volume') throw new Error('Compose app adoption only supports named data volumes, not host binds');
    for (const target of Object.keys(s.networks ?? {})) if (!t.networks?.[target]?.external) throw new Error('Adopted networks must be existing external networks');
  }
  for (const v of Object.values(t.volumes ?? {})) if (!v.external || !v.name) throw new Error('Adopted volumes must have explicit existing external names');
  const blue=t.services[p.services.blue].volumes ?? [], green=t.services[p.services.green].volumes ?? [];
  if (blue.some((b:any) => !b.read_only && green.some((g:any) => !g.read_only && b.source===g.source)))
    throw new Error('Blue/green writers cannot share a writable volume');
}
export async function adoptCompose(c: Config, input: App): Promise<App> {
  const p=input.compose;
  if (!p?.sourceFiles) throw new Error('adopt app requires compose.sourceFiles in its spec');
  const collected = await composeOperations.remote(c, `set -euo pipefail
python3 - <<'PY'
import json,subprocess,pathlib,re
spec=json.loads(${JSON.stringify(JSON.stringify(input))})
p=spec['compose']
def output(args): return subprocess.check_output(args,text=True)
text=pathlib.Path(p['upstreamFile']).read_text()
colors=[color for color,name in p['containers'].items() if re.search(r'(?<![a-zA-Z0-9_-])'+re.escape(name+':'+str(spec['port']))+r'(?![0-9])',text)]
if len(colors)!=1: raise RuntimeError('Cannot identify exactly one active upstream')
color=colors[0]
active=json.loads(output(['docker','inspect',p['containers'][color]]))[0]
labels=active['Config']['Labels']
assert labels['com.docker.compose.project']==p['project'] and labels['com.docker.compose.service']==p['services'][color]
assert active['State']['Running']
args=['docker','compose','-p',p['project']]
for file in p['sourceFiles']: args+=['-f',file]
config=json.loads(output(args+['config','--format','json']))
services={s:config['services'][s] for s in p['services'].values()}
# Capture the active container's exact resolved environment, including an operator
# hotfix, instead of trusting a stale source env file for the active generation.
active_env=dict(row.split('=',1) for row in active['Config']['Env'])
source_env=services[p['services'][color]].get('environment',{})
for other in p['services'].values():
    declared=services[other].get('environment',{})
    overrides={k:v for k,v in declared.items() if k in source_env and v!=source_env[k]}
    services[other]['environment']={**active_env,**overrides}
services[p['services'][color]]['environment']=active_env
image=json.loads(output(['docker','image','inspect',active['Image']]))[0]
digests=image.get('RepoDigests',[])
assert digests, 'Active image needs a registry digest before adoption'
digest=digests[0]
services[p['services'][color]]['image']=digest
used_networks=set(n for s in services.values() for n in s.get('networks',{}))
used_volumes=set(v['source'] for s in services.values() for v in s.get('volumes',[]) if v['type']=='volume')
networks={n:config['networks'][n] for n in used_networks}
volumes={n:{'name':config['volumes'][n]['name'],'external':True} for n in used_volumes}
print(json.dumps({'name':p['project'],'services':services,'networks':networks,'volumes':volumes,'color':color,'image':digest}))
PY`);
  const captured=JSON.parse(collected);
  const a=appSchema.parse({...input,image:captured.image,compose:{...p,sourceFiles:undefined}});
  const color=captured.color as 'blue'|'green';
  delete captured.color; delete captured.image;
  const t: Template={...captured,'x-2server':{owner:c.name,app:a.name,current:color,previous:'',specs:{[color]:a}}};
  validateTemplate(t,a);
  await composeOperations.remote(c, `set -euo pipefail
${composeProbe(c,a,p.containers[color])}
if test -f ${root(a)}/owner; then test "$(cat ${root(a)}/owner)" = ${quote(c.name)}; fi
if test -f ${root(a)}/current; then test "$(cat ${root(a)}/current)" = ${quote(color)}; fi`);
  await saveTemplate(c,a,t);
  await composeOperations.upload(c, {'compose.json':JSON.stringify(t),'owner':c.name,'current':color,'previous':'',[`${color}.json`]:JSON.stringify(a)},root(a));
  // Recheck after capture so concurrent legacy rollout cannot become the desired baseline.
  await composeOperations.remote(c, `set -euo pipefail
${ownership(c,a)}
assert_container ${quote(p.containers[color])} ${quote(p.services[color])}
grep -F -- ${quote(p.containers[color]+':'+a.port)} ${quote(p.upstreamFile)} >/dev/null
${composeProbe(c,a,p.containers[color])}`);
  return a;
}
function route(a: App, name: string) {
  return `(${a.compose!.upstreamName}) {\n reverse_proxy ${name}:${a.port} {\n health_uri ${a.healthPath}\n health_status 2xx\n health_interval 5s\n health_timeout 2s\n health_fails 2\n health_passes 2\n fail_duration 10s\n max_fails 1\n lb_try_duration 3s\n lb_retry_match method GET HEAD\n }\n}\n`;
}
export function composeRollScript(c: Config,a: App,old: 'blue'|'green',color:'blue'|'green',file:string,rollback=false) {
  const p=a.compose!, target=p.containers[color], service=p.services[color], prior=p.containers[old];
  return `set -Eeuo pipefail
exec 8>/var/lock/2server-app-${a.name}.lock
flock -w 120 8
${ownership(c,a)}
test "$(cat ${root(a)}/current)" = ${quote(old)}
assert_container ${quote(prior)} ${quote(p.services[old])}
grep -F -- ${quote(prior+':'+a.port)} ${quote(p.upstreamFile)} >/dev/null
if docker inspect ${quote(target)} >/dev/null 2>&1; then
 assert_container ${quote(target)} ${quote(service)}
 test "$(docker inspect -f '{{.State.Running}}' ${quote(target)})" = false
fi
backup=$(mktemp)
cp ${quote(p.upstreamFile)} "$backup"
switched=false
restore() {
 trap - ERR
 if [ "$switched" = true ]; then cat "$backup" > ${quote(p.upstreamFile)}; docker exec ${quote(c.edge.container)} caddy reload --config ${quote(c.edge.configPath)} >/dev/null 2>&1 || true; fi
 docker stop -t ${a.stopTimeoutSeconds} ${quote(target)} >/dev/null 2>&1 || true
 rm -f "$backup"
}
trap restore ERR
${rollback ? `docker start ${quote(target)} >/dev/null` : `docker pull ${quote(a.image)} >/dev/null
docker compose -p ${quote(p.project)} -f ${quote(file)} up -d --no-deps ${quote(service)} >/dev/null 2>&1`}
ready=false
for attempt in $(seq 1 ${Math.ceil(p.gateTimeoutSeconds/2)}); do
 if ${composeProbe(c,a,target)}; then ready=true; break; fi
 sleep 2
done
test "$ready" = true
exec 9>/var/lock/2server-edge.lock
flock -w 120 9
switched=true
printf '%s' ${quote(route(a,target))} > ${quote(p.upstreamFile)}
docker exec ${quote(c.edge.container)} caddy validate --config ${quote(c.edge.configPath)} >/dev/null 2>&1
docker exec ${quote(c.edge.container)} caddy reload --config ${quote(c.edge.configPath)} >/dev/null 2>&1
cp ${quote(file)} ${root(a)}/compose.json
printf '%s' ${quote(JSON.stringify(a))} > ${root(a)}/${color}.json
printf '%s' ${quote(color)} > ${root(a)}/current
printf '%s' ${quote(old)} > ${root(a)}/previous
trap - ERR
rm -f "$backup"
flock -u 9
sleep ${a.drainSeconds}
docker stop -t ${a.stopTimeoutSeconds} ${quote(prior)} >/dev/null || echo "Warning: old container cleanup failed; new route is committed" >&2
`;
}
export async function deployCompose(c: Config,a: App,env: string) {
  const t=await template(c,a), old=t['x-2server'].current as 'blue'|'green';
  if (!['blue','green'].includes(old)) throw new Error('Invalid Compose generation');
  const color=old==='blue'?'green':'blue', p=a.compose!;
  const active=t['x-2server'].specs[old];
  if (p.migrationRequired && a.image!==active.image && !migrationConfirmed)
    throw new Error('This app requires migrations before a new image. Run its migration-aware release script, then pass --migrations-applied. Same-image reload needs no migration.');
  const service=t.services[p.services[color]];
  service.image=a.image;
  // Compose interpolates dollars even in JSON. Store literal values here and
  // escape them only in the rendered runtime document below.
  for (const row of env.trimEnd().split('\n').filter(Boolean)) { const i=row.indexOf('='); service.environment ??={}; service.environment[row.slice(0,i)]=row.slice(i+1); }
  service.labels={...service.labels,'io.2server.owner':c.name,'io.2server.app':a.name,'io.2server.generation':color,'io.2server.runtime':'compose'};
  t['x-2server']={owner:c.name,app:a.name,current:color,previous:old,specs:{...t['x-2server'].specs,[color]:a}};
  validateTemplate(t,a);
  const file=`${root(a)}/releases/${crypto.randomUUID()}/compose.json`;
  await composeOperations.upload(c, {'compose.json':renderCompose(t)},join(file,'..'));
  await composeOperations.remote(c,composeRollScript(c,a,old,color,file));
  await saveTemplate(c,a,t);
}
export function renderCompose(t: Template) {
  // --no-interpolate is not an up option: Compose's literal dollar escape is $$.
  function escape(v:any):any { if(typeof v==='string')return v.replaceAll('$',()=> '$$');if(Array.isArray(v))return v.map(escape);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,escape(x)]));return v; }
  return JSON.stringify(escape(t));
}
let migrationConfirmed=false;
export function confirmComposeMigrations(value:boolean) { migrationConfirmed=value; }
export async function rollbackCompose(c:Config,a:App):Promise<App> {
  const t=await template(c,a), meta=t['x-2server'];
  const old=meta.current as 'blue'|'green', color=meta.previous as 'blue'|'green';
  if (!['blue','green'].includes(color) || color===old || !meta.specs[color]) throw new Error('No CLI-managed previous generation; adoption retains old containers but does not certify them for rollback');
  const prior=appSchema.parse(meta.specs[color]);
  t['x-2server']={...meta,current:color,previous:old};
  const file=`${root(a)}/releases/${crypto.randomUUID()}/compose.json`;
  await composeOperations.upload(c,{'compose.json':renderCompose(t)},join(file,'..'));
  await composeOperations.remote(c,composeRollScript(c,prior,old,color,file,true));
  await saveTemplate(c,a,t);
  return prior;
}
export function composePods(c:Config,a:App,name?:string) {
  const p=a.compose!;
  return `for pair in ${(['blue','green'] as const).filter(color=>!name || p.containers[color]===name).map(color=>quote(p.containers[color]+':'+p.services[color])).join(' ')}; do
 n="\${pair%%:*}"; s="\${pair#*:}"
 if docker inspect "$n" >/dev/null 2>&1; then
 test "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$n")" = ${quote(p.project)}
 test "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$n")" = "$s"
 docker inspect -f '{"id":{{json .Id}},"name":{{json .Name}},"app":"${a.name}","status":{{json .State.Status}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}"none"{{end}}}' "$n"
 fi
done`;
}
