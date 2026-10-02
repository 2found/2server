import { expect,test } from "bun:test";
import { mkdtemp,rm,stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema } from "../src/modules/config/application/config";
import { readConfig } from "../src/modules/config/infrastructure/file";
import { domainOperations,reconcileDomains } from "../src/modules/domains/application/reconcile";
import { Cloudflare } from "../src/modules/domains/infrastructure/cloudflare";
import { renderSite } from "../src/modules/domains/infrastructure/render";
import { verifyPublic } from "../src/modules/domains/infrastructure/verify";
import {
deployExtensions,
extensionOperations,
} from "../src/modules/extensions/application/deploy";
import { withExtensionDomains } from "../src/modules/extensions/application/registry";
import { monitoringAuth,monitoringCredentialPath,monitoringDomain,monitoringImageDefaults,monitoringName } from "../src/modules/extensions/infrastructure/templates/monitoring/hooks";
const config = () =>
  readConfig(new URL("../examples/server.json", import.meta.url).pathname);
const auth = {
  [monitoringName]: {
    username: "admin",
    password: "test-password-long-enough",
    passwordHash: "test-hash",
  },
};

test("monitoring derives one zone, supports explicit zones, and rejects ambiguous or conflicting hosts", async () => {
  const c = await config();
  expect(monitoringDomain(c)?.hosts).toEqual(["monitor.example.com"]);
  expect(withExtensionDomains(withExtensionDomains(c)).domains).toHaveLength(2);
  c.domains.push({
    ...c.domains[0],
    name: "other",
    zone: "other.com",
    hosts: ["other.com"],
  });
  expect(configSchema.safeParse(c).success).toBe(false);
  c.extensions.monitoring = {
    images: monitoringImageDefaults,
    zone: "other.com",
    hostname: "metrics.other.com",
    username: "admin",
    adoptDns: false,
  };
  expect(configSchema.safeParse(c).success).toBe(true);
  expect(monitoringDomain(c)?.hosts).toEqual(["metrics.other.com"]);
  c.extensions.monitoring.hostname = "outside.com";
  expect(configSchema.safeParse(c).success).toBe(false);
  c.extensions.monitoring.hostname = "other.com";
  expect(configSchema.safeParse(c).success).toBe(false);
  c.domains = [];
  c.extensions.monitoring.hostname = "metrics.other.com";
  expect(configSchema.safeParse(c).success).toBe(true);
});

test("monitoring credentials persist privately and protected routes fail closed", async () => {
  const state = await mkdtemp(join(tmpdir(), "two-monitoring-"));
  try {
    const c = await config();
    await expect(monitoringAuth(c, state, false)).rejects.toThrow(
      "credentials not found",
    );
    const first = await monitoringAuth(c, state);
    const second = await monitoringAuth(c, state);
    expect(first[monitoringName].password).toBe(
      second[monitoringName].password,
    );
    expect((await stat(monitoringCredentialPath(state))).mode & 0o777).toBe(
      0o600,
    );
    expect(
      await Bun.password.verify(
        first[monitoringName].password,
        second[monitoringName].passwordHash,
      ),
    ).toBe(true);
    const domain = monitoringDomain(c)!;
    expect(() => renderSite(domain)).toThrow("authentication");
    const rendered = renderSite(domain, first[monitoringName]);
    expect(rendered).toContain("basic_auth");
    expect(rendered).toContain('Cache-Control "no-store"');
    expect(rendered).not.toContain(first[monitoringName].password);
    c.extensions.monitoring = {
    images: monitoringImageDefaults,
      username: "admin",
      passwordEnv: "TWO_MONITORING_TEST_MISSING",
      adoptDns: false,
    };
    delete process.env.TWO_MONITORING_TEST_MISSING;
    await expect(monitoringAuth(c, state)).rejects.toThrow(
      "TWO_MONITORING_TEST_MISSING",
    );
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

test("extension workflow preflights, waits for readiness, then reconciles only monitoring with merge", async () => {
  const c = await config();
  c.cloudflare.originTokenEnv = "TWO_MONITORING_TEST_ORIGIN";
  process.env.TWO_MONITORING_TEST_ORIGIN = "fake-test-token";
  const events: string[] = [];
  const ops: typeof extensionOperations = {
    ...extensionOperations,
    cloudflareClient: () => new Cloudflare("fake-test-token"),
    resolveOrigin: async () => {
      events.push("resolve");
    },
    inspectDomains: async (_, scoped) => {
      expect(scoped.domains.map((d) => d.name)).toEqual([monitoringName]);
      events.push("inspect");
      return [];
    },
    auth: async () => {
      events.push("credentials");
      return auth;
    },
    preflightEdge: async (full) => {
      expect(full.domains).toHaveLength(2);
      events.push("preflight");
      return "";
    },
    deploy: async () => {
      events.push("ready");
    },
    reconcileDomains: async (
      scoped,
      _state,
      _cf,
      _plans,
      credentials,
      merge,
    ) => {
      expect(scoped.domains.map((d) => d.name)).toEqual([monitoringName]);
      expect(credentials).toBe(auth);
      expect(merge).toBe(true);
      events.push("publish");
      return crypto.randomUUID();
    },
  };
  try {
    await deployExtensions(c, "unused", ops);
    expect(events).toEqual([
      "resolve",
      "inspect",
      "credentials",
      "preflight",
      "ready",
      "publish",
    ]);
    events.length = 0;
    await expect(
      deployExtensions(c, "unused", {
        ...ops,
        deploy: async () => {
          throw new Error("not ready");
        },
      }),
    ).rejects.toThrow("not ready");
    expect(events).not.toContain("publish");
    events.length = 0;
    await expect(
      deployExtensions(c, "unused", {
        ...ops,
        inspectDomains: async () => {
          throw new Error("DNS collision");
        },
      }),
    ).rejects.toThrow("DNS collision");
    expect(events).not.toContain("ready");
    delete process.env.TWO_MONITORING_TEST_ORIGIN;
    events.length = 0;
    await expect(deployExtensions(c, "unused", ops)).rejects.toThrow(
      "TWO_MONITORING_TEST_ORIGIN",
    );
    expect(events).toEqual([]);
  } finally {
    delete process.env.TWO_MONITORING_TEST_ORIGIN;
  }
});

test("failed authenticated origin probe rolls back before DNS publication", async () => {
  const c = await config();
  c.domains = [monitoringDomain(c)!];
  c.cloudflare.originTokenEnv = "TWO_MONITORING_TEST_ROLLBACK";
  process.env.TWO_MONITORING_TEST_ROLLBACK = "fake-test-token";
  const events: string[] = [];
  const ops: typeof domainOperations = {
    certificate: async () => ({ cert: "fake", key: "fake" }),
    applyPolicies: async () => {
      events.push("policies");
    },
    installDomains: async () => {
      events.push("install");
      return crypto.randomUUID();
    },
    verifyOrigin: async () => {
      throw new Error("auth failed");
    },
    rollbackDomains: async () => {
      events.push("rollback");
    },
    publishDns: async () => {
      events.push("dns");
    },
    verifyPublic: async () => {
      events.push("public");
    },
  };
  try {
    await expect(
      reconcileDomains(
        c,
        "unused",
        new Cloudflare("fake-test-token"),
        [],
        auth,
        true,
        ops,
      ),
    ).rejects.toThrow("auth failed");
    expect(events).toEqual(["policies", "install", "rollback"]);
    events.length = 0;
    await reconcileDomains(
      c,
      "unused",
      new Cloudflare("fake-test-token"),
      [],
      auth,
      true,
      {
        ...ops,
        verifyOrigin: async () => {
          events.push("protected");
        },
      },
    );
    expect(events).toEqual([
      "policies",
      "install",
      "protected",
      "dns",
      "public",
    ]);
  } finally {
    delete process.env.TWO_MONITORING_TEST_ROLLBACK;
  }
});

test("public monitoring checks require anonymous 401 and authenticated 200, including network failure", async () => {
  const c = await config();
  c.domains = [monitoringDomain(c)!];
  let calls = 0;
  await verifyPublic(
    c,
    async (url, init) => {
      expect(url).toBe("https://monitor.example.com/-/ready");
      calls++;
      return new Response("", { status: init?.headers ? 200 : 401 });
    },
    1,
    0,
    auth,
  );
  expect(calls).toBe(2);
  for (const status of [200, 401, 503]) {
    await expect(
      verifyPublic(c, async () => new Response("", { status }), 1, 0, auth),
    ).rejects.toThrow("verification failed");
  }
  await expect(
    verifyPublic(
      c,
      async (_url, init) => {
        if (init?.headers) throw new Error("network failed");
        return new Response("", { status: 401 });
      },
      1,
      0,
      auth,
    ),
  ).rejects.toThrow("verification failed");
});
