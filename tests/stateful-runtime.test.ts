import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rm, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { configSchema } from "../src/config";
import { statefulFiles, extensionProject, migrateServiceAlias } from "../src/stateful";
import { extensionByName } from "../src/extensions";
import { redisExtension } from "../src/extensions/redis";
import { natsExtension } from "../src/extensions/nats";
import { postgresDataPreparation } from "../src/extensions/postgres";
import { backupScript, restoreScript, storageRemote } from "../src/extensions/postgres/backups";
import { run } from "../src/process";
import { runtimeHealthFiles } from "../src/extensions/monitoring/runtime-health";
const integration = process.env.DOCKER_TESTS === "1" ? test : test.skip;
function natsRequest(
  port: number,
  token: string,
  subject: string,
  payload: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = "";
    const socket = createConnection({ host: "127.0.0.1", port }, () =>
      socket.write(
        `CONNECT ${JSON.stringify({ auth_token: token })}\r\nSUB _INBOX.test 1\r\nPUB ${subject} _INBOX.test ${Buffer.byteLength(payload)}\r\n${payload}\r\n`,
      ),
    );
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error("NATS response timeout"));
    });
    socket.on("error", reject);
    socket.on("data", (data) => {
      received += data.toString();
      const match = /MSG _INBOX.test 1 (?:\S+ )?(\d+)\r\n/.exec(received);
      if (
        match &&
        received.length >= match.index + match[0].length + Number(match[1])
      ) {
        const body = received.slice(
          match.index + match[0].length,
          match.index + match[0].length + Number(match[1]),
        );
        socket.destroy();
        resolve(body);
      }
      if (received.includes("Authorization Violation")) {
        socket.destroy();
        resolve(received);
      }
    });
  });
}
integration(
  "real stateful services: credentials, persistence, Core/JetStream and PostgreSQL backup/restore",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "two-stateful-"));
    const name = `test-${crypto.randomUUID().slice(0, 8)}`,
      network = `two-${name}`;
    const c = configSchema.parse({
      version: 1,
      name,
      ssh: { kind: "ssh", host: "example.com", user: "deploy" },
      edge: { mode: "managed", network },
      extensions: {
        postgres: {
          passwordEnv: "TWO_TEST_PG",
          dataPath: join(root, "pg-data"),
          backup: { engine: "dump", destination: "gs://example-test-bucket/backups" },
        },
        redis: {
          passwordEnv: "TWO_TEST_REDIS",
          dataPath: join(root, "redis-data"),
        },
        nats: {
          tokenEnv: "TWO_TEST_NATS",
          dataPath: join(root, "nats-data"),
          jetstream: true,
        },
      },
    });
    const secret = 'test-only-very-long-$"\\secret';
    process.env.TWO_TEST_PG =
      process.env.TWO_TEST_REDIS =
      process.env.TWO_TEST_NATS =
        secret;
    process.env.POSTGRES_ADMIN_PASSWORD = "admin-" + secret;
    process.env.POSTGRES_MIGRATION_PASSWORD = "migration-" + secret;
    const projects: string[] = [],
      composeFiles: string[] = [];
    let port = 0;
    try {
      await run(["docker", "network", "create", network]);
      for (const ext of ["postgres", "redis", "nats"] as const) {
        const dir = join(root, ext);
        await mkdir(dir, { recursive: true });
        const files = await statefulFiles(c, extensionByName(ext)!);
        const compose = JSON.parse(files["compose.json"]);
        const service = compose.services[extensionProject(c, ext)];
        if (ext === "nats") service.ports = ["127.0.0.1::4222"];
        // Named volumes on Docker Desktop preserve Linux ownership across restarts.
        const mount = ext === "postgres" ? "/var/lib/postgresql" : "/data";
        compose.volumes = { data: {} };
        service.volumes[0] = `data:${mount}`;
        files["compose.json"] = JSON.stringify(compose);
        for (const [file, value] of Object.entries(files)) {
          await Bun.write(join(dir, file), value);
          await chmod(join(dir, file), 0o600);
        }
        const project = `two-${name}-${ext}`,
          file = join(dir, "compose.json");
        projects.push(project);
        composeFiles.push(file);
        if (ext === "postgres" || ext === "redis") {
          // Match production: root-owned 0700 mount with our ownership marker.
          const volume = `${project}_data`;
          await run(["docker", "volume", "create", volume]);
          await run([
            "docker", "run", "--rm", "--user", "0:0", "--entrypoint", "sh",
            "-v", `${volume}:/fixture`, c.extensions[ext]!.image, "-ec",
            "chown 0:0 /fixture; chmod 700 /fixture; touch /fixture/.2server-owner",
          ]);
          if (ext === "postgres")
            await run(["bash", "-se"], postgresDataPreparation({ ...c, extensions: { ...c.extensions, postgres: { ...c.extensions.postgres!, dataPath: volume } } })).catch(error => { throw new Error("fixture postgres mount preparation", {cause:error}); });
        }
        // Upgrade an actual legacy service, preserving its initialized volume.
        const legacyFile = join(dir, "legacy-compose.json");
        await Bun.write(legacyFile, JSON.stringify({ ...compose, services: { [ext]: service } }));
        await run(["docker", "compose", "-p", project, "-f", legacyFile, "up", "-d", "--wait", "--wait-timeout", "100"]);
        await run(["bash", "-se"], migrateServiceAlias(c, extensionByName(ext)!)).catch(error => { throw new Error(`fixture ${ext} alias migration`, {cause:error}); });
        await run([
          "docker",
          "compose",
          "-p",
          project,
          "-f",
          file,
          "up",
          "-d",
          "--wait",
          "--wait-timeout",
          "100",
        ]);
        const inspected = JSON.parse(await run(["docker", "inspect", project]))[0];
        const aliases = inspected.NetworkSettings.Networks[network].Aliases;
        expect(aliases).toContain(project);
        expect(aliases).not.toContain(ext);
        await run(["bash", "-se"], migrateServiceAlias(c, extensionByName(ext)!)).catch(error => { throw new Error(`fixture ${ext} alias migration`, {cause:error}); });
        expect((await run(["docker", "inspect", "-f", "{{.Id}}", project])).trim()).toBe(inspected.Id);
        if (ext === "nats")
          port = Number(
            (await run(["docker", "port", project, "4222/tcp"]))
              .trim()
              .split(":")
              .at(-1),
          );
      }
      const pg = `two-${name}-postgres`,
        redis = `two-${name}-redis`;
      const sql = (db: string, query: string) =>
        run([
          "docker",
          "exec",
          pg,
          "psql",
          "-U",
          "two_admin",
          "-d",
          db,
          "-v",
          "ON_ERROR_STOP=1",
          "-Atc",
          query,
        ]);
      expect(
        (
          await run([
            "docker",
            "exec",
            pg,
            "sh",
            "-ec",
            'export PGPASSWORD=$(cat /run/2server/app-password); psql -h 127.0.0.1 -U app -d app -Atc "SELECT 1"',
          ])
        ).trim(),
      ).toBe("1");
      await expect(
        run([
          "docker",
          "exec",
          "-e",
          "PGPASSWORD=incorrect",
          pg,
          "psql",
          "-h",
          "127.0.0.1",
          "-U",
          "two_admin",
          "-d",
          "app",
          "-c",
          "SELECT 1",
        ]),
      ).rejects.toThrow();
      await sql(
        "app",
        "CREATE TABLE sample (id integer PRIMARY KEY, value text); INSERT INTO sample VALUES (1, 'survives backup');",
      );
      expect(
        await run(["docker", "exec", redis, "redis-cli", "ping"]),
      ).toContain("NOAUTH");
      const redisCmd = (command: string) =>
        run([
          "docker",
          "exec",
          redis,
          "sh",
          "-ec",
          `export REDISCLI_AUTH=$(cat /run/secrets/redis-password); redis-cli ${command}`,
        ]);
      expect((await redisCmd("SET sample persists")).trim()).toBe("OK");
      expect(
        await natsRequest(port, "wrong-token", "$JS.API.INFO", "{}"),
      ).toContain("Authorization Violation");
      const create = JSON.parse(
        await natsRequest(
          port,
          secret,
          "$JS.API.STREAM.CREATE.TEST",
          JSON.stringify({
            name: "TEST",
            subjects: ["events"],
            storage: "file",
          }),
        ),
      );
      expect(create.error).toBeUndefined();
      expect(
        JSON.parse(await natsRequest(port, secret, "events", "hello")).seq,
      ).toBe(1);
      for (let i = 0; i < projects.length; i++)
        await run([
          "docker",
          "compose",
          "-p",
          projects[i],
          "-f",
          composeFiles[i],
          "restart",
        ]);
      for (let i = 0; i < projects.length; i++)
        await run([
          "docker",
          "compose",
          "-p",
          projects[i],
          "-f",
          composeFiles[i],
          "up",
          "-d",
          "--wait",
          "--wait-timeout",
          "60",
        ]);
      port = Number(
        (await run(["docker", "port", projects[2], "4222/tcp"]))
          .trim()
          .split(":")
          .at(-1),
      );
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          if ((await sql("app", "SELECT count(*) FROM sample")).trim() === "1")
            break;
        } catch {}
        await Bun.sleep(200);
      }
      expect((await sql("app", "SELECT value FROM sample")).trim()).toBe(
        "survives backup",
      );
      expect((await redisCmd("GET sample")).trim()).toBe("persists");
      expect(
        JSON.parse(
          await natsRequest(port, secret, "$JS.API.STREAM.INFO.TEST", "{}"),
        ).state.messages,
      ).toBe(1);
      // Authenticated health must go red on a wrong credential, even though
      // Redis remains reachable and unauthenticated PING still returns NOAUTH.
      const redisHealth = JSON.parse((await statefulFiles(c, redisExtension))["compose.json"]).services[redis].healthcheck.test[1].replaceAll("$$", "$");
      await Bun.write(join(root, "redis/password"), "incorrect-test-password");
      try { await expect(run(["docker", "exec", redis, "sh", "-ec", redisHealth])).rejects.toThrow(); }
      finally { await Bun.write(join(root, "redis/password"), secret); }
      await run(["docker", "exec", redis, "sh", "-ec", redisHealth]);
      // Abrupt process termination: let Redis everysec fsync finish first.
      // This tests local persisted recovery, not disk/host loss or the RPO gap.
      await Bun.sleep(1200);
      for (const ctr of [redis, projects[2]]) {
        await run(["docker", "kill", "--signal", "KILL", ctr]);
        await run(["docker", "start", ctr]);
      }
      for (const i of [1, 2]) await run(["docker", "compose", "-p", projects[i], "-f", composeFiles[i], "up", "-d", "--wait", "--wait-timeout", "60"]);
      port = Number((await run(["docker", "port", projects[2], "4222/tcp"])).trim().split(":").at(-1));
      expect((await redisCmd("GET sample")).trim()).toBe("persists");
      expect(JSON.parse(await natsRequest(port, secret, "$JS.API.STREAM.INFO.TEST", "{}")).state.messages).toBe(1);
      for (const ext of ["redis", "nats"]) {
        await mkdir(join(root, "extensions", ext), { recursive: true });
        await symlink(join(root, ext), join(root, "extensions", ext, "current"));
      }
      await run(["bash", "-se"], runtimeHealthFiles(c)["runtime-metrics.sh"].replaceAll("/opt/2server", root));
      const observed = await Bun.file(join(root, "metrics/runtime.prom")).text();
      expect(observed).toContain(`two_container_healthy{container="${redis}"} 1`);
      expect(observed).toContain("two_redis_aof_last_write_status 1");
      expect(observed).toContain("two_redis_maxmemory 134217728");
      expect(observed).toContain("two_nats_max_storage_bytes 5368709120");
      expect(observed).toContain("two_nats_connections ");
      // Exercise the real scripts and real pg_dump/restore, substituting only the cloud transport.
      await mkdir(join(root, "bin"));
      await mkdir(join(root, "archive"));
      await mkdir(join(root, "edge"));
      await Bun.write(join(root, "edge/owner"), name);
      const realDocker = (await run(["which", "docker"])).trim();
      const wrapper = `#!/bin/bash
set -euo pipefail
if [[ "$*" == *rclone/rclone:* ]]; then
  args=("$@")
  for ((i=0;i<\${#args[@]};i++)); do
    if [ "\${args[$i]}" = -v ]; then mount="\${args[$((i+1))]}"; mount="\${mount%:/work}"; fi
    if [ "\${args[$i]}" = copyto ]; then src="\${args[$((i+1))]}"; dest="\${args[$((i+2))]}"; fi
  done
  src="\${src/#\\/work/$mount}"; dest="\${dest/#\\/work/$mount}"
  src="\${src/#fixture:/\$ARCHIVE}"; dest="\${dest/#fixture:/\$ARCHIVE}"
  cp "$src" "$dest"
else
  exec '${realDocker}' "$@"
fi
`;
      await Bun.write(join(root, "bin/docker"), wrapper);
      await chmod(join(root, "bin/docker"), 0o755);
      const rewrite = (script: string) =>
        script
          .replaceAll("/opt/2server", root)
          .replaceAll("/var/lock/", `${root}/`)
          .replaceAll(storageRemote(c), "fixture:")
          .replace(
            "cat /proc/sys/kernel/random/uuid",
            "printf 12345678-1234-1234-1234-123456789abc",
          );
      const shell = async (script: string) => {
        const p = Bun.spawn(["bash", "-se"], {
          env: {
            ...process.env,
            PATH: `${root}/bin:${process.env.PATH}`,
            ARCHIVE: join(root, "archive"),
          },
          stdin: new Blob([rewrite(script)]),
          stdout: "pipe",
          stderr: "pipe",
        });
        const [out, err, code] = await Promise.all([
          new Response(p.stdout).text(),
          new Response(p.stderr).text(),
          p.exited,
        ]);
        if (code) throw new Error(`script failed ${code}: ${err}`);
        return out;
      };
      await shell(backupScript(c));
      const id = (
        await Bun.file(join(root, "backups/postgres-last-success")).text()
      ).trim();
      await sql("app", "INSERT INTO sample VALUES (2, 'after backup')");
      await shell(restoreScript(c, id, "restored"));
      expect(
        (await sql("restored", "SELECT count(*) FROM sample")).trim(),
      ).toBe("1");
      expect((await sql("app", "SELECT count(*) FROM sample")).trim()).toBe(
        "2",
      );
      await expect(shell(restoreScript(c, id, "restored"))).rejects.toThrow();
      await Bun.write(join(root, "archive", id + ".dump"), "corrupt");
      await expect(
        shell(restoreScript(c, id, "corrupt_target")),
      ).rejects.toThrow();
      expect(
        (
          await sql(
            "postgres",
            "SELECT count(*) FROM pg_database WHERE datname='corrupt_target'",
          )
        ).trim(),
      ).toBe("0");
      // Core mode runs without JetStream. Same authenticated request/reply protocol.
      const core = {
        ...c,
        extensions: {
          ...c.extensions,
          nats: { ...c.extensions.nats!, jetstream: false },
        },
      };
      const cfg = (await statefulFiles(core, natsExtension))["nats.conf"];
      expect(JSON.parse(cfg).jetstream).toBeUndefined();
      await Bun.write(join(root, "nats/nats.conf"), cfg);
      await run([
        "docker",
        "compose",
        "-p",
        projects[2],
        "-f",
        composeFiles[2],
        "restart",
      ]);
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          port = Number(
            (await run(["docker", "port", projects[2], "4222/tcp"]))
              .trim()
              .split(":")
              .at(-1),
          );
          await natsRequest(port, secret, "_INBOX.test", "ready");
          break;
        } catch {
          await Bun.sleep(200);
        }
      }
      expect(
        await natsRequest(port, secret, "_INBOX.test", "core-message"),
      ).toBe("core-message");
    } finally {
      for (let i = 0; i < projects.length; i++)
        await run([
          "docker",
          "compose",
          "-p",
          projects[i],
          "-f",
          composeFiles[i],
          "down",
          "--volumes",
          "--remove-orphans",
        ]).catch(() => {});
      await run(["docker", "network", "rm", network]).catch(() => {});
      delete process.env.TWO_TEST_PG;
      delete process.env.POSTGRES_ADMIN_PASSWORD;
      delete process.env.POSTGRES_MIGRATION_PASSWORD;
      delete process.env.TWO_TEST_REDIS;
      delete process.env.TWO_TEST_NATS;
      await rm(root, { recursive: true, force: true });
    }
  },
  300000,
);
