import { quote } from "../../../shared/infrastructure/process";
import { type Config } from "../../config/application/config";
import { replicaNames } from "../domain/replicas";
import { type App } from "../domain/schema";
import { instanceEnv,volumeName } from '../domain/workload';
import { preDeployScript } from './pre-deploy';
import { appLock,drainInBackground,httpProbe,pullUnlessPresent } from './rollout';
import { ensureVolume } from './workload';
export { appLock };
function runtimeHelpers(c: Config, a: App) {
  return `root=/opt/2server/apps/${a.name}
prefix=two-${c.name}-${a.name}
containers() {
  local color="$1" count i
  case "$color" in blue|green) ;; *) return;; esac
  count=$(jq -r '.replicas // 1' "$root/$color.json")
  for ((i=1;i<=count;i++)); do
    if [ "$i" = 1 ]; then echo "$prefix-$color"; else echo "$prefix-$color-$i"; fi
  done
}
stop_generation() { local n; for n in $(containers "$1"); do docker stop -t "$(jq -r '.stopTimeoutSeconds // 60' "$root/$1.json")" "$n" >/dev/null; done; }
start_generation() { local n; for n in $(containers "$1"); do docker start "$n" >/dev/null; done; }
`;
}
function probe(c: Config, a: App, variable: string, bounded=false) {
  const docker=bounded?'timeout --signal=KILL "$remaining" docker':'docker';
  return a.kind === "worker"
    ? `[ "$(${docker} inspect -f '{{.State.Health.Status}}' "${variable}")" = healthy ]`
    : httpProbe(c.edge.network, {variable: variable.replace(/^\$/, '')}, a.port, a.healthPath, 3, bounded);
}
export function upstreamSnippet(a: App, names: string[]) {
  // Quarantining the sole peer turns one request's transport error into an
  // outage. Active probes still remove an actually unready singleton, but only
  // after five 10s misses (~50s): a slow answer from a busy host is not
  // unreadiness, and lohi-app's api measured 5-9s probe latency while starved
  // (2026-10-19), which the old 4s x 3 budget read as dead. With replicas a
  // sibling absorbs the traffic, so an unready one leaves fast.
  const single = names.length === 1;
  return `(up_two_${a.name}) {\n  ${names.length ? `reverse_proxy ${names.map((n) => `${n}:${a.port}`).join(" ")} {
    health_uri ${a.edgeHealthPath ?? a.healthPath}
    health_interval ${single ? "10s" : "5s"}
    health_timeout ${single ? "10s" : "2s"}
    health_status 2xx
    health_fails ${single ? 5 : 2}
    health_passes 2
    ${single ? "" : "fail_duration 10s\n    max_fails 1"}
    lb_try_duration 3s
    lb_try_interval 250ms
    lb_retry_match method GET HEAD
    transport http {
      dial_timeout 1s
    }
  }` : 'respond "Service scaled to zero" 503'}\n}\n`;
}
export function deployScript(c: Config, a: App, release: string): string {
  const root = `/opt/2server/apps/${a.name}`;
  const snippet = `/opt/2server/edge/apps/${a.name}.caddy`;
  const health=a.healthCheck;
  const healthFlags=health?`--health-cmd ${quote(health.command.map(quote).join(' '))} --health-interval ${health.intervalSeconds}s --health-timeout ${health.timeoutSeconds}s --health-start-period ${health.startPeriodSeconds}s --health-retries ${health.failureThreshold}`:'';
  const volumes=(['blue','green'] as const).flatMap(color=>replicaNames(c,a,color).map((container,i)=>{
    const setup=a.volumeMounts.map(m=>{
      const name=volumeName(c,a,m.name,color)+(i?`-${i+1}`:'');
      return `if [ -f "$root/${color}.json" ] && jq -e ${quote(`(.replicas // 1) >= ${i+1} and any(.volumeMounts[]?; .name == ${JSON.stringify(m.name)})`)} "$root/${color}.json" >/dev/null; then
docker volume inspect ${quote(name)} >/dev/null
else
${ensureVolume(c,a,name,false)}
fi\nmount_args+=(--mount ${quote(`type=volume,src=${name},dst=${m.mountPath}${m.readOnly?',readonly':''}`)})`;
    }).join('\n');
    return `if [ "$new" = ${quote(container)} ]; then\n${setup || ':'}\nfi`;
  })).join('\n');
  return `set -Eeuo pipefail
${appLock(a)}
${runtimeHelpers(c, a)}
mkdir -p "$root"
old=$(cat "$root/current" 2>/dev/null || true)
case "$old" in blue) color=green;; green|'') color=blue;; *) exit 1;; esac
if [ -n "$old" ]; then test "$(jq -r '.kind // "service"' "$root/$old.json")" = ${quote(a.kind)}; fi
assert_owned() {
  local n="$1" label
  if docker inspect "$n" >/dev/null 2>&1; then
    label=$(docker inspect -f '{{index .Config.Labels "io.2server.owner"}}' "$n")
    if [ "$label" != ${quote(c.name)} ]; then
      # Earlier releases did not label containers; their saved generation contract is required.
      test -f "$root/$color.json"
      test "$(jq -r .name "$root/$color.json")" = ${quote(a.name)}
      test "$n" = "$prefix-$color"
      test "$label" = '<no value>' || test -z "$label"
    fi
  fi
}
new_names=()
for ((i=1;i<=${a.replicas};i++)); do
  if [ "$i" = 1 ]; then new_names+=("$prefix-$color"); else new_names+=("$prefix-$color-$i"); fi
done
# Remove the parked generation using its saved replica count.
if [ -f "$root/$color.json" ]; then
  for n in $(containers "$color"); do assert_owned "$n"; docker rm -f "$n" >/dev/null 2>&1 || true; done
fi
# Legacy single-replica parked candidates have no metadata on the first upgrade.
for n in "\${new_names[@]}"; do assert_owned "$n"; docker rm -f "$n" >/dev/null 2>&1 || true; done
${a.replicas ? pullUnlessPresent(a.image, `docker pull ${quote(a.image)} >/dev/null`) : ""}
${
  a.kind === "worker" && a.replicas && !a.healthCheck
    ? `health=$(docker image inspect -f '{{if .Config.Healthcheck}}{{index .Config.Healthcheck.Test 0}}{{end}}' ${quote(a.image)})
case "$health" in CMD|CMD-SHELL) ;; *) echo 'Workers require an image HEALTHCHECK' >&2; exit 1;; esac`
    : ""
}
backup=$(mktemp)
existed=false
if [ -f ${snippet} ]; then cp ${snippet} "$backup"; existed=true; fi
switched=false
restore() {
  trap - ERR
  if [ "$switched" = true ]; then
    if [ "$existed" = true ]; then cp "$backup" ${snippet}; else rm -f ${snippet}; fi
    docker exec ${quote(c.edge.container)} caddy reload --config ${quote(c.edge.configPath)} >/dev/null 2>&1 || true
  fi
  for n in "\${new_names[@]}"; do docker rm -f "$n" >/dev/null 2>&1 || true; done
  ${a.kind === "worker" ? 'if [ -n "$old" ]; then start_generation "$old"; fi' : ""}
  rm -f "$backup"
}
trap 'restore' ERR
${(['blue','green'] as const).map(color=>`if [ "$color" = ${color} ]; then\nprintf '%s' ${quote(Object.entries(instanceEnv(a,color)).map(([k,v])=>`${k}=${v}\n`).join(''))} >> ${root}/releases/${release}/app.env\nfi`).join('\n')}
${preDeployScript(c,a,`${root}/releases/${release}/app.env`)}
${a.kind === "worker" ? 'if [ -n "$old" ]; then stop_generation "$old"; fi' : ""}
for new in "\${new_names[@]}"; do
  mount_args=()
  ${volumes}
  docker run -d --name "$new" --restart unless-stopped --init --stop-timeout ${a.stopTimeoutSeconds} --network ${quote(c.edge.network)} \
    --label io.2server.owner=${c.name} --label io.2server.app=${a.name} --label io.2server.generation="$color" \
    --label io.2server.cloud-metadata=${(a.labels['cloud-metadata']==='allow')?'allow':'deny'} \
    --memory ${a.memoryMb}m --cpus ${a.cpus} --pids-limit 256 --security-opt no-new-privileges:true --cap-drop ALL \
    --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
    ${healthFlags} ${a.capabilities.map(v=>`--cap-add ${quote(v)}`).join(' ')} ${Object.entries(a.labels).map(([k,v])=>`--label ${quote(`${k}=${v}`)}`).join(' ')} "\${mount_args[@]}" --env-file ${root}/releases/${release}/app.env ${quote(a.image)} ${(a.command ?? []).map(quote).join(" ")} >/dev/null
  if [ -f /opt/2server/security/metadata-firewall.py ]; then python3 /opt/2server/security/metadata-firewall.py; fi
  ready=false
  deadline=$((SECONDS + ${a.progressDeadlineSeconds}))
  while [ "$SECONDS" -lt "$deadline" ]; do
    remaining=$((deadline - SECONDS))
    if ${probe(c, a, "$new",true)}; then ready=true; break; fi
    sleep 2
  done
  [ "$ready" = true ] || { echo 'Candidate failed health check; restoring previous generation' >&2; false; }
done
${
  a.kind === "service"
    ? `exec 9>/var/lock/2server-edge.lock
flock -w 120 9
switched=true
if [ "$color" = blue ]; then
  printf '%s' ${quote(upstreamSnippet(a, replicaNames(c, a, "blue")))} > ${snippet}
else
  printf '%s' ${quote(upstreamSnippet(a, replicaNames(c, a, "green")))} > ${snippet}
fi
# Reload validates the whole config and keeps the running one if it is
# rejected, so a separate validate would only lengthen the edge lock.
docker exec ${quote(c.edge.container)} caddy reload --config ${quote(c.edge.configPath)} >/dev/null`
    : ""
}
cp ${root}/releases/${release}/app.json "$root/$color.json"
printf '%s\n' ${quote(release)} > "$root/$color.release"
printf '%s\n' "$color" > "$root/current.next"
printf '%s\n' "$old" > "$root/previous.next"
mv "$root/current.next" "$root/current"
mv "$root/previous.next" "$root/previous"
trap - ERR
rm -f "$backup"
${
  a.kind === "service"
    ? `flock -u 9
if [ -n "$old" ]; then
${drainInBackground(a.name, a.drainSeconds, 'stop_generation "$old"')}
fi`
    : ""
}
echo 'App deployed: ${a.name} (${a.replicas} replicas)'
`;
}
export function rollbackScript(
  c: Config,
  a: App,
  prior: App,
  previous: string,
): string {
  const root = `/opt/2server/apps/${a.name}`,
    snippet = `/opt/2server/edge/apps/${a.name}.caddy`;
  return `set -Eeuo pipefail
${appLock(a)}
${runtimeHelpers(c, a)}
old=$(cat "$root/current")
color=$(cat "$root/previous")
case "$old:$color" in blue:green|green:blue) ;; *) exit 1;; esac
test "$(cat "$root/$color.json")" = ${quote(previous.trim())}
restore() { trap - ERR; stop_generation "$color" || true; start_generation "$old"; }
trap 'restore' ERR
${prior.kind === "worker" ? 'stop_generation "$old"' : ""}
start_generation "$color"
for new in $(containers "$color"); do
  ready=false
  for attempt in $(seq 1 30); do
    if ${probe(c, prior, "$new")}; then ready=true; break; fi
    sleep 2
  done
  [ "$ready" = true ]
done
${
  prior.kind === "service"
    ? `exec 9>/var/lock/2server-edge.lock
flock -w 120 9
backup=$(mktemp)
cp ${snippet} "$backup"
trap 'cat "$backup" > ${snippet}; docker exec ${quote(c.edge.container)} caddy reload --config ${quote(c.edge.configPath)} >/dev/null 2>&1 || true; rm -f "$backup"; restore' ERR
if [ "$color" = blue ]; then
  printf '%s' ${quote(upstreamSnippet(prior, replicaNames(c, prior, "blue")))} > ${snippet}
else
  printf '%s' ${quote(upstreamSnippet(prior, replicaNames(c, prior, "green")))} > ${snippet}
fi
docker exec ${quote(c.edge.container)} caddy reload --config ${quote(c.edge.configPath)} >/dev/null
rm -f "$backup"
flock -u 9`
    : ""
}
trap - ERR
printf '%s\n' "$color" > "$root/current"
printf '%s\n' "$old" > "$root/previous"
${prior.kind === "service" ? drainInBackground(a.name, prior.drainSeconds, 'stop_generation "$old"') : ""}
`;
}
