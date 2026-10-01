import { test, expect } from "bun:test";
import {
  Cloudflare,
  CloudflareError,
  inspectDomains,
  applyPolicies,
  publishDns,
  cacheRule,
} from "../src/cloudflare";
import { configSchema } from "../src/config";
const base = await Bun.file(
  new URL("../examples/existing-caddy.json", import.meta.url),
).json();
base.originIp = "203.0.113.10";

function mock(handler: (method: string, path: string, body: any) => any) {
  const calls: { method: string; path: string; body: any }[] = [];
  const cf = new Cloudflare("test-token", (async (url: any, init: any) => {
    const path =
      new URL(url).pathname.replace("/client/v4", "") + new URL(url).search;
    const method = init.method,
      body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const result = handler(method, path, body);
    return new Response(
      JSON.stringify(
        result?.error
          ? { success: false, errors: [{ code: result.code }] }
          : { success: true, result },
      ),
      { status: result?.error ?? 200 },
    );
  }) as typeof fetch);
  return { cf, calls };
}
const read = (method: string, path: string) => {
  if (path.startsWith("/zones?"))
    return [{ id: "zone", name: "example.com", status: "active" }];
  if (path.includes("/dns_records")) return [];
  if (path.endsWith("/settings/ssl")) return { value: "strict" };
  if (path.includes("/rulesets/phases"))
    return { id: "rules", rules: [{ id: "unrelated", ref: "manual" }] };
  return {};
};
test("preflight is read-only; publishing occurs only when explicitly called", async () => {
  const { cf, calls } = mock(read);
  const c = configSchema.parse(base);
  const p = await inspectDomains(cf, c);
  expect(calls.every((c) => c.method === "GET")).toBe(true);
  await applyPolicies(cf, p);
  expect(
    calls
      .filter((c) => c.method === "POST")
      .every((c) => c.path.endsWith("/rules")),
  ).toBe(true);
  expect(calls.some((c) => c.method === "PUT")).toBe(false);
  await publishDns(cf, c, p);
  expect(
    calls.filter((c) => c.method === "POST" && c.path.endsWith("/dns_records")),
  ).toHaveLength(3);
});
test("auth failure never becomes missing ruleset", async () => {
  const { cf } = mock(() => ({ error: 403, code: 10000 }));
  await expect(cf.ruleset("zone")).rejects.toBeInstanceOf(CloudflareError);
});
test("permission failures identify the operation without leaking query or response secrets", async () => {
  const cf = new Cloudflare("secret-token", (async (_url: any, _init: any) => new Response(
    JSON.stringify({ success: false, errors: [{ code: 9109, message: "secret-response" }] }),
    { status: 403 },
  )) as typeof fetch);
  for (const [path, permission] of [
    ["/zones", "Zone: Read"],
    ["/zones/zone/settings/ssl", "Zone Settings: Edit"],
    ["/certificates", "SSL and Certificates: Edit"],
    ["/zones/zone/dns_records", "DNS: Edit"],
    ["/zones/zone/rulesets", "Cache Rules / Cache Settings: Edit"],
  ]) {
    try {
      await cf.call("GET", `${path}?secret-query=value`);
      throw new Error("Expected permission failure");
    } catch (e) {
      expect(e).toBeInstanceOf(CloudflareError);
      const message = (e as Error).message;
      expect(message).toContain(`GET ${path}`);
      expect(message).toContain(permission);
      expect(message).toContain("zone scope");
      expect(message).toContain("2server/.env");
      expect(message).toContain("Entire <account name> account");
      expect(message).not.toContain("secret-");
    }
  }
});
test("known missing ruleset is distinct from unknown 404", async () => {
  const { cf } = mock(() => ({ error: 404, code: 10003 }));
  expect(await cf.ruleset("zone")).toBeUndefined();
  const bad = mock(() => ({ error: 404, code: 999 }));
  await expect(bad.cf.ruleset("zone")).rejects.toThrow();
});
test("refuses foreign DNS and conflicting AAAA even when adoption enabled", async () => {
  for (const type of ["A", "AAAA"]) {
    const { cf } = mock((m, p) =>
      p.includes("/dns_records")
        ? [{ id: "other", type, name: "example.com", content: "192.0.2.9" }]
        : read(m, p),
    );
    const c = configSchema.parse(base);
    if (type === "AAAA") c.domains[0].adoptDns = true;
    await expect(inspectDomains(cf, c)).rejects.toThrow();
  }
});
test("matching owned DNS is idempotent and stale plans refuse concurrent edits", async () => {
  let ip = "203.0.113.10";
  const c = configSchema.parse(base);
  c.domains = c.domains.slice(0, 1);
  c.domains[0].hosts = ["example.com"];
  const { cf, calls } = mock((m, p) =>
    p.includes("/dns_records")
      ? [
          {
            id: "id",
            type: "A",
            name: "example.com",
            content: ip,
            proxied: true,
            comment: "2server:example-server:app",
          },
        ]
      : read(m, p),
  );
  const plans = await inspectDomains(cf, c);
  await publishDns(cf, c, plans);
  expect(calls.every((x) => x.method === "GET")).toBe(true);
  ip = "192.0.2.99";
  await expect(publishDns(cf, c, plans)).rejects.toThrow(
    "changed since preflight",
  );
});
test("cache presets preserve origin decisions and query keys; app traffic bypasses", () => {
  const d = configSchema.parse(base).domains[0];
  expect(cacheRule("test", d).action_parameters).toEqual({ cache: false });
  d.cache = "audio";
  const audio = cacheRule("test", d);
  expect(audio.expression).toContain("/a/");
  expect(audio.expression).toContain("authorization");
  expect(audio.action_parameters).toEqual({
    cache: true,
    edge_ttl: { mode: "respect_origin" },
    browser_ttl: { mode: "respect_origin" },
  });
  d.cache = "images";
  expect(cacheRule("test", d).expression).toContain("/i/");
});
