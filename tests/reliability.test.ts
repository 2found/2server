import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema, redisSchema, natsSchema } from "../src/config";
import { runtimeHealthFiles } from "../src/runtime-health";
import { upstreamSnippet } from "../src/apps";
import { monitoringCompose } from "../src/extensions";
import { run } from "../src/process";
const base = { version: 1, name: "test", ssh: { kind: "ssh", host: "example.com", user: "deploy" }, edge: { mode: "managed" } };
test("durability settings reject unsafe memory and invalid fsync configuration", () => {
  expect(redisSchema.parse({ passwordEnv: "REDIS_PASSWORD" }).appendfsync).toBe("everysec");
  expect(() => redisSchema.parse({ passwordEnv: "REDIS_PASSWORD", maxmemoryMb: 200 })).toThrow("50%");
  expect(() => redisSchema.parse({ passwordEnv: "REDIS_PASSWORD", appendfsync: "no" })).toThrow();
  expect(natsSchema.parse({ tokenEnv: "NATS_TOKEN", jetstream: true }).syncInterval).toBe("always");
  expect(() => natsSchema.parse({ tokenEnv: "NATS_TOKEN", syncInterval: "0s" })).toThrow();
});
test("runtime observer reports missing/unhealthy replicas, excludes parked/scaled-zero/retired resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "two-observer-"));
  const c = configSchema.parse(base);
  try {
    for (const dir of ["bin", "apps/api", "apps/zero", "extensions/redis/current"])
      await mkdir(join(root, dir), { recursive: true });
    await Bun.write(join(root, "apps/api/current"), "green");
    await Bun.write(join(root, "apps/api/green.json"), JSON.stringify({ replicas: 3, port: 8080, healthPath: "/readyz" }));
    await Bun.write(join(root, "apps/zero/current"), "blue");
    await Bun.write(join(root, "apps/zero/blue.json"), JSON.stringify({ replicas: 0 }));
    await Bun.write(join(root, "extensions/redis/current/extension.json"), "{}");
    await Bun.write(join(root, "extensions/redis/retired"), "");
    await Bun.write(join(root, "bin/docker"), `#!/bin/bash
case "\${@: -1}" in
  *-green) echo '{"state":{"Running":true,"Health":{"Status":"healthy"}},"restarts":0,"owner":"test","networks":{"edge":{"IPAddress":"172.18.0.2"}}}';;
  *-green-2) echo '{"state":{"Running":true,"Health":{"Status":"unhealthy"},"OOMKilled":true},"restarts":5,"owner":"test","networks":{"edge":{"IPAddress":"172.18.0.3"}}}';;
  *) exit 1;;
esac
`);
    await Bun.write(join(root, "bin/curl"), '#!/bin/bash\ncase "$*" in *172.18.0.2*) echo 200;; *) echo 503;; esac\n');
    await Bun.write(join(root, "bin/timeout"), '#!/bin/bash\nshift\nexec "$@"\n');
    for (const file of ["docker", "timeout", "curl"]) await chmod(join(root, "bin", file), 0o755);
    const p = Bun.spawn(["bash", "-se"], { env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` },
      stdin: new Blob([runtimeHealthFiles(c)["runtime-metrics.sh"].replaceAll("/opt/2server", root)]), stdout: "pipe", stderr: "pipe" });
    const err = await new Response(p.stderr).text();
    expect(await p.exited, err).toBe(0);
    const metrics = await Bun.file(join(root, "metrics/runtime.prom")).text();
    expect(metrics).toContain('two_container_healthy{container="two-test-api-green"} 1');
    expect(metrics).toContain('two_container_healthy{container="two-test-api-green-2"} 0');
    expect(metrics).toContain('two_container_running{container="two-test-api-green-3"} 0');
    expect(metrics).toContain('two_container_restarts_total{container="two-test-api-green-2"} 5');
    expect(metrics).toContain('two_app_ready{container="two-test-api-green"} 1');
    expect(metrics).toContain('two_app_ready{container="two-test-api-green-2"} 0');
    expect(metrics).toContain('two_app_ready{container="two-test-api-green-3"} 0');
    expect(metrics).not.toContain("-blue");
    expect(metrics).not.toContain("-zero");
    expect(metrics).not.toContain("-redis");
    // Existing Compose apps are observed through their live Caddy pointer, so
    // a later blue/green switch does not leave a stale container name pinned.
    const upstream = join(root, "external.caddy");
    await Bun.write(upstream, "(up_external) {\n reverse_proxy external-blue:8080 {\n }\n}\n");
    const external = configSchema.parse({ ...base, extensions: { monitoring: { zone: "example.com", containers: ["external-broker"], upstreams: [{name:"external",file:upstream,healthPath:"/"}] } } });
    const observe = async () => {
      const proc = Bun.spawn(["bash", "-se"], { env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` }, stdin: new Blob([runtimeHealthFiles(external)["runtime-metrics.sh"].replaceAll("/opt/2server", root)]), stdout:"pipe", stderr:"pipe" });
      const err=await new Response(proc.stderr).text(); expect(await proc.exited,err).toBe(0);
      return Bun.file(join(root,"metrics/runtime.prom")).text();
    };
    expect(await observe()).toContain('two_app_ready{container="external-blue"} 0');
    await Bun.write(upstream,"reverse_proxy external-green:8080\n");
    const switched = await observe();
    expect(switched).toContain('two_app_ready{container="external-green"} 1');
    expect(switched).not.toContain('container="external-blue"');
    expect(switched).toContain('two_container_running{container="external-broker"} 0');
    await rm(upstream);
    expect(await observe()).toContain('two_app_ready{container="missing-upstream-external"} 0');
  } finally { await rm(root, { recursive: true, force: true }); }
});
const integration = process.env.DOCKER_TESTS === "1" ? test : test.skip;
integration("real Caddy: unhealthy replica exclusion, recovery, failed connection retry, no replay of POST", async () => {
  const root = await mkdtemp(join(tmpdir(), "two-routing-"));
  const network = `two-routing-${crypto.randomUUID().slice(0, 8)}`;
  const names = [`${network}-a`, `${network}-b`], edge = `${network}-edge`;
  const c = configSchema.parse({ ...base, apps: [{ name: "api", image: `test/api@sha256:${"a".repeat(64)}`, port: 8080, memoryMb: 64, cpus: 1 }] });
  try {
    await run(["docker", "network", "create", network]);
    await Bun.write(join(root, "server.js"), `const fs = require('node:fs'); const http = require('node:http');
http.createServer((req,res) => {
 if(req.url === '/write') { fs.appendFileSync('/fixture/writes-'+process.env.ID, 'write\\n'); req.socket.destroy(); return; }
 if(req.url === '/healthz' && fs.existsSync('/fixture/fail-'+process.env.ID)) res.statusCode=503;
 res.end(process.env.ID);
}).listen(8080, '0.0.0.0');`);
    for (const [i, name] of names.entries()) await run(["docker", "run", "-d", "--name", name, "--network", network,
      "--init", "--restart", "unless-stopped", "-e", `ID=${i}`, "-v", `${root}:/fixture`, "oven/bun:1-alpine", "bun", "/fixture/server.js"]);
    await Bun.write(join(root, "Caddyfile"), `{\n auto_https off\n}\n${upstreamSnippet(c.apps[0], names)}\n:8080 {\n import up_two_api\n}\n`);
    await run(["docker", "run", "-d", "--name", edge, "--network", network, "-p", "127.0.0.1::8080", "-v", `${root}/Caddyfile:/etc/caddy/Caddyfile:ro`, "caddy:2.10.2-alpine"]);
    const baseUrl = `http://${(await run(["docker", "port", edge, "8080/tcp"])).trim()}`;
    const request = () => fetch(baseUrl, { signal: AbortSignal.timeout(5000) });
    for (let i=0;i<50;i++) { try { if ((await request()).ok) break; } catch {} await Bun.sleep(200); }
    expect((await request()).status).toBe(200);
    await Bun.write(join(root, "fail-0"), "unready");
    await Bun.sleep(11000);
    for (let i=0;i<10;i++) expect(await (await request()).text()).toBe("1");
    await rm(join(root, "fail-0"));
    await Bun.sleep(11000);
    const seen = new Set<string>();
    for (let i=0;i<40;i++) seen.add(await (await request()).text());
    expect(seen.size).toBe(2);
    const post = await fetch(baseUrl + "/write", { method: "POST", body: "side-effect", signal: AbortSignal.timeout(6000) });
    expect(post.status).toBe(502);
    let writes = 0;
    for (const i of [0,1]) if (await Bun.file(join(root, `writes-${i}`)).exists()) writes += (await Bun.file(join(root, `writes-${i}`)).text()).trim().split("\n").length;
    expect(writes).toBe(1);
    // The deliberate failed POST passively quarantines one peer for 10s.
    await Bun.sleep(11000);
    await run(["docker", "stop", names[0]]);
    for (let i=0;i<10;i++) expect(await (await request()).text()).toBe("1");
  } finally {
    for (const name of [edge,...names]) await run(["docker", "rm", "-f", name]).catch(() => {});
    await run(["docker", "network", "rm", network]).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 90000);
integration("real monitoring images support generated readiness probes", async () => {
  const c = configSchema.parse({ ...base, extensions: { monitoring: { zone: "example.com" }, alertWebhookEnv: "TEST_ALERT" } });
  for (const service of Object.values(monitoringCompose(c).services) as any[]) {
    // Test binary presence without publishing monitoring endpoints or creating state.
    await run(["docker", "run", "--rm", "--network", "none", "--entrypoint", "sh", service.image, "-ec", "command -v wget"]);
  }
}, 120000);

for (const scenario of ["invalid-config", "unhealthy-update", "unhealthy-first-install"]) {
  test(`monitoring transaction: ${scenario}`, async () => {
    const { monitoringInstallScript } = await import("../src/extensions");
    const root = await mkdtemp(join(tmpdir(), "two-monitor-transaction-"));
    const c = configSchema.parse({ ...base, extensions: { monitoring: { zone: "example.com" } } });
    const existing = scenario !== "unhealthy-first-install";
    try {
      for (const dir of ["bin", "edge", "monitoring/releases/candidate"]) await mkdir(join(root, dir), { recursive: true });
      await Bun.write(join(root, "edge/owner"), c.name);
      const release = join(root, "monitoring/releases/candidate");
      for (const name of ["compose.json", "prometheus.yml", "alerts.yml"]) {
        await Bun.write(join(release, name), name === "compose.json" ? '{"services":{"prometheus":{}},"candidate":true}' : "candidate");
        if (existing) await Bun.write(join(root, "monitoring", name), name === "compose.json" ? '{"services":{"prometheus":{}}}' : "original");
      }
      await Bun.write(join(root, "bin/docker"), `#!/bin/bash
printf '%s\\n' "$*" >> '${root}/calls'
${scenario === "invalid-config" ? 'exit 1' : `if [[ "$*" == *'up -d'* ]] && grep -q candidate '${root}/monitoring/compose.json'; then exit 1; fi`}
exit 0
`);
      await chmod(join(root, "bin/docker"), 0o755);
      const script = monitoringInstallScript(c, release).replaceAll("/opt/2server", root).replaceAll("/var/lock/", `${root}/`);
      const p = Bun.spawn(["bash", "-se"], { env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` }, stdin: new Blob([script]), stdout: "pipe", stderr: "pipe" });
      await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      expect(await p.exited).not.toBe(0);
      if (existing) expect(await Bun.file(join(root, "monitoring/prometheus.yml")).text()).toBe("original");
      else expect(await Bun.file(join(root, "monitoring/compose.json")).exists()).toBe(false);
      const calls = await Bun.file(join(root, "calls")).text();
      if (scenario === "invalid-config") expect(calls).not.toContain("up -d");
      if (scenario === "unhealthy-update") expect(calls.match(/up -d/g)?.length).toBe(2);
      if (!existing) expect(calls).toContain(" down");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

integration("real monitoring stack: all readiness checks and private scrape targets", async () => {
  const { monitoringFiles } = await import("../src/extensions");
  const root = await mkdtemp(join(tmpdir(), "two-monitor-stack-"));
  const name = `monitor-${crypto.randomUUID().slice(0, 8)}`, network = `two-${name}-edge`, project = `two-${name}`;
  process.env.TWO_STACK_ALERT = "https://example.com/unused-test-receiver";
  const c = configSchema.parse({ ...base, name, edge: { mode: "managed", network }, extensions: { monitoring: { zone: "example.com" }, alertWebhookEnv: "TWO_STACK_ALERT" } });
  const file = join(root, "compose.json");
  try {
    await chmod(root, 0o755);
    await mkdir(join(root, "metrics"));
    const files = monitoringFiles(c);
    const compose = JSON.parse(files["compose.json"]);
    compose.services.prometheus.ports = ["127.0.0.1::9090"];
    compose.services.alertmanager.ports = [];
    // No real outbound receiver is contacted; this test checks delivery config
    // readiness and scraping, not notification integration.
    files["alerts.yml"] = "groups: []\n";
    // Docker Desktop cannot expose Linux host metrics via macOS's root mount.
    compose.services["node-exporter"].volumes = [`${root}/metrics:/metrics:ro`];
    compose.services["node-exporter"].command = ["--collector.textfile.directory=/metrics"];
    delete compose.services["node-exporter"].pid;
    files["compose.json"] = JSON.stringify(compose);
    for (const [name, value] of Object.entries(files)) { await Bun.write(join(root, name), value); await chmod(join(root,name), 0o644); }
    await run(["docker", "network", "create", network]);
    await run(["docker", "compose", "-p", project, "-f", file, "up", "-d", "--wait", "--wait-timeout", "90"]);
    const url = `http://${(await run(["docker", "port", `two-${name}-prometheus`, "9090/tcp"])).trim()}`;
    let targets: any[] = [];
    for (let i=0;i<40;i++) {
      targets = ((await (await fetch(url + "/api/v1/targets")).json()) as any).data.activeTargets;
      if (targets.length === 3 && targets.every(t=>t.health === "up")) break;
      await Bun.sleep(1000);
    }
    expect(targets.length).toBe(3);
    expect(targets.every(t=>t.health === "up")).toBe(true);
    const node = JSON.parse(await run(["docker", "inspect", `two-${name}-node-exporter`]))[0];
    expect(node.NetworkSettings.Networks[network]).toBeUndefined();
  } finally {
    await run(["docker", "compose", "-p", project, "-f", file, "down", "--volumes"]).catch(() => {});
    await run(["docker", "network", "rm", network]).catch(() => {});
    delete process.env.TWO_STACK_ALERT;
    await rm(root, { recursive: true, force: true });
  }
}, 120000);
