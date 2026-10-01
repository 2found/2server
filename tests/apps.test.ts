import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "../src/config";
import { deployScript, rollbackScript, resolveEnv } from "../src/apps";

test("missing and multiline secret values fail before deployment", async () => {
  const c = await readConfig(
    new URL("../examples/server.json", import.meta.url).pathname,
  );
  c.apps[0].secrets = {
    TOKEN: { provider: "env", key: "TWO_SERVER_TEST_SECRET" },
  };
  delete process.env.TWO_SERVER_TEST_SECRET;
  await expect(resolveEnv(c.apps[0])).rejects.toThrow("missing or multiline");
  process.env.TWO_SERVER_TEST_SECRET = "a\nb";
  await expect(resolveEnv(c.apps[0])).rejects.toThrow("missing or multiline");
  process.env.TWO_SERVER_TEST_SECRET = "value$literal";
  expect(await resolveEnv(c.apps[0])).toBe("TOKEN=value$literal\n");
  delete process.env.TWO_SERVER_TEST_SECRET;
});
for (const scenario of [
  "unhealthy-service",
  "bad-reload",
  "healthy-service",
  "unhealthy-worker",
  "healthy-worker",
])
  test(`deployment transaction: ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "2server-app-"));
    try {
      const c = await readConfig(
        new URL("../examples/server.json", import.meta.url).pathname,
      );
      const a = c.apps[0];
      a.kind = scenario.includes("worker") ? "worker" : "service";
      for (const p of ["bin", "apps/app/releases/test", "edge/apps"])
        await mkdir(join(root, p), { recursive: true });
      await Bun.write(join(root, "apps/app/current"), "blue");
      await Bun.write(
        join(root, "apps/app/releases/test/app.json"),
        JSON.stringify(a),
      );
      await Bun.write(
        join(root, "apps/app/releases/test/app.env"),
        "TEST=value",
      );
      await Bun.write(
        join(root, "edge/apps/app.caddy"),
        "(up_two_app) { reverse_proxy two-my-server-app-blue:8080 }\n",
      );
      const docker = `#!/bin/bash
printf '%s\\n' "$*" >> '${root}/calls'
case "$*" in
  'image inspect '*) echo CMD; exit 0;;
  *'{{.State.Health.Status}}'*) ${scenario === "unhealthy-worker" ? "echo unhealthy" : "echo healthy"}; exit 0;;
  'run --rm '*) ${scenario === "unhealthy-service" ? "exit 1" : "exit 0"};;
  *'caddy reload'*) ${scenario === "bad-reload" ? "exit 1" : "exit 0"};;
esac
exit 0
`;
      await Bun.write(join(root, "bin/docker"), docker);
      await chmod(join(root, "bin/docker"), 0o755);
      await Bun.write(join(root, "bin/sleep"), "#!/bin/bash\nexit 0\n");
      await chmod(join(root, "bin/sleep"), 0o755);
      const script = deployScript(c, a, "test")
        .replaceAll("/opt/2server", root)
        .replaceAll("/var/lock/", `${root}/`);
      const p = Bun.spawn(["bash", "-se"], {
        env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` },
        stdin: new Blob([script]),
        stdout: "pipe",
        stderr: "pipe",
      });
      await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
      ]);
      const code = await p.exited;
      const success =
        scenario === "healthy-service" || scenario === "healthy-worker";
      expect(code === 0).toBe(success);
      expect(
        (await Bun.file(join(root, "apps/app/current")).text()).trim(),
      ).toBe(success ? "green" : "blue");
      const calls = await Bun.file(join(root, "calls")).text();
      if (scenario === "bad-reload" || scenario === "unhealthy-service") {
        expect(
          await Bun.file(join(root, "edge/apps/app.caddy")).text(),
        ).toContain("app-blue");
        expect(calls).not.toContain("stop -t 10 two-my-server-app-blue");
      }
      if (scenario === "unhealthy-worker")
        expect(calls).toContain("start two-my-server-app-blue");
      if (scenario === "healthy-service")
        expect(calls.indexOf("caddy reload")).toBeLessThan(
          calls.indexOf("stop -t 10 two-my-server-app-blue"),
        );
      if (scenario === "healthy-worker")
        expect(calls.indexOf("stop -t 60 two-my-server-app-blue")).toBeLessThan(
          calls.indexOf("run -d"),
        );

      if (scenario === "healthy-service") {
        const prior = { ...a, port: 9000 };
        const previous = JSON.stringify(prior);
        await Bun.write(join(root, "apps/app/blue.json"), previous);
        const script = rollbackScript(c, a, prior, previous)
          .replaceAll("/opt/2server", root)
          .replaceAll("/var/lock/", `${root}/`);
        const rollback = Bun.spawn(["bash", "-se"], {
          env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` },
          stdin: new Blob([script]),
          stdout: "pipe",
          stderr: "pipe",
        });
        await Promise.all([
          new Response(rollback.stdout).text(),
          new Response(rollback.stderr).text(),
        ]);
        expect(await rollback.exited).toBe(0);
        expect(
          (await Bun.file(join(root, "apps/app/current")).text()).trim(),
        ).toBe("blue");
        expect(
          await Bun.file(join(root, "edge/apps/app.caddy")).text(),
        ).toContain("app-blue:9000");
        expect(await Bun.file(join(root, "calls")).text()).toContain(
          "http://two-my-server-app-blue:9000/healthz",
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
