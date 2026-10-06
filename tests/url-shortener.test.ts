import { expect, test } from "bun:test";
import { deployCloudflareWorker, workerTemplateFiles } from "../src/modules/extensions/application/edge";
import { extensionRegistry } from "../src/modules/extensions/application/registry";
import { workerSpecSchema } from "../src/modules/extensions/domain/worker";
import { parseDocument } from "../src/modules/source/application/documents";

const spec = workerSpecSchema.parse({
  accountId: "527d1733f8cc36adcf71e426a808dd05",
  worker: "soot-go",
  hostname: "go.trysoot.com",
  zone: "trysoot.com",
  database: "soot-go-links",
});

function mock(writes: string[]) {
  const request = (async (url: string | URL, init?: RequestInit) => {
    const path = String(url).replace("https://api.cloudflare.com/client/v4", "");
    const method = init?.method ?? "GET";
    writes.push(`${method} ${path.split("?")[0]}`);
    let result: unknown = {};
    if (path.startsWith("/accounts/") && path.endsWith("/d1/database") && method === "GET")
      result = [];
    if (path.endsWith("/d1/database") && method === "POST")
      result = { uuid: "db-1", name: spec.database };
    if (path.includes("/query")) result = [{ success: true, results: [] }];
    if (path.startsWith("/zones?")) result = [{ id: "zone-1", name: "trysoot.com", status: "active" }];
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
