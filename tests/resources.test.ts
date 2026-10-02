import { test, expect } from "bun:test";
import { mkdtemp, rm, chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseResource, resourceCommand } from "../src/resources";
import { configSchema } from "../src/config";
import { vmArgs, diskPreflight } from "../src/vm";
import { statefulFiles, extensionProject } from "../src/stateful";
import { extensionByName } from "../src/extensions";
import { postgresExtension } from "../src/extensions";
import { redisExtension } from "../src/extensions";
import { natsExtension } from "../src/extensions";
import { backupScript, restoreScript, storageRemote } from "../src/extensions/postgres/backups";
import { retireDomain, assertAppUnreferenced } from "../src/retire";
import { Cloudflare } from "../src/cloudflare";
const base = {
  version: 1,
  name: "test",
  ssh: { kind: "ssh", host: "example.com", user: "deploy" },
  edge: { mode: "managed" },
};
test("resource syntax aliases, bounds and unknown flags fail closed", async () => {
  expect(
    parseResource([
      "app",
      "scale",
      "worker",
      "-f",
      "server.json",
      "--replicas",
      "2",
    ])?.resource,
  ).toBe("app");
  expect(
    parseResource(["get", "services", "-f", "server.json"])?.resource,
  ).toBe("app");
  expect(
    parseResource(["reload", "extension", "image-proxy", "-f", "server.json"])
      ?.name,
  ).toBe("imageProxy");
  for (const args of [
    ["delete", "app", "app", "-f", "s", "--force"],
    ["get", "pod", "$(touch-pwn)", "-f", "s"],
    ["scale", "app", "app", "-f", "s", "--replicas"],
    ["get", "app", "-f", "s", "--replicas", "2"],
    ["delete", "vm", "-f", "s", "--apply", "--apply"],
  ])
    expect(() => parseResource(args)).toThrow();
  expect(parseResource(["deploy", "server.json"])).toBeUndefined();
});
test("all resource dry runs leave manifest unchanged and never call SSH", async () => {
  const dir = await mkdtemp(join(tmpdir(), "two-cli-"));
  try {
    const c = configSchema.parse({
      ...base,
      apps: [
        {
          name: "api",
          image: `example/api@sha256:${"a".repeat(64)}`,
          port: 80,
          memoryMb: 64,
          cpus: 1,
        },
      ],
      extensions: {
        postgres: {
          passwordEnv: "MISSING",
          backup: { engine: "dump", destination: "gs://example-bucket/backups" },
        },
      },
    });
    const file = join(dir, "server.json"),
      spec = join(dir, "app.json");
    const original = JSON.stringify(c);
    await Bun.write(file, original);
    await Bun.write(spec, JSON.stringify({ ...c.apps[0], name: "other" }));
    const lock = join(dir, '.local/state/2server/test/lock');
    await mkdir(lock, {recursive:true});
    await Bun.write(join(lock, 'token'), 'other-operator');
    for (const args of [
      ['get', 'app', '--apply'],
      ["create", "app", "other", "--spec", spec],
      ["scale", "app", "api", "--replicas", "0"],
      ["reload", "app", "api"],
      ["delete", "app", "api"],
      ["backup", "postgres"],
      ["stop", "vm"],
      ["delete", "extension", "postgres"],
      [
        "restore",
        "postgres",
        "--id",
        "20261002T123456Z-12345678-1234-1234-1234-123456789abc",
        "--database",
        "restored",
      ],
    ]) {
      const p = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          new URL("../src/cli.ts", import.meta.url).pathname,
          ...args,
          "-f",
          file,
        ],
        { env: { HOME: dir, PATH: dir }, stdout: "pipe", stderr: "pipe" },
      );
      const [out, err, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      expect({ code, err }).toEqual({ code: 0, err: "" });
      expect(await Bun.file(join(lock, 'token')).text()).toBe('other-operator');
      expect(out).toContain(args[0] === 'get' ? 'api' : '--apply');
      expect(await Bun.file(file).text()).toBe(original);
    }
    await expect(
      resourceCommand(["scale", "app", "api", "-f", file, "--replicas", "33"]),
    ).rejects.toThrow("0..32");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("stateful resources require secrets, isolate ports, preserve data and enforce memory limits", async () => {
  const c = configSchema.parse({
    ...base,
    extensions: {
      postgres: { passwordEnv: "TEST_PG" },
      redis: { passwordEnv: "TEST_REDIS" },
      nats: { tokenEnv: "TEST_NATS", jetstream: true },
    },
  });
  await expect(statefulFiles(c, postgresExtension)).rejects.toThrow("2server/.env");
  const secret = 'fixture-only-long-secret-$"\\value';
  process.env.TEST_PG = process.env.TEST_REDIS = process.env.TEST_NATS = secret;
  process.env.POSTGRES_ADMIN_PASSWORD = "admin-" + secret;
  process.env.POSTGRES_MIGRATION_PASSWORD = "migration-" + secret;
  try {
    for (const name of ["postgres", "redis", "nats"] as const) {
      const files = await statefulFiles(c, extensionByName(name)!),
        compose = JSON.parse(files["compose.json"]),
        service = compose.services[extensionProject(c, name)];
      expect(Object.keys(compose.services)).toEqual([extensionProject(c, name)]);
      expect(service.ports).toBeUndefined();
      expect(service.mem_limit).toBeDefined();
      expect(service.labels["io.2server.owner"]).toBe("test");
      expect(files["compose.json"]).not.toContain(secret);
    }
    expect(((await statefulFiles(c, redisExtension))["password"])).toBe(secret);
    expect(
      JSON.parse((await statefulFiles(c, natsExtension))["nats.conf"]).authorization.token,
    ).toBe(secret);
    expect(
      JSON.parse((await statefulFiles(c, postgresExtension))["compose.json"]).services[extensionProject(c, "postgres")]
        .volumes,
    ).toContain("/opt/2server/data/postgres:/var/lib/postgresql");
  } finally {
    delete process.env.TEST_PG;
    delete process.env.POSTGRES_ADMIN_PASSWORD;
    delete process.env.POSTGRES_MIGRATION_PASSWORD;
    delete process.env.TEST_REDIS;
    delete process.env.TEST_NATS;
  }
  expect(() =>
    configSchema.parse({
      ...base,
      extensions: {
        redis: {
          passwordEnv: "REDIS_PASSWORD",
          maxmemoryMb: 256,
          memoryMb: 256,
        },
      },
    }),
  ).toThrow();
  expect(() =>
    configSchema.parse({
      ...base,
      extensions: {
        postgres: { passwordEnv: "PG_PASSWORD", image: "postgres:latest" },
      },
    }),
  ).toThrow();
});
test("GCS backups use bucket IAM without legacy object ACLs", async () => {
  const c = configSchema.parse({
    ...base,
    extensions: {
      postgres: {
        passwordEnv: "PG_PASS",
        backup: { engine: "dump", destination: "gs://example-bucket/postgres" },
      },
    },
  });
  expect(storageRemote(c)).toBe(
    ":gcs,env_auth=true,no_check_bucket=true,bucket_policy_only=true:example-bucket/postgres",
  );
});
test("backup has a completion checksum; restores reject overwrite and injected identifiers", async () => {
  const c = configSchema.parse({
    ...base,
    extensions: {
      postgres: {
        passwordEnv: "PG_PASS",
        backup: {
          engine: "dump",
          destination: "s3://example-bucket/postgres",
          region: "ap-southeast-1",
        },
      },
    },
  });
  expect(storageRemote(c)).toContain("env_auth=true");
  const s = backupScript(c);
  expect(s.indexOf('"$id.dump" >/dev/null')).toBeLessThan(
    s.indexOf('"$id.sha256" >/dev/null'),
  );
  for (const db of ["app", "postgres", "evil;drop database app", "template1"])
    expect(() =>
      restoreScript(
        c,
        "20261002T123456Z-12345678-1234-1234-1234-123456789abc",
        db,
      ),
    ).toThrow();
  expect(() => restoreScript(c, "../../secret", "fresh")).toThrow();
  const restore = restoreScript(
    c,
    "20261002T123456Z-12345678-1234-1234-1234-123456789abc",
    "fresh",
  );
  expect(restore.indexOf("sha256sum -c")).toBeLessThan(
    restore.indexOf("createdb"),
  );
  expect(restore).toContain("--single-transaction --exit-on-error");
  expect(restore).not.toContain("dropdb");
});
test("domain deletion refuses a foreign record before any provider writes", async () => {
  const calls: string[] = [];
  const cf = new Cloudflare("fixture", (async (
    url: string,
    opts: RequestInit,
  ) => {
    calls.push(`${opts.method} ${url}`);
    return Response.json({
      success: true,
      result: url.includes("dns_records")
        ? [{ id: "a", type: "A", name: "example.com", comment: "someone-else" }]
        : [{ id: "zone", name: "example.com", status: "active" }],
    });
  }) as typeof fetch);
  const c = configSchema.parse({
    ...base,
    domains: [
      {
        name: "site",
        zone: "example.com",
        hosts: ["example.com"],
        upstream: { kind: "import", name: "up_two_api" },
      },
    ],
  });
  await expect(retireDomain(c, c.domains[0], cf)).rejects.toThrow("unowned");
  expect(calls.every((c) => c.startsWith("GET"))).toBe(true);
});
test("VM and disk commands bind provider identity and refuse unsupported filesystem layouts", async () => {
  const c = configSchema.parse({
    ...base,
    ssh: {
      kind: "gcp",
      project: "test-project",
      zone: "asia-southeast1-a",
      instance: "vm",
    },
  });
  expect(vmArgs(c, "stop")).toContain("--project=test-project");
  expect(() => vmArgs(configSchema.parse(base), "stop")).toThrow("identity");
  const disk = {
    name: "db",
    provider: {
      kind: "gcp" as const,
      project: "test-project",
      zone: "asia-southeast1-a",
      disk: "data",
    },
    device: "/dev/disk/by-id/google-data",
    mountPath: "/mnt/db",
  };
  const script = diskPreflight(disk, "provider-device-check");
  expect(script).toContain("provider-device-check");
  expect(script).toContain("mountpoint -q");
  expect(script).toContain("ext4|xfs");
  expect(script).not.toContain("mkfs");
});

test("disk resize rejects shrink, boot/unattached volumes and mount mismatch before provider mutation", async () => {
  const { resizeDisk } = await import("../src/vm");
  const c = configSchema.parse({
    ...base,
    ssh: {
      kind: "gcp",
      project: "test-project",
      zone: "zone-a",
      instance: "vm",
    },
    disks: [
      {
        name: "db",
        provider: {
          kind: "gcp",
          project: "test-project",
          zone: "zone-a",
          disk: "data",
        },
        device: "/dev/disk/by-id/google-data",
        mountPath: "/mnt/db",
      },
    ],
  });
  const d = c.disks[0];
  for (const scenario of [
    "shrink",
    "boot",
    "unattached",
    "wrong-mount",
    "grow",
    "resume",
  ]) {
    const calls: string[] = [];
    const ops = {
      run: async (args: string[]) => {
        const command = args.join(" ");
        calls.push(command);
        if (command.includes("instances describe"))
          return JSON.stringify({
            disks:
              scenario === "unattached"
                ? []
                : [
                    {
                      source: "projects/test-project/zones/zone-a/disks/data",
                      deviceName: "data",
                      boot: scenario === "boot",
                    },
                  ],
          });
        if (command.includes("disks describe"))
          return JSON.stringify({ sizeGb: scenario === "resume" ? 20 : 10 });
        return "";
      },
      remote: async (_c: typeof c, script: string) => {
        calls.push(script);
        if (scenario === "wrong-mount") throw new Error("mount mismatch");
        return "";
      },
    };
    const result = resizeDisk(c, d, scenario === "shrink" ? 5 : 20, ops);
    if (["grow", "resume"].includes(scenario)) {
      await result;
      expect(calls.some((s) => s.includes("resize2fs"))).toBe(true);
      expect(
        calls.some((s) => s.startsWith("gcloud compute disks resize")),
      ).toBe(scenario === "grow");
      if (scenario === "grow")
        expect(
          calls.findIndex((s) => s.includes("mountpoint -q")),
        ).toBeLessThan(
          calls.findIndex((s) => s.startsWith("gcloud compute disks resize")),
        );
    } else {
      await expect(result).rejects.toThrow();
      expect(
        calls.some((s) => s.startsWith("gcloud compute disks resize")),
      ).toBe(false);
      expect(calls.some((s) => s.includes("resize2fs"))).toBe(false);
    }
  }
});

test("domain retirement deletes only owned DNS/cache rules and retains a guarded drain", async () => {
  const c = configSchema.parse({
    ...base,
    domains: [
      {
        name: "site",
        zone: "example.com",
        hosts: ["example.com"],
        upstream: { kind: "proxy", target: "app:80" },
      },
    ],
  });
  const writes: string[] = [],
    remoteScripts: string[] = [];
  const cf = new Cloudflare("fixture", (async (
    url: string,
    init: RequestInit,
  ) => {
    const path = new URL(url).pathname;
    if (init.method === "DELETE") {
      writes.push(path);
      return Response.json({ success: true, result: {} });
    }
    const result =
      path === "/client/v4/zones"
        ? [{ id: "zone", name: "example.com", status: "active" }]
        : path.includes("dns_records")
          ? [
              {
                id: "owned-dns",
                type: "A",
                name: "example.com",
                comment: "2server:test:site",
              },
            ]
          : {
              id: "rules",
              rules: [
                {
                  id: "owned-rule",
                  ref: "two_server_test_site",
                  description: "2server:test:site",
                },
                { id: "foreign-rule", ref: "foreign", description: "manual" },
              ],
            };
    return Response.json({ success: true, result });
  }) as typeof fetch);
  await retireDomain(c, c.domains[0], cf, async (_c, script) => {
    remoteScripts.push(script);
    return "";
  });
  expect(writes).toEqual([
    "/client/v4/zones/zone/dns_records/owned-dns",
    "/client/v4/zones/zone/rulesets/rules/rules/owned-rule",
  ]);
  expect(remoteScripts[0]).toContain("sleep 300");
  expect(remoteScripts[0]).toContain("caddy validate");
  expect(remoteScripts[0]).toContain("trap 'restore' ERR");
});

test("VM destroy refuses protected or unknown protection before applying any resources", async () => {
  const { assertDestroyPlan } = await import("../src/provision");
  for (const [type, key] of [
    ["google_compute_instance", "deletion_protection"],
    ["aws_instance", "disable_api_termination"],
  ]) {
    for (const before of [{ [key]: true }, {}])
      expect(() =>
        assertDestroyPlan({
          resource_changes: [{ type, change: { actions: ["delete"], before } }],
        }),
      ).toThrow("No part");
    expect(() =>
      assertDestroyPlan({
        resource_changes: [
          { type, change: { actions: ["delete"], before: { [key]: false } } },
        ],
      }),
    ).not.toThrow();
  }
});
