import { test, expect } from "bun:test";
import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("CLI rejects missing/blank Cloudflare credentials before contacting the VM", async () => {
  const root = await mkdtemp(join(tmpdir(), "2server-credentials-"));
  const cli = new URL("../src/cli.ts", import.meta.url).pathname;
  try {
    await mkdir(join(root, "bin"));
    const marker = join(root, "contacted-vm");
    for (const command of ["gcloud", "ssh", "docker"]) {
      const file = join(root, "bin", command);
      await Bun.write(file, `#!/bin/sh\necho contacted > '${marker}'\nexit 9\n`);
      await chmod(file, 0o755);
    }
    const config = {
      version: 1, name: "test",
      ssh: { kind: "gcp", project: "example-project", zone: "us-central1-a", instance: "example-vm" },
      edge: { mode: "existing" },
      cloudflare: { tokenEnv: "TWO_TEST_CF_TOKEN", originTokenEnv: "TWO_TEST_ORIGIN_TOKEN" },
      domains: [{ name: "app", zone: "example.com", hosts: ["example.com"], upstream: { kind: "proxy", target: "app:8080" } }],
      extensions: { monitoring: true },
    };
    const manifest = join(root, "server.json");
    await Bun.write(manifest, JSON.stringify(config));
    for (const [command, token, missing] of [
      ["plan", undefined, "TWO_TEST_CF_TOKEN"],
      ["plan", "   ", "TWO_TEST_CF_TOKEN"],
      ["domains", undefined, "TWO_TEST_CF_TOKEN"],
      ["domains", "fake-test-token", "TWO_TEST_ORIGIN_TOKEN"],
      ["extensions", undefined, "TWO_TEST_CF_TOKEN"],
      ["extensions", "fake-test-token", "TWO_TEST_ORIGIN_TOKEN"],
    ] as const) {
      const p = Bun.spawn([process.execPath, "--no-env-file", cli, command, manifest, ...(command === "plan" ? [] : ["--apply"])], {
        cwd: root,
        env: { HOME: root, PATH: join(root, "bin"), ...(token === undefined ? {} : { TWO_TEST_CF_TOKEN: token }) },
        stdout: "pipe", stderr: "pipe",
      });
      const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
      expect(code).toBe(1);
      expect(out).toBe("");
      expect(err).toContain(`Missing Cloudflare credential: ${missing}`);
      expect(err).toContain("2server/.env");
      expect(err).not.toContain("fake-test-token");
      expect(await Bun.file(marker).exists()).toBe(false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
