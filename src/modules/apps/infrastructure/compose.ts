import { chmod,mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { operatorState } from '../../../shared/infrastructure/operator-state';
import { quote,remote } from '../../../shared/infrastructure/process';
import { type Config } from '../../config/application/config';
import { upload } from '../../domains/infrastructure/edge';
import { appSchema,type App } from '../domain/schema';
import { preDeployScript } from './pre-deploy';
import { desiredService,ensureVolume } from './workload';

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
export function composeProbe(c: Config, a: App, name: string, boundToRemaining = false) {
  return `code=$(${boundToRemaining ? 'timeout --signal=KILL "$remaining" ' : ''}docker run --rm --network ${quote(c.edge.network)} curlimages/curl:8.12.1 -s --connect-timeout 2 --max-time 2 -o /dev/null -w '%{http_code}' ${quote(`http://${name}:${a.port}${a.healthPath}`)} 2>/dev/null) && [[ "$code" =~ ^2[0-9][0-9]$ ]]`;
}
export function validateTemplate(t: Template, a: App) {
  const p=a.compose!;
  // Fail closed as Compose gains new host-access and lifecycle features. These
  // files are supplied by an app repository but executed by the VM's root daemon.
  const only = (value: any, keys: string[], context: string) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k)))
      throw new Error(`Unsupported ${context} fields in isolated Compose runtime`);
  };
  only(t, ['name','services','networks','volumes','x-2server'], 'root');
  if (Object.keys(t.services).length !== 2) throw new Error('Compose template must contain only the selected pair');
  for (const color of ['blue','green'] as const) {
    const s=t.services[p.services[color]];
    only(s, ['image','container_name','command','entrypoint','environment','networks','volumes','user','working_dir',
      'init','restart','stop_grace_period','stop_signal','healthcheck','labels','logging','mem_limit','mem_reservation',
      'memswap_limit','cpus','pids_limit','security_opt','cap_drop','cap_add','read_only','tmpfs','ulimits','pull_policy','deploy'], 'service');
    if (s.deploy !== undefined) {
      only(s.deploy, ['resources'], 'deploy');
      if (s.deploy.resources !== undefined) {
        only(s.deploy.resources, ['limits','reservations'], 'resource');
        for (const value of Object.values(s.deploy.resources)) only(value, ['cpus','memory','pids'], 'resource limit');
      }
    }
    if (s.cap_drop !== undefined && (!Array.isArray(s.cap_drop) || s.cap_drop.length !== 1 || s.cap_drop[0] !== 'ALL'))
      throw new Error('Compose apps must drop ALL capabilities');
    if (s.security_opt !== undefined && (!Array.isArray(s.security_opt) || s.security_opt.length !== 1 || s.security_opt[0] !== 'no-new-privileges:true'))
      throw new Error('Compose apps require no-new-privileges:true');
    if (s.logging !== undefined) {
      only(s.logging, ['driver','options'], 'logging');
      if (s.logging.driver !== 'json-file') throw new Error('Compose apps require local bounded json-file logging');
      if (s.logging.options !== undefined) only(s.logging.options, ['max-size','max-file','compress'], 'logging option');
    }
    if(s?.environment !== undefined && (!s.environment || typeof s.environment !== 'object' || Array.isArray(s.environment)))
      throw new Error('Compose environment must be an explicit mapping, not a list or null');
    if(Object.values(s?.environment ?? {}).some(value => value == null))
      throw new Error('Compose environment values must be explicit; host environment inheritance is not allowed');
    if (!s || s.container_name !== p.containers[color] || s.build || s.extends || s.volumes_from || s.use_api_socket || s.privileged || s.env_file || s.cap_add?.some((v:string)=>v!=='NET_BIND_SERVICE') || s.security_opt?.some((v:string)=>v!=="no-new-privileges:true") || s.network_mode || s.pid === 'host' || s.ports?.length || s.devices?.length || s.depends_on && Object.keys(s.depends_on).length || s.secrets?.length || s.configs?.length)
      throw new Error('Compose adoption requires isolated services, explicit external dependencies and no host ports/privileges');
    for (const v of s.volumes ?? []) {
      only(v, ['type','source','target','read_only','volume'], 'volume mount');
      if (v.type !== 'volume' || !t.volumes?.[v.source]) throw new Error('Compose app adoption only supports declared named data volumes, not host binds');
      if (v.volume !== undefined) only(v.volume, ['nocopy','subpath'], 'volume option');
    }
    for (const [target,options] of Object.entries(s.networks ?? {})) {
      if (!t.networks?.[target]?.external) throw new Error('Adopted networks must be existing external networks');
      if (options != null) only(options, ['aliases'], 'network attachment');
    }
  }
  for (const v of Object.values(t.volumes ?? {})) {
    only(v, ['external','name'], 'volume');
    if (v.external !== true || !v.name) throw new Error('Adopted volumes must have explicit existing external names');
  }
  for (const n of Object.values(t.networks ?? {})) {
    only(n, ['external','name'], 'network');
    if (n.external !== true || !n.name) throw new Error('Adopted networks must have explicit existing external names');
  }
  const blue=t.services[p.services.blue].volumes ?? [], green=t.services[p.services.green].volumes ?? [];
  if (blue.some((b:any) => !b.read_only && green.some((g:any) => !g.read_only && (b.source===g.source || t.volumes?.[b.source]?.name===t.volumes?.[g.source]?.name))))
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
export function composeUpstreamSnippet(a: App, name: string) {
  // A Compose blue/green pair serves one generation, not two failover peers.
  // A single transport error must not quarantine the only serving upstream.
  return `(${a.compose!.upstreamName}) {\n reverse_proxy ${name}:${a.port} {\n health_uri ${a.healthPath}\n health_status 2xx\n health_interval 5s\n health_timeout 2s\n health_fails 2\n health_passes 2\n lb_try_duration 3s\n lb_retry_match method GET HEAD\n }\n}\n`;
}

// A registry pull is a network call with two known intermittent failure
// modes on the VM: docker-credential-gcloud minting a token against a
// briefly-unreachable metadata server, and Artifact Registry connection
// resets. Retrying inside the roll script is what keeps a flaky minute from
// cancelling a rollout whose candidate image usually already exists —
// previously a single transient pull failure exited the script and aborted
// the whole deploy.
const pullWithRetry = (image: string) => `pull_attempt=0
until docker pull ${quote(image)} >/dev/null; do
 pull_attempt=$((pull_attempt + 1))
 if (( pull_attempt >= 4 )); then
  echo 'image pull failed repeatedly; aborting rollout' >&2
  exit 1
 fi
 sleep $((pull_attempt * 2))
done`;

type LiveComposeState = { current: 'blue' | 'green'; spec: App };

// The VM's own state files are the ground truth of a compose app's live
// generation. The local template is only a MIRROR: it is written after the
// remote roll succeeds and mirrored again into the control snapshot by the
// session layer. When a rollout's remote apply commits on the VM but the
// final snapshot commit fails (a transient SSH/gcloud error AFTER the VM
// state flipped), the mirror is left one deploy behind — template.current
// points at the generation the VM has already retired. Every later deploy
// then plans the wrong candidate color and dies inside the roll script at
// `test "$(cat .../current)"`, surfacing as an opaque "gcloud failed".
// Reconcile before planning: read the live generation files and the actual
// reverse_proxy target, realign the mirror, and fail with a named error
// when the VM's own files disagree with each other — a state no mirror
// repair can safely guess.
export async function liveComposeState(c: Config, a: App): Promise<LiveComposeState> {
  const p = a.compose!;
  const out = await composeOperations.remote(c, `set -euo pipefail
python3 - <<'PY'
import json,re
from pathlib import Path
root=Path(${JSON.stringify(root(a))})
containers=${JSON.stringify(p.containers)}
current=(root/'current').read_text().strip()
assert current in containers, f'unexpected live generation {current!r}'
route=Path(${JSON.stringify(p.upstreamFile)}).read_text()
m=re.search(r'reverse_proxy\\s+(\\S+):(\\d+)', route)
assert m, 'live upstream serves no reverse_proxy target'
assert m.group(1)==containers[current], f'live upstream serves {m.group(1)} but the generation file says {current}; VM state is inconsistent, repair by hand'
spec=json.loads((root/f'{current}.json').read_text())
assert int(m.group(2))==spec['port'], f'live upstream port {m.group(2)} but the generation spec declares {spec["port"]}'
print(json.dumps({'current':current,'spec':spec}))
PY`);
  const live = JSON.parse(out) as { current: 'blue' | 'green'; spec: unknown };
  return { current: live.current, spec: appSchema.parse(live.spec) };
}

export function composeRollScript(c: Config,a: App,old: 'blue'|'green',color:'blue'|'green',file:string,rollback=false,activePort=a.port) {
  const p=a.compose!, target=p.containers[color], service=p.services[color], prior=p.containers[old];
  return `set -Eeuo pipefail
exec 8>/var/lock/2server-app-${a.name}.lock
flock -w 120 8
${ownership(c,a)}
test "$(cat ${root(a)}/current)" = ${quote(old)}
assert_container ${quote(prior)} ${quote(p.services[old])}
grep -F -- ${quote(prior+':'+activePort)} ${quote(p.upstreamFile)} >/dev/null
if docker inspect ${quote(target)} >/dev/null 2>&1; then
 assert_container ${quote(target)} ${quote(service)}
 test "$(docker inspect -f '{{.State.Running}}' ${quote(target)})" = false
fi
backup=$(mktemp)
cp ${quote(p.upstreamFile)} "$backup"
switched=false
restore() {
 trap - ERR
 if [ "$switched" = true ]; then flock -w 120 9 || return 1; cat "$backup" > ${quote(p.upstreamFile)}; docker exec ${quote(c.edge.container)} caddy reload --config ${quote(c.edge.configPath)} >/dev/null 2>&1 || true; fi
 docker stop -t ${a.stopTimeoutSeconds} ${quote(target)} >/dev/null 2>&1 || true
 rm -f "$backup"
}
trap restore ERR
${rollback ? `docker start ${quote(target)} >/dev/null` : `${pullWithRetry(a.image)}
${preDeployScript(c,a,join(file,'..','app.env'))}docker compose -p ${quote(p.project)} -f ${quote(file)} up -d --no-deps ${quote(service)} >/dev/null 2>&1`}
if [ -f /opt/2server/security/metadata-firewall.py ]; then python3 /opt/2server/security/metadata-firewall.py; fi
ready=false
stable_since=-1
deadline=$((SECONDS + ${p.gateTimeoutSeconds}))
while (( SECONDS < deadline )); do
 remaining=$((deadline - SECONDS))
 if (( remaining <= 0 )); then break; fi
 if ${composeProbe(c,a,target,true)} && (( SECONDS < deadline )); then
  if (( stable_since < 0 )); then stable_since=$SECONDS; fi
  if (( SECONDS - stable_since >= 20 )); then ready=true; break; fi
 else
  stable_since=-1
 fi
 remaining=$((deadline - SECONDS))
 if (( remaining <= 0 )); then break; fi
 sleep "$((remaining < 5 ? remaining : 5))"
done
test "$ready" = true
exec 9>/var/lock/2server-edge.lock
flock -w 120 9
switched=true
printf '%s' ${quote(composeUpstreamSnippet(a,target))} > ${quote(p.upstreamFile)}
docker exec ${quote(c.edge.container)} caddy validate --config ${quote(c.edge.configPath)} >/dev/null 2>&1
docker exec ${quote(c.edge.container)} caddy reload --config ${quote(c.edge.configPath)} >/dev/null 2>&1
flock -u 9
# Keep the previous generation and rollback trap until the candidate stays stable
# under live traffic. Caddy's active health policy remains unchanged.
observation_deadline=$((SECONDS + 20))
while (( SECONDS < observation_deadline )); do
 remaining=$((observation_deadline - SECONDS))
 if (( remaining <= 0 )); then break; fi
 # Do not shorten a healthy HTTP probe solely because the window ends.
 if (( remaining < 2 )); then sleep "$remaining"; break; fi
 # Docker startup is outside the HTTP timeout. A final in-flight probe has
 # at most 10 seconds of startup grace beyond the observation window.
 remaining=$((observation_deadline + 10 - SECONDS))
 if (( remaining <= 0 )); then false; fi
 if ${composeProbe(c,a,target,true)}; then :; else
  echo 'Candidate became unhealthy after switching; restoring previous route' >&2
  false
 fi
 remaining=$((observation_deadline - SECONDS))
 if (( remaining <= 0 )); then break; fi
 sleep "$((remaining < 5 ? remaining : 5))"
done
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
export async function deployCompose(c: Config,a: App,env: string,hookSecrets='\n') {
  if(Object.keys(a.preDeploy?.secrets??{}).length && !hookSecrets.trim()) throw new Error('Missing resolved preDeploy secrets');
  let t=await template(c,a);
  const live = await liveComposeState(c,a);
  const drifted = live.current !== t['x-2server'].current;
  if (drifted) {
    // Mirror repair only — the roll already committed on the VM; only the
    // snapshot lagged. Realign both recorded generations to the VM's files.
    console.warn(`${a.name}: live generation is ${live.current} but the stored template says ${t['x-2server'].current} (a previous commitSnapshot failed after the roll applied) — realigning the mirror to VM truth`);
    t['x-2server'].current = live.current;
    t['x-2server'].previous = live.current === 'blue' ? 'green' : 'blue';
  }
  t['x-2server'].specs[live.current] = live.spec;
  const old = live.current;
  if(a.compose?.runtime) t={...structuredClone(a.compose.runtime),'x-2server':t['x-2server']} as Template;
  if (!['blue','green'].includes(old)) throw new Error('Invalid Compose generation');
  const color=old==='blue'?'green':'blue', p=a.compose!;
  const active=t['x-2server'].specs[old];
  if (p.migrationRequired && a.image!==active.image && !migrationConfirmed && !a.preDeploy)
    throw new Error('This app requires migrations before a new image. Configure preDeploy or run its migration-aware release script, then pass --migrations-applied. Same-image reload needs no migration.');
  if(p.generated) {
    const desired=Object.fromEntries(env.split('\n').filter(Boolean).map(row=>{const i=row.indexOf('=');return [row.slice(0,i),row.slice(i+1)];}));
    const volumeChecks:string[]=[];
    for(const mount of a.volumeMounts) {
      const name=p.volumeBindings?.[mount.name]?.[color];
      if(!name)throw new Error(`Missing VM volume binding for ${mount.name}`);
      volumeChecks.push(ensureVolume(c,a,name,Object.values(t.volumes??{}).some((v:any)=>v.name===name)));
      t.volumes??={};t.volumes[`claim-${mount.name}-${color}`]={name,external:true};
    }
    t.networks??={};t.networks[c.edge.network]={name:c.edge.network,external:true};
    t.services[p.services[color]]=desiredService(c,a,color,desired);
    if(volumeChecks.length)await composeOperations.remote(c,`set -euo pipefail\n${volumeChecks.join('\n')}`);
  }
  const service=t.services[p.services[color]];
  service.image=a.image;
  if(p.runtime) {
    // Compose validates every service even when up targets only the new color.
    // Public runtime files omit images; the retained color keeps its saved image.
    t.services[p.services[old]].image=active.image;
    const publicEnv=service.environment??{};
    const desired=Object.fromEntries(env.split('\n').filter(Boolean).map(row=>{const i=row.indexOf('=');return [row.slice(0,i),row.slice(i+1)];}));
    if(Object.keys(publicEnv).some(k=>k in a.secrets || k in a.bindings)) throw new Error('Runtime public environment cannot override declared secrets or bindings');
    service.environment={...desired,...publicEnv};
    service.mem_limit=`${a.memoryMb}m`;
    service.cpus=a.cpus;
    service.stop_grace_period=`${a.stopTimeoutSeconds}s`;
    if(service.deploy?.resources) delete service.deploy.resources;
    if(a.command)service.command=a.command;
  }
  // Compose interpolates dollars even in JSON. Store literal values here and
  // escape them only in the rendered runtime document below.
  if(!p.runtime && !p.generated) for (const row of env.split('\n').filter(Boolean)) { const i=row.indexOf('='); service.environment ??={}; service.environment[row.slice(0,i)]=row.slice(i+1); }
  service.labels={...service.labels,'io.2server.owner':c.name,'io.2server.app':a.name,'io.2server.generation':color,'io.2server.runtime':'compose','io.2server.cloud-metadata':(a.labels['cloud-metadata']==='allow')?'allow':'deny'};
  t['x-2server']={owner:c.name,app:a.name,current:color,previous:old,specs:{...t['x-2server'].specs,[color]:a}};
  validateTemplate(t,a);
  // Older adopted templates get the native baseline on their next rollout.
  // Only the candidate is recreated; the running generation is untouched.
  service.cap_drop=['ALL'];
  service.security_opt=['no-new-privileges:true'];
  service.pids_limit=256;
  service.logging={driver:'json-file',options:{'max-size':'10m','max-file':'3'}};
  const hookEnv=Object.entries(service.environment ?? {}).map(([key,value])=>{
    if(a.preDeploy && (!/^[A-Z_][A-Z0-9_]*$/.test(key) || value == null || /[\r\n\0]/.test(String(value))))
      throw new Error('preDeploy requires explicit single-line candidate environment values');
    return `${key}=${value}`;
  }).join('\n')+'\n';
  const file=`${root(a)}/releases/${crypto.randomUUID()}/compose.json`;
  await composeOperations.upload(c, {'compose.json':renderCompose(t),'app.env':hookEnv,'pre-deploy.env':hookSecrets},join(file,'..'));
  await composeOperations.remote(c,composeRollScript(c,a,old,color,file,false,active.port));
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
  const live = await liveComposeState(c,a);
  if (live.current !== meta.current) {
    // Same mirror repair as deployCompose: a roll committed on the VM while
    // the snapshot commit failed — rollback must plan from the VM's files.
    console.warn(`${a.name}: live generation is ${live.current} but the stored template says ${meta.current} — realigning the mirror to VM truth`);
    meta.current = live.current;
    meta.previous = live.current === 'blue' ? 'green' : 'blue';
  }
  meta.specs[live.current] = live.spec;
  const old=meta.current as 'blue'|'green', color=meta.previous as 'blue'|'green';
  if (!['blue','green'].includes(color) || color===old || !meta.specs[color]) throw new Error('No CLI-managed previous generation; adoption retains old containers but does not certify them for rollback');
  const prior=appSchema.parse(meta.specs[color]);
  t['x-2server']={...meta,current:color,previous:old};
  const file=`${root(a)}/releases/${crypto.randomUUID()}/compose.json`;
  await composeOperations.upload(c,{'compose.json':renderCompose(t)},join(file,'..'));
  await composeOperations.remote(c,composeRollScript(c,prior,old,color,file,true,live.spec.port));
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
 docker inspect -f '{"id":{{json .Id}},"name":{{json .Name}},"app":"${a.name}","status":{{json .State.Status}},"health":{{with index .State "Health"}}{{json .Status}}{{else}}"none"{{end}}}' "$n"
 fi
done`;
}
