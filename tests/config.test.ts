import { describe,expect,test } from "bun:test";
import { configSchema } from "../src/modules/config/application/config";
import { readConfig } from "../src/modules/config/infrastructure/file";
import { renderSite } from "../src/modules/domains/infrastructure/render";
import { quote,sshArgs } from "../src/shared/infrastructure/process";
const base = await Bun.file(
  new URL("../examples/existing-caddy.json", import.meta.url),
).json();
describe("manifest boundaries", () => {
  test("both supplied examples validate", async () => {
    await readConfig(
      new URL("../examples/existing-caddy.json", import.meta.url).pathname,
    );
    await readConfig(
      new URL("../examples/server.json", import.meta.url).pathname,
    );
  });
  test("rejects command injection, duplicates, out-of-zone host and unknown keys", () => {
    for (const mutate of [
      (c: any) => (c.ssh.instance = "example;id"),
      (c: any) => c.domains[0].hosts.push("evil.invalid"),
      (c: any) => c.domains.push(c.domains[0]),
      (c: any) => (c.domains[0].upstream.name = "up_app\nrespond hacked"),
      (c: any) => (c.cloudflare = { apiToken: "secret-literal" }),
    ]) {
      const c = structuredClone(base);
      mutate(c);
      expect(configSchema.safeParse(c).success).toBe(false);
    }
  });
  test("Caddy renders API prefix stripping and stable legacy upstreams", () => {
    const d = configSchema.parse(base).domains[0];
    const text = renderSite(d);
    expect(text).toContain("handle_path /api/*");
    expect(text).toContain("import up_prod-api");
    expect(text).toContain("import up_prod-web");
    expect(text).not.toContain("redir");
  });
  test("only an opted-in app domain drops X-Frame-Options", () => {
    const d = configSchema.parse(base).domains[0];
    expect(renderSite(d)).toContain("nosniff\n    X-Frame-Options DENY\n    Referrer-Policy");
    const framed = configSchema.parse({ ...base, domains: [{ ...base.domains[0], allowFraming: true }] }).domains[0];
    expect(renderSite(framed)).not.toContain("X-Frame-Options");
    expect(renderSite(framed)).toContain("X-Content-Type-Options nosniff\n    Referrer-Policy");
    for (const extra of [{ cache: "images", routes: [] }, { requireAuth: true }])
      expect(configSchema.safeParse({ ...base, domains: [{ ...base.domains[0], allowFraming: true, ...extra }] }).success).toBe(false);
  });
  test("byte proxies return 404 outside their scoped route", () => {
    const d = configSchema.parse(base).domains[0];
    d.cache = "audio";
    d.routes = [];
    expect(renderSite(d)).toContain("handle /a/*");
    expect(renderSite(d)).toContain("respond 404");
    expect(renderSite(d)).not.toContain("encode");
  });
  test("SSH uses strict host verification and shell quote escapes apostrophes", () => {
    expect(sshArgs(configSchema.parse(base), "echo ok")).toContain(
      "StrictHostKeyChecking=yes",
    );
    expect(quote("a'b")).toBe("'a'\\''b'");
  });
});
