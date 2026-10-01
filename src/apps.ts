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
export function deployScript(c: Config, a: App, release: string): string {
  if (a.kind === "worker") return workerScript(c, a, release);
  const app = `two-${c.name}-${a.name}`,
    root = `/opt/2server/apps/${a.name}`,
    snippet = `/opt/2server/edge/apps/${a.name}.caddy`;
  return `set -euo pipefail
exec 8>/var/lock/2server-app-${a.name}.lock
flock -w 120 8
mkdir -p ${root}
old=$(cat ${root}/current 2>/dev/null || true)
case "$old" in blue) color=green;; *) color=blue;; esac
new=${app}-$color
# Only a previous parked candidate is removed. The live colour is untouched.
docker rm -f "$new" >/dev/null 2>&1 || true
docker pull ${quote(a.image)} >/dev/null
docker run -d --name "$new" --restart unless-stopped --network ${quote(c.edge.network)} \\
  --memory ${a.memoryMb}m --cpus ${a.cpus} --pids-limit 256 \\
  --security-opt no-new-privileges:true --cap-drop ALL \\
  --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \\
  --env-file ${root}/releases/${release}/app.env ${quote(a.image)} ${(a.command ?? []).map(quote).join(" ")} >/dev/null
ready=false
for attempt in $(seq 1 30); do
  if docker run --rm --network ${quote(c.edge.network)} curlimages/curl:8.12.1 -fsS --connect-timeout 2 --max-time 3 "http://$new:${a.port}${a.healthPath}" >/dev/null 2>&1; then ready=true; break; fi
  sleep 2
done
if [ "$ready" != true ]; then docker rm -f "$new" >/dev/null; echo 'Candidate failed health check; live app unchanged' >&2; exit 1; fi
exec 9>/var/lock/2server-edge.lock
flock -w 120 9
backup=$(mktemp)
existed=false
if [ -f ${snippet} ]; then cp ${snippet} "$backup"; existed=true; fi
restore() {
  if [ "$existed" = true ]; then cp "$backup" ${snippet}; else rm -f ${snippet}; fi
  rm -f "$backup"
  docker rm -f "$new" >/dev/null
}
trap 'restore' ERR
cp ${root}/releases/${release}/app.json ${root}/$color.json
printf '%s\n' "$color" > ${root}/current.next
printf '%s\n' "$old" > ${root}/previous.next
printf '(up_two_${a.name}) {\n  reverse_proxy %s:${a.port}\n}\n' "$new" > ${snippet}.next
mv ${snippet}.next ${snippet}
docker exec ${quote(c.edge.container)} caddy validate --config ${quote(c.edge.configPath)} >/dev/null
docker exec ${quote(c.edge.container)} caddy reload --config ${quote(c.edge.configPath)} >/dev/null
trap - ERR
mv ${root}/current.next ${root}/current
mv ${root}/previous.next ${root}/previous
rm -f "$backup"
flock -u 9
# Match Caddy's 60s grace period; keep old connections alive while draining.
if [ -n "$old" ]; then sleep 70; docker stop -t 10 ${app}-"$old" >/dev/null; fi
echo 'App deployed: ${a.name}'
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
    { "app.env": await resolveEnv(a), "app.json": JSON.stringify(a) },
    `/opt/2server/apps/${a.name}/releases/${release}`,
  );
  await remote(c, deployScript(c, a, release));
}

function workerScript(c: Config, a: App, release: string): string {
  const root = `/opt/2server/apps/${a.name}`,
    app = `two-${c.name}-${a.name}`;
  return `set -euo pipefail
exec 8>/var/lock/2server-app-${a.name}.lock
flock -w 120 8
old=$(cat ${root}/current 2>/dev/null || true)
case "$old" in blue) color=green;; *) color=blue;; esac
new=${app}-$color
docker pull ${quote(a.image)} >/dev/null
# Workers require a real image HEALTHCHECK, not just a running process.
test "$(docker image inspect -f '{{if .Config.Healthcheck}}{{index .Config.Healthcheck.Test 0}}{{end}}' ${quote(a.image)})" = CMD-SHELL || \
  test "$(docker image inspect -f '{{if .Config.Healthcheck}}{{index .Config.Healthcheck.Test 0}}{{end}}' ${quote(a.image)})" = CMD
docker rm -f "$new" >/dev/null 2>&1 || true
restore() {
  docker rm -f "$new" >/dev/null 2>&1 || true
  if [ -n "$old" ]; then docker start ${app}-"$old" >/dev/null; fi
}
trap 'restore' ERR
# Never run two worker generations concurrently: queue semantics belong to the app.
if [ -n "$old" ]; then docker stop -t 60 ${app}-"$old" >/dev/null; fi
docker run -d --name "$new" --restart unless-stopped --network ${quote(c.edge.network)} \
  --memory ${a.memoryMb}m --cpus ${a.cpus} --pids-limit 256 --cap-drop ALL --security-opt no-new-privileges:true \
  --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
  --env-file ${root}/releases/${release}/app.env ${quote(a.image)} ${(a.command ?? []).map(quote).join(" ")} >/dev/null
ready=false
for attempt in $(seq 1 60); do
  if [ "$(docker inspect -f '{{.State.Health.Status}}' "$new")" = healthy ]; then ready=true; break; fi
  sleep 2
done
[ "$ready" = true ]
trap - ERR
cp ${root}/releases/${release}/app.json ${root}/$color.json
printf '%s\n' "$color" > ${root}/current
printf '%s\n' "$old" > ${root}/previous
`;
}
export async function rollbackApp(c: Config, a: App) {
  const root = `/opt/2server/apps/${a.name}`,
    app = `two-${c.name}-${a.name}`,
    snippet = `/opt/2server/edge/apps/${a.name}.caddy`;
  // The saved previous contract tells us its health port/path, even if changed
  // in the latest manifest. Read it again under the lock to detect a raced roll.
  const previous = await remote(
    c,
    `set -euo pipefail; color=$(cat ${root}/previous); case "$color" in blue|green) cat ${root}/$color.json;; *) exit 1;; esac`,
  );
  const prior = appSchema.parse(JSON.parse(previous));
  await remote(c, rollbackScript(c, a, prior, previous));
}
export function rollbackScript(
  c: Config,
  a: App,
  prior: App,
  previous: string,
): string {
  const root = `/opt/2server/apps/${a.name}`,
    app = `two-${c.name}-${a.name}`,
    snippet = `/opt/2server/edge/apps/${a.name}.caddy`;
  return `set -euo pipefail
exec 8>/var/lock/2server-app-${a.name}.lock
flock -w 120 8
old=$(cat ${root}/current)
color=$(cat ${root}/previous)
case "$old:$color" in blue:green|green:blue) ;; *) exit 1;; esac
test "$(cat ${root}/$color.json)" = ${quote(previous.trim())}
new=${app}-$color
${prior.kind === "worker" ? `docker stop -t 60 ${app}-"$old" >/dev/null` : ""}
restore() { docker stop -t 10 "$new" >/dev/null 2>&1 || true; docker start ${app}-"$old" >/dev/null; }
trap 'restore' ERR
docker start "$new" >/dev/null
ready=false
for attempt in $(seq 1 60); do
  if ${prior.kind === "worker" ? `[ "$(docker inspect -f '{{.State.Health.Status}}' "$new")" = healthy ]` : `docker run --rm --network ${quote(c.edge.network)} curlimages/curl:8.12.1 -fsS --connect-timeout 2 --max-time 3 "http://$new:${prior.port}${prior.healthPath}" >/dev/null 2>&1`}; then ready=true; break; fi
  sleep 2
done
[ "$ready" = true ]
${
  prior.kind === "service"
    ? `exec 9>/var/lock/2server-edge.lock
flock -w 120 9
backup=$(mktemp)
cp ${snippet} "$backup"
trap 'cat "$backup" > ${snippet}; rm -f "$backup"; restore' ERR
printf '(up_two_${a.name}) {\n reverse_proxy %s:${prior.port}\n}\n' "$new" > ${snippet}
docker exec ${quote(c.edge.container)} caddy reload --config ${quote(c.edge.configPath)} >/dev/null
rm -f "$backup"
flock -u 9`
    : ""
}
trap - ERR
printf '%s\n' "$color" > ${root}/current
printf '%s\n' "$old" > ${root}/previous
${prior.kind === "service" ? `sleep 70; docker stop -t 10 ${app}-"$old" >/dev/null` : ""}
`;
}
