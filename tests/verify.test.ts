import { expect,test } from "bun:test";
import { readConfig } from "../src/modules/config/infrastructure/file";
import { domainSchema } from "../src/modules/domains/domain/schema";
import { verifyPublic } from "../src/modules/domains/infrastructure/verify";
test("public verification retries propagation errors and rejects 5xx", async () => {
  const c = await readConfig(
    new URL("../examples/existing-caddy.json", import.meta.url).pathname,
  );
  c.domains = c.domains.slice(0, 1);
  c.domains[0].hosts = ["example.com"];
  let calls = 0;
  await verifyPublic(
    c,
    async () => new Response("test", { status: ++calls === 1 ? 526 : 200 }),
    2,
    0,
  );
  expect(calls).toBe(2);
  await expect(
    verifyPublic(
      c,
      async () => new Response("unavailable", { status: 503 }),
      1,
      0,
    ),
  ).rejects.toThrow("DNS may already be published");
});
test("healthPath probes an API origin that serves nothing at /", async () => {
  const c = await readConfig(
    new URL("../examples/existing-caddy.json", import.meta.url).pathname,
  );
  c.domains = [domainSchema.parse({ name: "api", zone: "example.com", hosts: ["api.example.com"], healthPath: "/readyz", upstream: { kind: "proxy", target: "api:8080" } })];
  const seen: string[] = [];
  await verifyPublic(c, async (url) => { seen.push(url); return new Response(null, { status: url.endsWith("/readyz") ? 200 : 404 }); }, 1, 0);
  expect(seen).toEqual(["https://api.example.com/readyz"]);
  for (const bad of [{ cache: "images" }, { requireAuth: true }, { healthPath: "/../x" }])
    expect(() => domainSchema.parse({ name: "api", zone: "example.com", hosts: ["api.example.com"], healthPath: "/readyz", upstream: { kind: "proxy", target: "api:8080" }, ...bad })).toThrow();
});
