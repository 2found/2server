import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Cloudflare, CloudflareError, requireCloudflareToken } from "../../../../domains/infrastructure/cloudflare";
import type { WorkerSpec } from "./domain/spec";

export type WorkerFiles = { script: string; schemaSql?: string };

// The D1 list endpoint pages at 20 by default, so an unpaged lookup misses an
// existing database on a busy account and the plan reports it as absent.
const D1_PAGE = 1000;

export function workerTemplateFiles(cliName: string): WorkerFiles {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(cliName)) throw new Error("Invalid definition name");
  const dir = fileURLToPath(new URL(`../${cliName}/`, import.meta.url));
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
  // Resolve zone scope and account identity before creating D1 or uploading code.
  const zone = await cf.zone(spec.zone);
  const details = await cf.call<{ account: { id: string } }>("GET", `/zones/${zone}`);
  if (details.account?.id !== spec.accountId)
    throw new Error("Worker zone/account mismatch");
  const list = await cf.call<{ uuid: string; name: string }[]>(
    "GET",
    `/accounts/${spec.accountId}/d1/database?per_page=${D1_PAGE}`,
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
  const operation = `PUT /accounts/${spec.accountId}/workers/scripts/${spec.worker}`;
  const permission = "Workers Scripts: Edit / Workers product Admin (new Worker)";
  let data: { success: boolean; errors?: { code: number }[] };
  try {
    data = await uploaded.json() as typeof data;
  } catch {
    throw new CloudflareError(uploaded.status, [], operation, permission);
  }
  if (!uploaded.ok || !data.success)
    throw new CloudflareError(uploaded.status, data.errors?.map(e => e.code) ?? [], operation, permission);
  await cf.call(
    "PUT",
    `/accounts/${spec.accountId}/workers/domains`,
    { hostname: spec.hostname, service: spec.worker, zone_id: zone },
    "Workers Scripts: Edit and Zone Workers Routes: Edit (custom domain); Workers product scope",
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
    `/accounts/${spec.accountId}/d1/database?per_page=${D1_PAGE}`,
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
