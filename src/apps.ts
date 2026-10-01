import { appSchema, type App, type Config } from "./config";
import { quote, remote, run } from "./process";
import { upload } from "./edge";
export async function resolveEnv(a: App): Promise<string> {
  const values = { ...a.env };
  for (const [key, s] of Object.entries(a.secrets)) {
    let value: string | undefined;
    if (s.provider === "env") value = process.env[s.key];
    if (s.provider === "gcp")
      value = await run([
        "gcloud",
        "secrets",
        "versions",
        "access",
        s.version,
        `--secret=${s.secret}`,
        `--project=${s.project}`,
      ]);
    if (s.provider === "aws")
      value = (
        JSON.parse(
          await run([
            "aws",
            "secretsmanager",
            "get-secret-value",
            "--secret-id",
            s.id,
            "--region",
            s.region,
            "--output",
            "json",
          ]),
        ) as { SecretString?: string }
      ).SecretString;
    if (!value || /[\r\n\0]/.test(value))
      throw new Error(
        `${a.name}: secret ${key} missing or multiline (env-file values must be single-line)`,
      );
    values[key] = value;
  }
  return (
    Object.entries(values)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n"
  );
}
// Replica 1 keeps the original container name, so existing deployments upgrade in place.
export function replicaNames(c: Config, a: App, color: string): string[] {
  return Array.from(
    { length: a.replicas },
    (_, i) => `two-${c.name}-${a.name}-${color}${i ? `-${i + 1}` : ""}`,
  );
}
export function appLock(a: App) {
  return `exec 8>/var/lock/2server-app-${a.name}.lock\nflock -w 120 8`;
}
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
stop_generation() { local n; for n in $(containers "$1"); do docker stop -t 60 "$n" >/dev/null; done; }
start_generation() { local n; for n in $(containers "$1"); do docker start "$n" >/dev/null; done; }
`;
}
function probe(c: Config, a: App, variable: string) {
  return a.kind === "worker"
    ? `[ "$(docker inspect -f '{{.State.Health.Status}}' "${variable}")" = healthy ]`
    : `docker run --rm --network ${quote(c.edge.network)} curlimages/curl:8.12.1 -fsS --connect-timeout 2 --max-time 3 "http://${variable}:${a.port}${a.healthPath}" >/dev/null 2>&1`;
}
function upstreamSnippet(a: App, names: string[]) {
  return `(up_two_${a.name}) {\n  ${names.length ? `reverse_proxy ${names.map((n) => `${n}:${a.port}`).join(" ")}` : 'respond "Service scaled to zero" 503'}\n}\n`;
}
export function deployScript(c: Config, a: App, release: string): string {
  const root = `/opt/2server/apps/${a.name}`;
  const snippet = `/opt/2server/edge/apps/${a.name}.caddy`;
  return `set -euo pipefail
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
${a.replicas ? `docker pull ${quote(a.image)} >/dev/null` : ""}
${
  a.kind === "worker" && a.replicas
    ? `health=$(docker image inspect -f '{{if .Config.Healthcheck}}{{index .Config.Healthcheck.Test 0}}{{end}}' ${quote(a.image)})
case "$health" in CMD|CMD-SHELL) ;; *) echo 'Workers require an image HEALTHCHECK' >&2; exit 1;; esac`
    : ""
}
backup=$(mktemp)
existed=false
if [ -f ${snippet} ]; then cp ${snippet} "$backup"; existed=true; fi
switched=false
restore() {
  if [ "$switched" = true ]; then
    if [ "$existed" = true ]; then cp "$backup" ${snippet}; else rm -f ${snippet}; fi
    docker exec ${quote(c.edge.container)} caddy reload --config ${quote(c.edge.configPath)} >/dev/null 2>&1 || true
  fi
  for n in "\${new_names[@]}"; do docker rm -f "$n" >/dev/null 2>&1 || true; done
  ${a.kind === "worker" ? 'if [ -n "$old" ]; then start_generation "$old"; fi' : ""}
  rm -f "$backup"
}
trap 'restore' ERR
${a.kind === "worker" ? 'if [ -n "$old" ]; then stop_generation "$old"; fi' : ""}
for new in "\${new_names[@]}"; do
  docker run -d --name "$new" --restart unless-stopped --network ${quote(c.edge.network)} \
    --label io.2server.owner=${c.name} --label io.2server.app=${a.name} --label io.2server.generation="$color" \
    --memory ${a.memoryMb}m --cpus ${a.cpus} --pids-limit 256 --security-opt no-new-privileges:true --cap-drop ALL \
    --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
    --env-file ${root}/releases/${release}/app.env ${quote(a.image)} ${(a.command ?? []).map(quote).join(" ")} >/dev/null
  ready=false
  for attempt in $(seq 1 30); do
    if ${probe(c, a, "$new")}; then ready=true; break; fi
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
docker exec ${quote(c.edge.container)} caddy validate --config ${quote(c.edge.configPath)} >/dev/null
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
if [ -n "$old" ]; then sleep 70; stop_generation "$old"; fi`
    : ""
}
echo 'App deployed: ${a.name} (${a.replicas} replicas)'
`;
}
export async function deployApp(c: Config, a: App) {
  const oldKind = await remote(
    c,
    `if [ -f /opt/2server/apps/${a.name}/current ]; then color=$(cat /opt/2server/apps/${a.name}/current); jq -r '.kind // "service"' /opt/2server/apps/${a.name}/$color.json; fi`,
  );
  if (oldKind.trim() && oldKind.trim() !== a.kind)
    throw new Error(
      "Changing a workload between service and worker requires a new app name",
    );
  const release = crypto.randomUUID();
  await upload(
    c,
    {
      "app.env": a.replicas ? await resolveEnv(a) : "\n",
      "app.json": JSON.stringify(a),
    },
    `/opt/2server/apps/${a.name}/releases/${release}`,
  );
  await remote(c, deployScript(c, a, release));
}
export async function rollbackApp(c: Config, a: App) {
  const root = `/opt/2server/apps/${a.name}`;
  const previous = await remote(
    c,
    `set -euo pipefail; color=$(cat ${root}/previous); case "$color" in blue|green) cat ${root}/$color.json;; *) exit 1;; esac`,
  );
  const prior = appSchema.parse(JSON.parse(previous));
  await remote(c, rollbackScript(c, a, prior, previous));
  return prior;
}
export function rollbackScript(
  c: Config,
  a: App,
  prior: App,
  previous: string,
): string {
  const root = `/opt/2server/apps/${a.name}`,
    snippet = `/opt/2server/edge/apps/${a.name}.caddy`;
  return `set -euo pipefail
${appLock(a)}
${runtimeHelpers(c, a)}
old=$(cat "$root/current")
color=$(cat "$root/previous")
case "$old:$color" in blue:green|green:blue) ;; *) exit 1;; esac
test "$(cat "$root/$color.json")" = ${quote(previous.trim())}
restore() { stop_generation "$color"; start_generation "$old"; }
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
docker exec ${quote(c.edge.container)} caddy validate --config ${quote(c.edge.configPath)} >/dev/null
docker exec ${quote(c.edge.container)} caddy reload --config ${quote(c.edge.configPath)} >/dev/null
rm -f "$backup"
flock -u 9`
    : ""
}
trap - ERR
printf '%s\n' "$color" > "$root/current"
printf '%s\n' "$old" > "$root/previous"
${prior.kind === "service" ? 'sleep 70; stop_generation "$old"' : ""}
`;
}
