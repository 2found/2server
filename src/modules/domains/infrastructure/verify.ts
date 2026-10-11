import type { Config } from "../../config/application/config";
import type { AuthMap } from "../../extensions/domain/types";
import { run } from "../../../shared/infrastructure/process";

// DNS propagation is checked on the operator's own resolver, which can be
// stuck with a stale negative/AAAA-only cache long after authoritative NS
// serves the A record (observed: local getaddrinfo ENOTFOUND while dig and
// the VM resolve fine). When fetch can't connect, fall back to curl with a
// DoH-resolved IPv4 literal — TLS SNI still carries the hostname, so the
// certificate and Host routing checks are unchanged.
async function resolveIPv4(host: string): Promise<string | undefined> {
  const doh = await fetch(
    `https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`,
  ).then((r) => r.json()).catch(() => undefined);
  return (doh as { Answer?: { data?: string }[] } | undefined)?.Answer
    ?.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a.data ?? ""))?.data;
}
// One HTTPS request with the same DoH fallback, returning status and a bounded
// body. curl reads its whole config (including any Authorization header) from
// stdin, so a credential never appears in a process argument.
export async function httpsRequest(
  url: string,
  authorization?: string,
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = authorization ? { Authorization: authorization } : {};
  try {
    const r = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(15000) });
    return { status: r.status, body: (await r.text()).slice(0, 1 << 20) };
  } catch {
    const host = new URL(url).hostname, ip = await resolveIPv4(host);
    if (!ip) throw new Error(`${host} is unreachable`);
    const config = [`url = ${JSON.stringify(url)}`, `resolve = ${JSON.stringify(`${host}:443:${ip}`)}`,
      ...(authorization ? [`header = ${JSON.stringify("Authorization: " + authorization)}`] : [])].join("\n") + "\n";
    const out = await run(["curl", "-s", "--connect-timeout", "10", "--max-time", "15", "--max-filesize", "1048576", "-w", "\n%{http_code}", "-K", "-"], config)
      .catch(() => { throw new Error(`${host} is unreachable`); });
    const at = out.lastIndexOf("\n"), status = Number.parseInt(out.slice(at + 1), 10);
    if (!(status > 0)) throw new Error(`${host} is unreachable`);
    return { status, body: out.slice(0, at) };
  }
}
async function probeViaResolvedIp(url: string): Promise<number | undefined> {
  const host = new URL(url).hostname;
  const ip = await resolveIPv4(host);
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
          const url = `https://${host}${d.requireAuth ? "/-/ready" : (d.healthPath ?? "/")}`;
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
