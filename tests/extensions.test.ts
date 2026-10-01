import { test, expect } from "bun:test";
import { readConfig } from "../src/config";
import { monitoringCompose, monitoringFiles } from "../src/extensions";
test("monitoring UI is loopback-only and retention is bounded", async () => {
  const c = await readConfig(
    new URL("../examples/server.json", import.meta.url).pathname,
  );
  const compose = monitoringCompose(c) as any;
  expect(compose.services.prometheus.ports).toEqual(["127.0.0.1:9090:9090"]);
  expect(compose.services.prometheus.command).toContain(
    "--storage.tsdb.retention.size=1GB",
  );
  expect(compose.services["node-exporter"].ports).toBeUndefined();
  expect(monitoringFiles(c)["alerts.yml"]).toContain("DiskPressure");
});
test("alert delivery requires a valid secret reference", async () => {
  const c = await readConfig(
    new URL("../examples/server.json", import.meta.url).pathname,
  );
  c.extensions.alertWebhookEnv = "TWO_SERVER_TEST_ALERT_URL";
  delete process.env.TWO_SERVER_TEST_ALERT_URL;
  expect(() => monitoringFiles(c)).toThrow("HTTPS secret");
  process.env.TWO_SERVER_TEST_ALERT_URL = "https://alerts.example.com/hook";
  const files = monitoringFiles(c);
  expect(
    JSON.parse(files["alertmanager.yml"]).receivers[0].webhook_configs[0].url,
  ).toBe(process.env.TWO_SERVER_TEST_ALERT_URL);
  delete process.env.TWO_SERVER_TEST_ALERT_URL;
});
