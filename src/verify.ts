import type { Config } from "./config";
import type { AuthMap } from "./monitoring";
export async function verifyPublic(
  c: Config,
  request: (url: string, init?: RequestInit) => Promise<Response> = fetch,
  attempts = 5,
  delay = 3000,
  auth: AuthMap = {},
) {
  for (const d of c.domains)
    for (const host of d.hosts) {
      const credential = auth[d.name];
      if (d.requireAuth && !credential)
        throw new Error(`Missing credentials to verify ${d.name}`);
      let healthy = false;
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          const response = await request(
            `https://${host}${d.requireAuth ? "/-/ready" : "/"}`,
            {
              redirect: "manual",
              signal: AbortSignal.timeout(15000),
            },
          );
          healthy = d.requireAuth
            ? response.status === 401
            : d.cache === "app"
              ? response.status >= 200 && response.status < 400
              : response.status === 404;
          await response.body?.cancel();
          if (healthy && d.requireAuth) {
            const signed = await request(`https://${host}/-/ready`, {
              redirect: "manual",
              signal: AbortSignal.timeout(15000),
              headers: {
                Authorization:
                  "Basic " +
                  Buffer.from(
                    `${credential.username}:${credential.password}`,
                  ).toString("base64"),
              },
            });
            healthy = signed.status === 200;
            await signed.body?.cancel();
          }
          if (healthy) break;
        } catch {
          healthy = false; /* DNS and Universal SSL may still be propagating. */
        }
        if (attempt + 1 < attempts) await Bun.sleep(delay);
      }
      if (!healthy)
        throw new Error(
          `${host}: public HTTPS verification failed; DNS may already be published. Check propagation/origin, then retry the domain command (or run verify for an already-saved manifest).`,
        );
    }
}
