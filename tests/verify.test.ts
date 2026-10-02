import { expect,test } from "bun:test";
import { readConfig } from "../src/modules/config/infrastructure/file";
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
