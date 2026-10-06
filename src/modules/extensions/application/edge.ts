import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Cloudflare, requireCloudflareToken } from "../../domains/infrastructure/cloudflare";

export type WorkerSpec = {
  accountId: string;
  worker: string;
  hostname: string;
  zone: string;
  database: string;
  compatibilityDate?: string;
};

const scriptPath = fileURLToPath(
  new URL("../infrastructure/templates/cloudflare-worker/worker.js", import.meta.url),
);

export function workerScript(): string {
  return readFileSync(scriptPath, "utf8");
}

export async function deployCloudflareWorker(
  spec: WorkerSpec,
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
  const existing = list.find((d) => d.name === spec.database);
  const plan = {
    worker: spec.worker,
    hostname: spec.hostname,
    database: spec.database,
    databaseId: existing?.uuid ?? null,
    url: `https://${spec.hostname}`,
    scriptBytes: workerScript().length,
  };
  if (!apply) return plan;
  const dbID = await ensureDatabase(cf, spec, existing?.uuid);
  await putScript(token, spec, dbID, workerScript(), request);
  await attachHostname(cf, spec);
  return { ...plan, databaseId: dbID };
}

async function ensureDatabase(cf: Cloudflare, spec: WorkerSpec, existing?: string): Promise<string> {
  const id = existing ?? (await cf.call<{ uuid: string }>(
    "POST",
    `/accounts/${spec.accountId}/d1/database`,
    { name: spec.database },
    "D1: Edit",
  )).uuid;
  await cf.call(
    "POST",
    `/accounts/${spec.accountId}/d1/database/${id}/query`,
    {
      sql: "CREATE TABLE IF NOT EXISTS customers (id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, quota INTEGER NOT NULL DEFAULT 200, created_at INTEGER); CREATE TABLE IF NOT EXISTS links (code TEXT PRIMARY KEY, url TEXT NOT NULL, iss TEXT NOT NULL, sub TEXT, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS idx_links_iss ON links(iss);",
    },
    "D1: Edit",
  );
  return id;
}

async function putScript(
  token: string,
  spec: WorkerSpec,
  dbID: string,
  script: string,
  request: typeof fetch,
) {
  const metadata = JSON.stringify({
    main_module: "worker.js",
    compatibility_date: spec.compatibilityDate ?? "2024-09-23",
    bindings: [{ type: "d1", name: "LINKS", id: dbID }],
  });
  const body = new Blob([
    `--edge\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n`,
    `--edge\r\nContent-Disposition: form-data; name="worker.js"; filename="worker.js"\r\nContent-Type: application/javascript+module\r\n\r\n${script}\r\n--edge--\r\n`,
  ]);
  const response = await request(
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
  const data = (await response.json()) as { success: boolean };
  if (!response.ok || !data.success)
    throw new Error(`Worker script upload failed (${response.status})`);
}

async function attachHostname(cf: Cloudflare, spec: WorkerSpec) {
  const zone = await cf.zone(spec.zone);
  await cf.call(
    "PUT",
    `/accounts/${spec.accountId}/workers/domains`,
    { hostname: spec.hostname, service: spec.worker, zone_id: zone },
    "Workers: Edit",
  );
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
