import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/process";
import { validPair } from "../src/certificates";
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
