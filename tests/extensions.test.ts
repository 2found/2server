import { expect,test } from "bun:test";
import { configSchema } from "../src/modules/config/application/config";
import { readConfig } from "../src/modules/config/infrastructure/file";
import { extensionKey,extensionRegistry } from "../src/modules/extensions/application/registry";
import { monitoringCompose,monitoringFiles,monitoringInstallScript } from "../src/modules/extensions/infrastructure/templates/monitoring/hooks";

test("every registered extension is mounted in the manifest and addressable by cliName", () => {
  // The manifest mounts ext.schema once per registry entry; a drift here means
  // init/extension documents accept a name the manifest would reject.
  const fields = configSchema.shape.extensions.unwrap().unwrap().shape;
  const mounted = extensionRegistry.map((e) => e.name).sort();
  expect(
    Object.keys(fields)
      .filter((k) => !["alertWebhookEnv", "webhooks", "services"].includes(k))
      .sort(),
  ).toEqual(mounted);
  for (const ext of extensionRegistry) {
    expect(extensionKey(ext.name)).toBe(ext.name);
    expect(extensionKey(ext.cliName ?? ext.name)).toBe(ext.name);
    expect(fields[ext.name as keyof typeof fields]).toBeTruthy();
    expect(() => ext.schema.parse(ext.template)).not.toThrow();
  }
});
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


test("monitoring validation uses the same configured immutable images as runtime", async () => {
 const c=await readConfig(new URL("../examples/server.json",import.meta.url).pathname);
 const images={prometheus:'private.example/prometheus@sha256:'+'a'.repeat(64),nodeExporter:'private.example/node-exporter@sha256:'+'b'.repeat(64),alertmanager:'private.example/alertmanager@sha256:'+'c'.repeat(64)};
 c.extensions.monitoring={username:'admin',adoptDns:false,images};
 c.extensions.webhooks=[{name:'alerts',provider:'discord',urlEnv:'DISCORD_WEBHOOK',enabled:true,sendResolved:true}];
 const compose=monitoringCompose(c) as any;
 const script=monitoringInstallScript(c,'/opt/2server/monitoring/release');
 expect(compose.services.prometheus.image).toBe(images.prometheus);
 expect(compose.services.alertmanager.image).toBe(images.alertmanager);
 expect(script).toContain(`/bin/promtool '${images.prometheus}' check`);
 expect(script).toContain(`/bin/amtool '${images.alertmanager}' check`);
 expect(script).not.toContain('prom/prometheus:');
 expect(script).not.toContain('prom/alertmanager:');
});
