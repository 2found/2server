import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Cloudflare, requireCloudflareToken } from "../../domains/infrastructure/cloudflare";
import type { WorkerSpec } from "../domain/worker";

export type WorkerFiles = { script: string; schemaSql?: string };

export function workerTemplateFiles(cliName: string): WorkerFiles {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(cliName)) throw new Error("Invalid definition name");
  const dir = fileURLToPath(new URL(`../infrastructure/templates/${cliName}/`, import.meta.url));
  const schema = join(dir, "schema.sql");
  return {
    script: readFileSync(join(dir, "worker.js"), "utf8"),
    schemaSql: existsSync(schema) ? readFileSync(schema, "utf8") : undefined,
  };
}

export async function deployCloudflareWorker(
  spec: WorkerSpec,
  apply: boolean,
  files: WorkerFiles,
  token = requireCloudflareToken("CLOUDFLARE_API_TOKEN"),
  request: typeof fetch = fetch,
) {
  const cf = new Cloudflare(token, request);
  const list = await cf.call<{ uuid: string; name: string }[]>(
    "GET",
    `/accounts/${spec.accountId}/d1/database`,
    undefined,
    "D1: Edit",
  );
  const existing = list.find((d) => d.name === spec.database);
  const plan = {
    worker: spec.worker,
    hostname: spec.hostname,
    database: spec.database,
    databaseId: existing?.uuid ?? null,
    url: `https://${spec.hostname}`,
    scriptBytes: files.script.length,
  };
  if (!apply) return plan;
  const dbID = existing?.uuid ?? (await cf.call<{ uuid: string }>(
    "POST",
    `/accounts/${spec.accountId}/d1/database`,
    { name: spec.database },
    "D1: Edit",
  )).uuid;
  if (files.schemaSql) {
    await cf.call(
      "POST",
      `/accounts/${spec.accountId}/d1/database/${dbID}/query`,
      { sql: files.schemaSql },
      "D1: Edit",
    );
  }
  const metadata = JSON.stringify({
    main_module: "worker.js",
    compatibility_date: spec.compatibilityDate ?? "2024-09-23",
    bindings: [{ type: "d1", name: "LINKS", id: dbID }],
  });
  const body = new Blob([
    `--edge\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n`,
    `--edge\r\nContent-Disposition: form-data; name="worker.js"; filename="worker.js"\r\nContent-Type: application/javascript+module\r\n\r\n${files.script}\r\n--edge--\r\n`,
  ]);
  const uploaded = await request(
    `https://api.cloudflare.com/client/v4/accounts/${spec.accountId}/workers/scripts/${spec.worker}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "multipart/form-data; boundary=edge",
      },
      body,
      signal: AbortSignal.timeout(30000),
    },
  );
  const data = (await uploaded.json()) as { success: boolean };
  if (!uploaded.ok || !data.success)
    throw new Error(`Worker script upload failed (${uploaded.status})`);
  const zone = await cf.zone(spec.zone);
  await cf.call(
    "PUT",
    `/accounts/${spec.accountId}/workers/domains`,
    { hostname: spec.hostname, service: spec.worker, zone_id: zone },
    "Workers: Edit",
  );
  return { ...plan, databaseId: dbID };
}

export async function upsertCustomer(
  spec: WorkerSpec,
  id: string,
  pubkey: string,
  apply: boolean,
  token = requireCloudflareToken("CLOUDFLARE_API_TOKEN"),
  request: typeof fetch = fetch,
) {
  const cf = new Cloudflare(token, request);
  const list = await cf.call<{ uuid: string; name: string }[]>(
    "GET",
    `/accounts/${spec.accountId}/d1/database`,
    undefined,
    "D1: Edit",
  );
  const db = list.find((d) => d.name === spec.database);
  if (!db) throw new Error("Worker database is not deployed");
  if (!apply) return { id, pubkey, database: db.uuid };
  await cf.call(
    "POST",
    `/accounts/${spec.accountId}/d1/database/${db.uuid}/query`,
    {
      sql: "INSERT INTO customers (id, pubkey, quota, created_at) VALUES (?, ?, 200, unixepoch()) ON CONFLICT(id) DO UPDATE SET pubkey=excluded.pubkey",
      params: [id, pubkey],
    },
    "D1: Edit",
  );
  return { id, pubkey, database: db.uuid };
}
