import { test, expect } from "bun:test";
import {
  mkdtemp,
  mkdir,
  rm,
  chmod,
  symlink,
  readlink,
  cp,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configSchema } from "../src/config";
import { activateScript, originProbeScript } from "../src/edge";
import { monitoringAuth, monitoringDomain } from "../src/monitoring";
import { renderSite, baseCaddyfile } from "../src/render";
import { run as quietRun } from "../src/process";
// These scripts use test-only credentials. Keep useful Caddy validation errors
// in failed integration assertions without changing production secret handling.
async function run(args: string[], input?: string | Uint8Array) {
  if (args[0] !== "bash") return quietRun(args, input);
  const p = Bun.spawn(args, {
    stdin: input === undefined ? "ignore" : new Blob([input as BlobPart]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code) throw new Error(`Fixture script failed: ${err}`);
  return out;
}
import { monitoringCompose, monitoringFiles } from "../src/extensions";
const integration = process.env.DOCKER_TESTS === "1" ? test : test.skip;
integration(
  "real Prometheus: generated configuration starts and lifecycle writes stay disabled",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "2server-prometheus-"));
    const ctr = `two-prom-test-${crypto.randomUUID().slice(0, 8)}`;
    const c = configSchema.parse({
      version: 1,
      name: "test",
      ssh: { kind: "ssh", host: "example.com", user: "deploy" },
      edge: { mode: "managed" },
      domains: [],
      extensions: { monitoring: { zone: "example.com" } },
    });
    const service = monitoringCompose(c).services.prometheus as {
      image: string;
      command: string[];
    };
    try {
      await chmod(root, 0o755);
      for (const [name, value] of Object.entries(monitoringFiles(c))) {
        await Bun.write(join(root, name), value);
        await chmod(join(root, name), 0o644);
      }
      await run([
        "docker",
        "run",
        "-d",
        "--name",
        ctr,
        "-p",
        "127.0.0.1::9090",
        "--tmpfs",
        "/prometheus:rw,mode=1777",
        "-v",
        `${root}/prometheus.yml:/etc/prometheus/prometheus.yml:ro`,
        "-v",
        `${root}/alerts.yml:/etc/prometheus/alerts.yml:ro`,
        service.image,
        ...service.command,
      ]);
      const address = (await run(["docker", "port", ctr, "9090/tcp"])).trim();
      const base = `http://${address}`;
      let ready = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        try {
          ready =
            (
              await fetch(`${base}/-/ready`, {
                signal: AbortSignal.timeout(1000),
              })
            ).status === 200;
        } catch {}
        if (ready) break;
        if (
          (
            await run(["docker", "inspect", "-f", "{{.State.Running}}", ctr])
          ).trim() !== "true"
        )
          throw new Error("Generated Prometheus configuration failed to start");
        await Bun.sleep(250);
      }
      expect(ready).toBe(true);
      const flags = (await (
        await fetch(`${base}/api/v1/status/flags`)
      ).json()) as any;
      expect(flags.data["web.enable-lifecycle"]).toBe("false");
      expect(flags.data["web.enable-admin-api"]).toBe("false");
      expect((await fetch(`${base}/-/reload`, { method: "POST" })).status).toBe(
        403,
      );
    } finally {
      await run(["docker", "rm", "-f", ctr]).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  },
  120000,
);
integration(
  "real Caddy: API routing, prefix strip, invalid candidate rollback, valid candidate activation",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "2server-runtime-"));
    const ctr = `two-test-${crypto.randomUUID().slice(0, 8)}`;
    const c = configSchema.parse({
      version: 1,
      name: "test",
      ssh: { kind: "ssh", host: "example.com", user: "deploy" },
      originIp: "192.0.2.10",
      edge: { mode: "managed", container: ctr },
      domains: [
        {
          name: "test",
          zone: "example.com",
          hosts: ["example.com"],
          upstream: { kind: "proxy", target: "127.0.0.1:8081" },
          routes: [
            {
              prefix: "/api",
              strip: true,
              upstream: { kind: "proxy", target: "127.0.0.1:8082" },
            },
          ],
        },
      ],
    });
    try {
      for (const dir of [
        "apps",
        "releases/initial/sites",
        "releases/good/sites",
        "releases/good/tls/test",
        "releases/bad/sites",
        "bin",
      ])
        await mkdir(join(root, dir), { recursive: true });
      await Bun.write(join(root, "owner"), "test");
      await symlink("releases/initial", join(root, "current"));
      await run([
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "90",
        "-keyout",
        join(root, "releases/good/tls/test/key.pem"),
        "-out",
        join(root, "releases/good/tls/test/cert.pem"),
        "-subj",
        "/CN=example.com",
      ]);
      await Bun.write(
        join(root, "releases/good/sites/test.caddy"),
        renderSite(c.domains[0]),
      );
      await Bun.write(
        join(root, "releases/bad/sites/test.caddy"),
        "example.com {\n invalid_directive\n}\n",
      );
      await Bun.write(
        join(root, "Caddyfile"),
        baseCaddyfile +
          '\n:8081 {\n respond "web"\n}\n:8082 {\n respond "api:{path}"\n}\n',
      );
      await run([
        "docker",
        "run",
        "-d",
        "--name",
        ctr,
        "-v",
        `${root}:/etc/2server:ro`,
        "-v",
        `${root}/Caddyfile:/etc/caddy/Caddyfile:ro`,
        "caddy:2-alpine",
      ]);
      // Run the production switch script against real Docker/Caddy. GNU mv is
      // required on macOS, where BSD mv does not support -T.
      const mv = process.platform === "darwin" ? "gmv" : "mv";
      const script = (release: string, merge = false) =>
        activateScript(c, release, merge)
          .replaceAll("/opt/2server/edge", root)
          .replace("/var/lock/2server-edge.lock", join(root, "edge.lock"))
          .replaceAll("mv -Tf", `${mv} -Tf`)
          .replace("docker exec", "sleep 1\ndocker exec");
      await expect(run(["bash", "-se"], script("bad"))).rejects.toThrow();
      expect(await readlink(join(root, "current"))).toBe("releases/initial");
      await run(["bash", "-se"], script("good"));
      expect(await readlink(join(root, "current"))).toBe("releases/good");
      await run([
        "docker",
        "exec",
        ctr,
        "sh",
        "-c",
        'echo "127.0.0.1 example.com" >> /etc/hosts',
      ]);
      const request = (path: string) =>
        run([
          "docker",
          "exec",
          ctr,
          "wget",
          "-qO-",
          "--no-check-certificate",
          "--header=Host: example.com",
          `https://example.com${path}`,
        ]);
      expect(await request("/")).toBe("web");
      expect(await request("/api/healthz")).toBe("api:/healthz");
      await expect(run(["bash", "-se"], script("bad"))).rejects.toThrow();
      expect(await readlink(join(root, "current"))).toBe("releases/good");
      expect(await request("/")).toBe("web");
      // Deploy only the monitoring domain: existing app routes and certs survive.
      c.extensions.monitoring = true;
      const domain = monitoringDomain(c)!;
      domain.upstream = { kind: "proxy", target: "127.0.0.1:8082" };
      const credentials = (await monitoringAuth(c, join(root, "operator")))[
        domain.name
      ];
      await mkdir(join(root, "releases/monitor/sites"), { recursive: true });
      await mkdir(join(root, `releases/monitor/tls/${domain.name}`), {
        recursive: true,
      });
      await cp(
        join(root, "releases/good/tls/test"),
        join(root, `releases/monitor/tls/${domain.name}`),
        { recursive: true },
      );
      await Bun.write(
        join(root, "releases/good/domains.json"),
        JSON.stringify(["example.com"]),
      );
      await Bun.write(
        join(root, "releases/monitor/domains.json"),
        JSON.stringify(domain.hosts),
      );
      await Bun.write(
        join(root, `releases/monitor/sites/${domain.name}.caddy`),
        renderSite(domain, credentials),
      );
      await run(["bash", "-se"], script("monitor", true));
      expect(await request("/")).toBe("web");
      expect(await request("/api/healthz")).toBe("api:/healthz");
      expect(await Bun.file(join(root, "current/domains.json")).json()).toEqual(
        ["example.com", "monitor.example.com"],
      );
      const probeConfig = {
        ...c,
        edge: { ...c.edge, network: `container:${ctr}` },
      };
      const probe = (status: string, authorization?: string) =>
        originProbeScript(
          probeConfig,
          "monitor.example.com",
          "/-/ready",
          status,
          authorization,
        ).replace(`${ctr}:443`, "127.0.0.1:443");
      await run(["bash", "-se"], probe("401"));
      const authorization =
        "Basic " +
        Buffer.from(`${credentials.username}:${credentials.password}`).toString(
          "base64",
        );
      await run(["bash", "-se"], probe("200", authorization));
      await run(
        ["bash", "-se"],
        probe(
          "401",
          "Basic " + Buffer.from("admin:wrong-password").toString("base64"),
        ),
      );
      // A failed later update must retain the protected route and previous app.
      await expect(run(["bash", "-se"], script("bad"))).rejects.toThrow();
      expect(await readlink(join(root, "current"))).toBe("releases/monitor");
      expect(await request("/")).toBe("web");
      await run(["bash", "-se"], probe("401"));
    } finally {
      await run(["docker", "rm", "-f", ctr]).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);

integration(
  "existing Compose Caddy adoption is repeatable and retains unrelated configuration",
  async () => {
    const { adoptionScript } = await import("../src/setup");
    const root = await mkdtemp(join(tmpdir(), "2server-adopt-"));
    const ctr = `two-adopt-${crypto.randomUUID().slice(0, 8)}`;
    const compose = join(root, "compose.json");
    const c = configSchema.parse({
      version: 1,
      name: "test",
      ssh: { kind: "ssh", host: "example.com", user: "deploy" },
      originIp: "192.0.2.10",
      edge: { mode: "existing", container: ctr },
    });
    try {
      await mkdir(join(root, "edge/apps"), { recursive: true });
      await mkdir(join(root, "edge/releases/initial/sites"), {
        recursive: true,
      });
      await symlink("releases/initial", join(root, "edge/current"));
      await Bun.write(
        join(root, "Caddyfile"),
        ':8080 {\n respond "existing"\n}\n',
      );
      await Bun.write(
        compose,
        JSON.stringify({
          services: {
            caddy: {
              image: "caddy:2-alpine",
              container_name: ctr,
              volumes: [`${root}/Caddyfile:/etc/caddy/Caddyfile:ro`],
            },
          },
        }),
      );
      await run(["docker", "compose", "-p", ctr, "-f", compose, "up", "-d"]);
      // jq is available on supported VMs after bootstrap (and on this test host).
      const script = adoptionScript(c)
        .replaceAll("/opt/2server", root)
        .replace("/var/lock/2server-edge.lock", join(root, "edge.lock"));
      await run(["bash", "-se"], script);
      await run(["bash", "-se"], script);
      const file = await Bun.file(join(root, "Caddyfile")).text();
      expect(file.match(/import \/etc\/2server\/apps/g)).toHaveLength(1);
      expect(
        await run([
          "docker",
          "exec",
          ctr,
          "wget",
          "-qO-",
          "http://127.0.0.1:8080",
        ]),
      ).toBe("existing");
    } finally {
      await run(["docker", "compose", "-p", ctr, "-f", compose, "down"]).catch(
        () => {},
      );
      await run(["docker", "rm", "-f", ctr]).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
