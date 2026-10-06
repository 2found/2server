import { deployCloudflareWorker, type WorkerSpec } from "../../../application/edge";
import type { ExtensionHooks } from "../../../domain/types";

export const cloudflareWorkerHooks = {
  async deploy(c) {
    if (!c.instance) throw new Error("cloudflare-worker is a named App; use init app NAME --template cloudflare-worker");
    const spec = c.extensionApps[c.instance.name]?.spec as WorkerSpec | undefined;
    if (!spec) throw new Error("missing cloudflare-worker spec");
    await deployCloudflareWorker(spec, true);
  },
  async remove() {
    throw new Error("Retire a Worker by deleting its Cloudflare custom domain and script explicitly; 2server will not destroy D1 data");
  },
} satisfies ExtensionHooks;
