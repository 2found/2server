import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rolloutDiagnoseScript } from "../src/modules/extensions/application/stateful";

// A failed `compose up --wait` must say why without carrying credentials into
// terminal output, CI logs or an error report.
test("rollout diagnostic keeps the reason and drops credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "two-rollout-"));
  try {
    const bin = join(root, "bin");
    const composeLog = join(root, "compose.log");
    const diagnostic = join(root, "diagnostic.txt");
    await mkdir(bin);
    await writeFile(
      join(bin, "docker"),
      `#!/bin/sh
case "$*" in
  *logs*) printf '%s\\n' 'start failed postgres://bob:swordfish@db/y' 'password=abc' 'config: database_url requires sslmode=require' ;;
  *health:*) echo 'health: unhealthy failing: 4' ;;
  *container:*) echo 'container: /two-x state: exited exit: 1 oom: false' ;;
esac
`,
    );
    await chmod(join(bin, "docker"), 0o755);
    await writeFile(
      composeLog,
      [
        "Error response from daemon: pull access denied for postgres://alice:hunter2@db/x",
        "Authorization: Bearer abc",
        "Container two-x  Error",
        "database_url requires sslmode=require outside loopback",
      ].join("\n"),
    );
    const script = `container=${JSON.stringify("two-x")}
${rolloutDiagnoseScript("two-x", composeLog, diagnostic)}
false
diagnose
cat ${JSON.stringify(diagnostic)}`;
    const proc = Bun.spawn(["bash", "-c", script], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    const output = await new Response(proc.stdout).text();
    expect(output).toContain("compose up failed (exit 1)");
    expect(output).toContain("container: /two-x state: exited exit: 1 oom: false");
    expect(output).toContain("health: unhealthy failing: 4");
    expect(output).toContain("Container two-x  Error");
    expect(output).toContain("database_url requires sslmode=require outside loopback");
    expect(output).toContain("postgres://***@db/x");
    expect(output).toContain("postgres://***@db/y");
    expect(output).not.toContain("hunter2");
    expect(output).not.toContain("swordfish");
    expect(output).not.toContain("alice:");
    expect(output).not.toContain("bob:");
    expect(output).not.toContain("Bearer abc");
    expect(output).not.toContain("password=abc");
    expect(await readFile(diagnostic, "utf8")).toBe(output);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
