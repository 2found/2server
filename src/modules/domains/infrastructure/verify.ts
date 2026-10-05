import type { Config } from "../../config/application/config";
import type { AuthMap } from "../../extensions/domain/types";
import { run } from "../../../shared/infrastructure/process";

// DNS propagation is checked on the operator's own resolver, which can be
// stuck with a stale negative/AAAA-only cache long after authoritative NS
// serves the A record (observed: local getaddrinfo ENOTFOUND while dig and
// the VM resolve fine). When fetch can't connect, fall back to curl with a
// DoH-resolved IPv4 literal — TLS SNI still carries the hostname, so the
// certificate and Host routing checks are unchanged.
async function probeViaResolvedIp(url: string): Promise<number | undefined> {
  const host = new URL(url).hostname;
  const doh = await fetch(
    `https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`,
  ).then((r) => r.json()).catch(() => undefined);
  const ip = (doh as { Answer?: { data?: string }[] } | undefined)?.Answer
    ?.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a.data ?? ""))?.data;
  if (!ip) return undefined;
  const out = await run([
    "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
    "--resolve", `${host}:443:${ip}`,
    "--connect-timeout", "10", "--max-time", "15",
    url,
  ]).catch(() => "");
  const status = Number.parseInt((typeof out === "string" ? out : "").trim(), 10);
  return Number.isFinite(status) && status > 0 ? status : undefined;
}
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
          const url = `https://${host}${d.requireAuth ? "/-/ready" : "/"}`;
          const response = await request(url, {
            redirect: "manual",
            signal: AbortSignal.timeout(15000),
          }).catch(async () => {
            const status = await probeViaResolvedIp(url);
            if (status === undefined) throw new Error("unreachable");
            return new Response(null, { status });
          });
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
