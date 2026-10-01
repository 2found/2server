import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config";
import { quote, remote, run, sshArgs } from "./process";
import { renderSite } from "./render";
import type { AuthMap } from "./monitoring";
export const edgeRoot = "/opt/2server/edge";
export async function preflightEdge(c: Config) {
  const previous = await remote(
    c,
    `if [ -f ${edgeRoot}/current/domains.json ]; then cat ${edgeRoot}/current/domains.json; else printf '[]'; fi`,
  );
  const oldHosts = JSON.parse(previous) as string[];
  const hosts = new Set(c.domains.flatMap((d) => d.hosts));
  if (oldHosts.some((h) => !hosts.has(h)))
    throw new Error(
      "Removing a published hostname requires explicit DNS retirement first; retain existing domains in this manifest",
    );
  return remote(
    c,
    `set -euo pipefail
command -v flock >/dev/null
command -v docker >/dev/null
docker inspect ${quote(c.edge.container)} >/dev/null
docker exec ${quote(c.edge.container)} sh -ec 'test -d /etc/2server/apps && test -d /etc/2server/current/sites'
test -f ${edgeRoot}/owner
test "$(cat ${edgeRoot}/owner)" = ${quote(c.name)}
docker exec ${quote(c.edge.container)} grep -F '/etc/2server/current/sites/*.caddy' ${quote(c.edge.configPath)} >/dev/null
`,
  );
}
// Payloads travel over SSH stdin. No private key or secret appears in argv.
export async function upload(
  c: Config,
  files: Record<string, string>,
  target: string,
) {
  const temp = await mkdtemp(join(tmpdir(), "2server-"));
  try {
    for (const [path, value] of Object.entries(files)) {
      if (path.startsWith("/") || path.split("/").includes(".."))
        throw new Error("Invalid bundle path");
      const full = join(temp, path);
      await mkdir(join(full, ".."), { recursive: true, mode: 0o700 });
      await Bun.write(full, value, { mode: 0o600 });
    }
    await run([
      "tar",
      "-czf",
      join(temp, "bundle.tgz"),
      "-C",
      temp,
      ...Object.keys(files),
    ]);
    const bytes = new Uint8Array(
      await Bun.file(join(temp, "bundle.tgz")).arrayBuffer(),
    );
    await run(
      sshArgs(
        c,
        `sudo -n bash -c ${quote(`set -euo pipefail; umask 077; mkdir -p ${quote(target)}; tar -xzf - -C ${quote(target)} --no-same-owner`)}`,
      ),
      bytes,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
export function activateScript(c: Config, release: string, merge = false) {
  return `set -euo pipefail
exec 9>/var/lock/2server-edge.lock
flock -w 120 9
cd ${edgeRoot}
test "$(cat owner)" = ${quote(c.name)}
old=$(readlink current)
${
  merge
    ? `# Merge under the host lock so extension-only changes retain every live site.
combined=$(mktemp -d releases/.merge.XXXXXX)
trap 'rm -rf "$combined"' ERR
cp -a current/. "$combined/"
cp -a releases/${release}/. "$combined/"
{ if [ -f current/domains.json ]; then cat current/domains.json; else printf '[]'; fi; cat releases/${release}/domains.json; } | jq -s 'add | unique' > "$combined/domains.json"
cp -a "$combined"/. releases/${release}/
rm -rf "$combined"
trap - ERR
`
    : ""
}
rm -f current.next current.restore
restore() {
  ln -s "$old" current.restore
  mv -Tf current.restore current
}
trap 'restore' ERR
ln -s ${quote(`releases/${release}`)} current.next
mv -Tf current.next current
docker exec ${quote(c.edge.container)} caddy validate --config ${quote(c.edge.configPath)} >/dev/null
docker exec ${quote(c.edge.container)} caddy reload --config ${quote(c.edge.configPath)} >/dev/null
trap - ERR
printf '%s\n' "$old" > previous
printf '%s\n' ${quote(release)}
`;
}
export async function installDomains(
  c: Config,
  pairs: Record<string, { cert: string; key: string }>,
  auth: AuthMap = {},
  merge = false,
) {
  const release = crypto.randomUUID();
  const files: Record<string, string> = {};
  for (const d of c.domains) {
    files[`sites/${d.name}.caddy`] = renderSite(d, auth[d.name]);
    files[`tls/${d.name}/cert.pem`] = pairs[d.name].cert;
    files[`tls/${d.name}/key.pem`] = pairs[d.name].key;
  }
  files["sites/.keep"] = "";
  files["domains.json"] = JSON.stringify(c.domains.flatMap((d) => d.hosts));
  await upload(c, files, `${edgeRoot}/releases/${release}`);
  await remote(c, activateScript(c, release, merge));
  return release;
}
export function originProbeScript(
  c: Config,
  host: string,
  path: string,
  expected: string,
  authorization?: string,
) {
  const input = authorization
    ? `printf '%s\\n' ${quote("header = " + JSON.stringify("Authorization: " + authorization))} | `
    : "";
  return `set -euo pipefail
code=$(${input}docker run --rm ${authorization ? "-i " : ""}--network ${quote(c.edge.network)} curlimages/curl:8.12.1 -sk --connect-timeout 5 --max-time 20 ${authorization ? "--config - " : ""}--connect-to ${quote(`${host}:443:${c.edge.container}:443`)} -o /dev/null -w '%{http_code}' ${quote(`https://${host}${path}`)})
case "$code" in ${expected}) ;; *) exit 1;; esac
`;
}
export async function verifyOrigin(c: Config, auth: AuthMap = {}) {
  for (const d of c.domains)
    for (const host of d.hosts) {
      if (d.requireAuth) {
        const credential = auth[d.name];
        if (!credential)
          throw new Error(`Missing credentials to verify ${d.name}`);
        await remote(c, originProbeScript(c, host, "/-/ready", "401"));
        const authorization =
          "Basic " +
          Buffer.from(`${credential.username}:${credential.password}`).toString(
            "base64",
          );
        await remote(
          c,
          originProbeScript(c, host, "/-/ready", "200", authorization),
        );
      } else
        await remote(
          c,
          originProbeScript(c, host, "/", d.cache === "app" ? "2*|3*" : "404"),
        );
    }
}

export async function rollbackDomains(c: Config, release: string) {
  await remote(
    c,
    `set -euo pipefail
exec 9>/var/lock/2server-edge.lock
flock -w 120 9
cd ${edgeRoot}
test "$(readlink current)" = ${quote(`releases/${release}`)}
old=$(cat previous)
ln -s "$old" current.rollback
mv -Tf current.rollback current
docker exec ${quote(c.edge.container)} caddy reload --config ${quote(c.edge.configPath)} >/dev/null
`,
  );
}
