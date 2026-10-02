import { expect,test } from "bun:test";
import { chmod,mkdtemp,rm,stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validPair } from "../src/modules/domains/infrastructure/certificates";
import { run } from "../src/shared/infrastructure/process";
test("certificate validation checks hostname, expiry, parse errors and private-key match", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cert-test-"));
  try {
    await run([
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "90",
      "-keyout",
      join(dir, "key"),
      "-out",
      join(dir, "cert"),
      "-subj",
      "/CN=example.com",
      "-addext",
      "subjectAltName=DNS:example.com,DNS:www.example.com",
    ]);
    await run(["openssl", "genrsa", "-out", join(dir, "other"), "2048"]);
    const cert = await Bun.file(join(dir, "cert")).text(),
      key = await Bun.file(join(dir, "key")).text();
    expect(validPair(cert, key, ["example.com", "www.example.com"])).toBe(true);
    expect(validPair(cert, key, ["evil.example.com"])).toBe(false);
    expect(
      validPair(cert, await Bun.file(join(dir, "other")).text(), [
        "example.com",
      ]),
    ).toBe(false);
    expect(
      validPair(cert, key, ["example.com"], Date.now() + 100 * 86400000),
    ).toBe(false);
    expect(validPair("garbage", key, ["example.com"])).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("zone origin certificates request 15 years and validate apex plus wildcard coverage", async () => {
  const { certificate, certificateHosts } = await import("../src/modules/domains/infrastructure/certificates");
  const { domainSchema } = await import("../src/modules/domains/domain/schema");
  const { Cloudflare } = await import("../src/modules/domains/infrastructure/cloudflare");
  const dir = await mkdtemp(join(tmpdir(), "cert-zone-"));
  const d = domainSchema.parse({
    name: "zone",
    zone: "example.com",
    hosts: ["example.com", "www.example.com"],
    upstream: { kind: "proxy", target: "app:8080" },
    certificate: { scope: "zone", validityDays: 5475 },
  });
  let calls = 0;
  const cf = new Cloudflare("test", (async (_url: any, init: any) => {
    calls++;
    const body = JSON.parse(init.body);
    expect(body.requested_validity).toBe(5475);
    expect(body.hostnames).toEqual([
      "example.com",
      "*.example.com",
      "www.example.com",
    ]);
    const { readdir } = await import("node:fs/promises");
    const pending = (await readdir(join(dir, "certificates/zone"))).find((n) =>
      n.startsWith("pending-"),
    )!;
    const work = join(dir, "certificates/zone", pending);
    await Bun.write(
      join(work, "ext"),
      "subjectAltName=DNS:example.com,DNS:*.example.com,DNS:www.example.com\n",
    );
    await run([
      "openssl",
      "x509",
      "-req",
      "-in",
      join(work, "request.pem"),
      "-signkey",
      join(work, "key.pem"),
      "-days",
      "5475",
      "-extfile",
      join(work, "ext"),
      "-out",
      join(work, "cert.pem"),
    ]);
    return new Response(
      JSON.stringify({
        success: true,
        result: {
          id: "test-id",
          certificate: await Bun.file(join(work, "cert.pem")).text(),
        },
      }),
    );
  }) as typeof fetch);
  try {
    const pair = await certificate(cf, d, dir);
    expect(validPair(pair.cert, pair.key, certificateHosts(d))).toBe(true);
    expect(validPair(pair.cert, pair.key, ["monitor.example.com"])).toBe(true);
    expect(validPair(pair.cert, pair.key, ["*.other.com"])).toBe(false);
    const saved = join(dir, "certificates/zone/pair.json");
    expect((await stat(saved)).mode & 0o777).toBe(0o600);
    await chmod(saved, 0o644);
    await certificate(cf, d, dir);
    expect((await stat(saved)).mode & 0o777).toBe(0o600);
    expect(calls).toBe(1);
    expect(
      domainSchema.safeParse({ ...d, certificate: { validityDays: 9999 } })
        .success,
    ).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
