import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema } from "../src/modules/config/application/config";
import { deployCloudflareWorker, workerTemplateFiles } from "../src/modules/extensions/infrastructure/templates/url-shortener/deploy";
import { orderedExtensions } from "../src/modules/extensions/application/bindings";
import { deployAll } from "../src/modules/extensions/application/deploy";
import { extensionRegistry } from "../src/modules/extensions/application/registry";
import { workerSpecSchema } from "../src/modules/extensions/infrastructure/templates/url-shortener/domain/spec";
import { parseDocument } from "../src/modules/source/application/documents";
import { fileCommand } from "../src/modules/source/cli/command";
import { extensionTemplate } from "../src/modules/source/application/templates";

const spec = workerSpecSchema.parse({
  accountId: "527d1733f8cc36adcf71e426a808dd05",
  worker: "soot-go",
  hostname: "go.trysoot.com",
  zone: "trysoot.com",
  database: "soot-go-links",
});

function mock(writes: string[], databases: { uuid: string; name: string }[] = [], target: { zone: string; accountId: string } = spec) {
  const request = (async (url: string | URL, init?: RequestInit) => {
    const full = String(url).replace("https://api.cloudflare.com/client/v4", "");
    const [path] = full.split("?");
    const method = init?.method ?? "GET";
    writes.push(`${method} ${full}`);
    let result: unknown = {};
    if (path.startsWith("/accounts/") && path.endsWith("/d1/database") && method === "GET")
      result = databases;
    if (path.endsWith("/d1/database") && method === "POST")
      result = { uuid: "db-1", name: spec.database };
    if (path.includes("/query")) result = [{ success: true, results: [] }];
    if (path === "/zones") result = [{ id: "zone-1", name: target.zone, status: "active" }];
    if (path === "/zones/zone-1") result = { account: { id: target.accountId } };
    if (path.endsWith("/workers/domains")) result = { id: "dom-1" };
    if (path.includes("/workers/scripts/")) result = { id: spec.worker };
    return new Response(JSON.stringify({ success: true, result }), { status: 200 });
  }) as typeof fetch;
  return request;
}

test("url-shortener is a worker-engine app, not a VM template name", () => {
  const ext = extensionRegistry.find((e) => e.cliName === "url-shortener");
  expect(ext?.name).toBe("urlShortener");
  expect(ext?.runtimeEngine).toBe("worker");
  expect(ext?.stateful).toBeUndefined();
  expect(ext?.commands?.customers).toBeDefined();
  expect(workerTemplateFiles("url-shortener").script.includes('Response.redirect("https://trysoot.com", 302)')).toBe(true);
  expect(workerTemplateFiles("url-shortener").schemaSql).toContain("CREATE TABLE IF NOT EXISTS links");
});

test("source App with the template validates without a VM image", () => {
  const doc = parseDocument({
    apiVersion: "2server.app/v1",
    kind: "App",
    metadata: { name: "go" },
    template: "url-shortener",
    spec,
  });
  expect(doc.kind).toBe("Extension");
  if (doc.kind !== "Extension") throw new Error("expected Extension");
  expect(doc.template).toBe("url-shortener");
  expect(doc.spec).toMatchObject(spec);
});

test("plan lists D1 and does not upload a worker", async () => {
  const writes: string[] = [];
  const plan = await deployCloudflareWorker(spec, false, workerTemplateFiles("url-shortener"), "token", mock(writes));
  expect(plan.url).toBe("https://go.trysoot.com");
  expect(plan.databaseId).toBeNull();
  expect(writes.some((w) => w.startsWith("PUT "))).toBe(false);
  expect(writes.some((w) => w.startsWith("POST "))).toBe(false);
});

test("apply creates D1, uploads the script and attaches the hostname", async () => {
  const writes: string[] = [];
  const plan = await deployCloudflareWorker(spec, true, workerTemplateFiles("url-shortener"), "token", mock(writes));
  expect(plan.databaseId).toBe("db-1");
  expect(writes).toContain("POST /accounts/527d1733f8cc36adcf71e426a808dd05/d1/database");
  expect(writes.some((w) => w.includes("/workers/scripts/soot-go"))).toBe(true);
  expect(writes).toContain("PUT /accounts/527d1733f8cc36adcf71e426a808dd05/workers/domains");
});

test("missing zone scope and a foreign account stop plans and applies before any writes", async () => {
  for (const apply of [false, true]) {
    for (const failure of ["denied", "foreign"]) {
      const calls: string[] = [];
      const fallback = mock(calls);
      const request = (async (url: string | URL, init?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        if (path === "/client/v4/zones/zone-1") {
          calls.push(`${init?.method} ${path}`);
          return failure === "denied"
            ? Response.json({ success: false, errors: [{ code: 9109, message: "secret-response" }] }, { status: 403 })
            : Response.json({ success: true, result: { account: { id: "b".repeat(32) } } });
        }
        return fallback(url, init);
      }) as typeof fetch;
      await expect(deployCloudflareWorker(spec, apply, workerTemplateFiles("url-shortener"), "secret-token", request))
        .rejects.toThrow(failure === "denied" ? "Zone: Read" : "zone/account mismatch");
      expect(calls.every(c => c.startsWith("GET "))).toBe(true);
      expect(calls.some(c => c.includes("/d1/") || c.includes("/workers/"))).toBe(false);
    }
  }
});

test("Worker upload and custom-domain denials identify account and zone rights without leaking provider bodies", async () => {
  for (const failure of ["upload-json", "upload-html", "domain"]) {
    const calls: string[] = [];
    const fallback = mock(calls);
    const request = (async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if ((failure.startsWith("upload") && path.includes("/workers/scripts/")) || (failure === "domain" && path.endsWith("/workers/domains"))) {
        calls.push(`${init?.method} ${path}`);
        return failure === "upload-html"
          ? new Response("secret-provider-html", { status: 403 })
          : Response.json({ success: false, errors: [{ code: 9109, message: "secret-response" }] }, { status: 403 });
      }
      return fallback(url, init);
    }) as typeof fetch;
    try {
      await deployCloudflareWorker(spec, true, workerTemplateFiles("url-shortener"), "secret-token", request);
      throw new Error("Expected permission failure");
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain("HTTP 403");
      expect(message).toContain("Workers Scripts: Edit");
      expect(message).toContain("account/zone resource scope");
      expect(message).toContain("docs/cloudflare-tokens.md");
      expect(message).not.toContain("secret-");
      if (failure === "domain") expect(message).toContain("Zone Workers Routes: Edit");
      else expect(calls.some(c => c.endsWith("/workers/domains"))).toBe(false);
    }
  }
});

test("an existing D1 database is found beyond the default first page", async () => {
  const writes: string[] = [];
  const plan = await deployCloudflareWorker(
    spec,
    true,
    workerTemplateFiles("url-shortener"),
    "token",
    mock(writes, [{ uuid: "db-existing", name: spec.database }]),
  );
  expect(plan.databaseId).toBe("db-existing");
  // The list endpoint pages at 20 by default, so the lookup must ask for more.
  expect(writes).toContain(`GET /accounts/${spec.accountId}/d1/database?per_page=1000`);
  expect(writes).not.toContain(`POST /accounts/${spec.accountId}/d1/database`);
});

test("template defaults survive a YAML round-trip as strings", () => {
  const doc = extensionTemplate("url-shortener");
  // A YAML writer may emit a numeric-looking string unquoted — Bun 1.3.0 does —
  // and `init` would then write a file that `deploy` rejects with
  // "expected string, received number".
  for (const [key, value] of Object.entries(doc.spec as Record<string, unknown>))
    if (typeof value === "string") expect(Number.isNaN(Number(value))).toBe(true);
});

test("the VM extension engine skips a worker app instead of calling a missing hook", async () => {
  const c = configSchema.parse({
    version: 1,
    name: "lohi",
    ssh: { kind: "ssh", host: "203.0.113.10", user: "ubuntu" },
    edge: { mode: "managed" },
    extensionApps: { go: { template: "url-shortener", spec } },
  });
  const worker = orderedExtensions(c).find((e) => e.name === "go");
  expect(worker?.runtimeEngine).toBe("worker");
  expect(worker?.deploy).toBeUndefined();
  // Before the guard this threw `ext.deploy is not a function`, and no SSH
  // session is opened for a manifest whose only extension is a worker.
  await deployAll(c);
});

test("a worker template named directly deploys without a VM connection", async () => {
  const doc = extensionTemplate("url-shortener");
  const file = join(tmpdir(), `2server-worker-${crypto.randomUUID()}.yaml`);
  await Bun.write(file, Bun.YAML.stringify(doc));
  const writes: string[] = [];
  const original = globalThis.fetch;
  const previous = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_API_TOKEN = "test-token";
  globalThis.fetch = mock(writes, [], doc.spec as typeof spec);
  try {
    // `init extension url-shortener` emits a bare Extension document; it must
    // reach the Cloudflare path rather than the VM extension lifecycle.
    expect(await fileCommand(["plan", "-f", file])).toBe(true);
  } finally {
    globalThis.fetch = original;
    if (previous === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = previous;
    await rm(file, { force: true });
  }
  expect(writes.every(w => w.startsWith("GET "))).toBe(true);
  expect(writes).toContain(`GET /accounts/${(doc.spec as Record<string, unknown>).accountId}/d1/database?per_page=1000`);
});

// The Worker is a shipped artifact with no build step, so exercise it against a
// fake D1 instead of only matching strings in its source.
type Row = Record<string, unknown>;
function fakeD1() {
  const tables: { customers: Row[]; links: Row[] } = { customers: [], links: [] };
  const state = { fault: undefined as string | undefined };
  const prepare = (sql: string) => ({
    bind(...params: unknown[]) {
      return {
        async first() {
          if (sql.startsWith("SELECT url, expires_at"))
            return tables.links.find((r) => r.code === params[0]) ?? null;
          if (sql.startsWith("SELECT quota FROM customers"))
            return tables.customers.find((r) => r.id === params[0]) ?? null;
          if (sql.startsWith("SELECT count(*)"))
            return { n: tables.links.filter((r) => r.iss === params[0] && (r.created_at as number) > (params[1] as number)).length };
          if (sql.startsWith("SELECT pubkey, quota"))
            return tables.customers.find((r) => r.id === params[0]) ?? null;
          throw new Error(`unexpected first(): ${sql}`);
        },
        async run() {
          if (state.fault) throw new Error(state.fault);
          if (sql.startsWith("INSERT INTO links")) {
            if (tables.links.some((r) => r.code === params[0]))
              throw new Error("D1_ERROR: UNIQUE constraint failed: links.code");
            tables.links.push({ code: params[0], url: params[1], iss: params[2], sub: params[3], expires_at: params[4], created_at: params[5] });
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("DELETE FROM links")) {
            const before = tables.links.length;
            tables.links = tables.links.filter((r) => !(r.code === params[0] && r.iss === params[1]));
            return { meta: { changes: before - tables.links.length } };
          }
          throw new Error(`unexpected run(): ${sql}`);
        },
        async all() {
          let rows = tables.links.filter((r) => r.iss === params[0]);
          if (sql.includes("AND sub = ?")) rows = rows.filter((r) => r.sub === params[1]);
          return { results: rows };
        },
      };
    },
  });
  return { tables, state, env: { LINKS: { prepare } } };
}

test("the worker serves its own hostname and rejects malformed signed claims", async () => {
  // Annotated as `string` so TypeScript does not resolve the plain-JS Worker,
  // which ships without a declaration file.
  const workerPath: string = "../src/modules/extensions/infrastructure/templates/url-shortener/worker.js";
  const worker = (await import(workerPath)).default as {
    fetch: (req: Request, env: unknown) => Promise<Response>;
  };
  const { tables, state, env } = fakeD1();
  const key = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pubkey = Buffer.from(new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey))).toString("base64url");
  tables.customers.push({ id: "lohi", pubkey, quota: 200, created_at: 0 });
  const now = Math.floor(Date.now() / 1000);
  const token = async (claims: Row) => {
    const payload = new TextEncoder().encode(JSON.stringify({ v: 1, iat: now, exp: now + 300, ...claims }));
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, payload));
    return `soot1.lohi.${Buffer.from(payload).toString("base64url")}.${Buffer.from(sig).toString("base64url")}`;
  };
  const call = (path: string, init?: RequestInit) =>
    worker.fetch(new Request(`https://go.example.com${path}`, init), env);
  const post = async (path: string, claims: Row) =>
    call(path, { method: "POST", headers: { authorization: `Soot1 ${await token(claims)}` } });

  expect((await call("/")).headers.get("location")).toBe("https://trysoot.com");
  const minted = await post("/v1/mint", { op: "mint", url: "https://lohi2.com/x", ttl: 3600 });
  expect(minted.status).toBe(200);
  const { shortlink } = (await minted.json()) as { shortlink: { code: string; url: string } };
  // The short-link host is the request host, not the template's first deployment.
  expect(shortlink.url).toBe(`https://go.example.com/${shortlink.code}`);
  expect((await call(`/${shortlink.code}`)).headers.get("location")).toBe("https://lohi2.com/x");

  // A signed claim with ttl 0 is out of range, not a silent 30-day default.
  expect((await post("/v1/mint", { op: "mint", url: "https://lohi2.com/y", ttl: 0 })).status).toBe(400);
  // A signed revoke without a code must not reach D1 with an undefined bind.
  expect((await post("/v1/revoke", { op: "revoke" })).status).toBe(400);
  // A storage failure is not a taken code.
  state.fault = "D1_ERROR: network unavailable";
  expect((await post("/v1/mint", { op: "mint", url: "https://lohi2.com/z", ttl: 60 })).status).toBe(503);
  state.fault = undefined;

  const listed = await call("/v1/links", { headers: { authorization: `Soot1 ${await token({ op: "list" })}` } });
  expect(await listed.json()).toMatchObject({
    kind: "list",
    links: [{ code: shortlink.code, url: `https://go.example.com/${shortlink.code}`, target: "https://lohi2.com/x" }],
  });
  expect((await post("/v1/revoke", { op: "revoke", code: shortlink.code })).status).toBe(200);
  expect((await call(`/${shortlink.code}`)).status).toBe(404);
});
