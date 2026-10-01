import type { Config, Domain } from "./config";

export function requireCloudflareToken(envName: string): string {
  const token = process.env[envName]?.trim();
  if (!token)
    throw new Error(
      `Missing Cloudflare credential: ${envName}. Set ${envName} in 2server/.env (see .env.example), or export it for CI. Run commands from the 2server directory. See README.md#cloudflare-access-and-ownership for token setup.`,
    );
  return token;
}

export class CloudflareError extends Error {
  constructor(
    public status: number,
    public codes: number[],
    public operation?: string,
    public permission?: string,
  ) {
    super(
      `Cloudflare ${operation ?? "request"} failed (HTTP ${status}, codes ${codes.join(",")}); ${[401, 403].includes(status)
        ? `check the API token in 2server/.env, its expiry, ${permission ? `zone-level ${permission} permission, ` : "permissions, "}and token zone scope. For account-owned tokens, check the resource selection: Entire <account name> account. The managed zones must be included; account-level SSL permissions do not replace zone-level SSL permissions. See README.md#cloudflare-access-and-ownership.`
        : "check token permissions and zone plan"}`,
    );
  }
}
type RecordRow = {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied?: boolean;
  comment?: string;
};
type Rule = {
  id?: string;
  ref?: string;
  expression: string;
  action: string;
  action_parameters: Record<string, unknown>;
  description: string;
  enabled: boolean;
};
type Ruleset = { id: string; rules?: Rule[] };
export class Cloudflare {
  constructor(
    private token: string,
    private request: typeof fetch = fetch,
  ) {}
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    // Never include query parameters, credentials or provider response bodies.
    const pathname = path.split("?")[0];
    const operation = `${method} ${pathname}`;
    const permission = pathname === "/zones"
      ? "Zone: Read"
      : pathname === "/certificates"
        ? "SSL and Certificates: Edit"
        : pathname.endsWith("/settings/ssl")
          ? "Zone Settings: Edit"
          : pathname.includes("/dns_records")
            ? "DNS: Edit"
            : pathname.includes("/rulesets")
              ? "Cache Rules / Cache Settings: Edit"
              : undefined;
    const response = await this.request(
      `https://api.cloudflare.com/client/v4${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      },
    );
    let data: { success: boolean; result: T; errors?: { code: number }[] };
    try {
      data = (await response.json()) as typeof data;
    } catch {
      throw new CloudflareError(response.status, [], operation, permission);
    }
    if (!response.ok || !data.success)
      throw new CloudflareError(
        response.status,
        data.errors?.map((e) => e.code) ?? [],
        operation,
        permission,
      );
    return data.result;
  }
  async zone(name: string) {
    const zones = await this.call<
      { id: string; name: string; status: string }[]
    >(
      "GET",
      `/zones?name=${encodeURIComponent(name)}&status=active&per_page=50`,
    );
    if (zones.length !== 1 || zones[0].name !== name)
      throw new Error(`Expected one active Cloudflare zone: ${name}`);
    return zones[0].id;
  }
  async records(zone: string, host: string) {
    return this.call<RecordRow[]>(
      "GET",
      `/zones/${zone}/dns_records?name=${encodeURIComponent(host)}&per_page=100`,
    );
  }
  async ruleset(zone: string): Promise<Ruleset | undefined> {
    try {
      return await this.call<Ruleset>(
        "GET",
        `/zones/${zone}/rulesets/phases/http_request_cache_settings/entrypoint`,
      );
    } catch (e) {
      if (
        e instanceof CloudflareError &&
        e.status === 404 &&
        e.codes.includes(10003)
      )
        return undefined;
      throw e;
    }
  }
}
export function cacheRule(project: string, domain: Domain): Rule {
  const host = `http.host in {${domain.hosts.map((h) => `"${h}"`).join(" ")}}`;
  const publicPath = domain.cache === "images" ? "/i/" : "/a/";
  return {
    ref: `two_server_${project}_${domain.name}`.replaceAll("-", "_"),
    description: `2server:${project}:${domain.name}`,
    enabled: true,
    expression:
      domain.cache === "app"
        ? `(${host})`
        : `(${host} and starts_with(http.request.uri.path, "${publicPath}") and http.request.method in {"GET" "HEAD"} and http.cookie eq "" and not any(http.request.headers["authorization"][*] ne ""))`,
    action: "set_cache_settings",
    action_parameters:
      domain.cache === "app"
        ? { cache: false }
        : {
            cache: true,
            edge_ttl: { mode: "respect_origin" },
            browser_ttl: { mode: "respect_origin" },
          },
  };
}
export type DomainPlan = {
  domain: Domain;
  zoneId: string;
  dns: { host: string; existing?: RecordRow; change: boolean }[];
  sslChange: boolean;
  rule: Rule;
  ruleset?: Ruleset;
};
export async function inspectDomains(
  cf: Cloudflare,
  c: Config,
): Promise<DomainPlan[]> {
  if (!c.originIp)
    throw new Error("Resolve the VM origin address before planning domains");
  const plans: DomainPlan[] = [];
  for (const domain of c.domains) {
    const zoneId = await cf.zone(domain.zone);
    const ssl = await cf.call<{ value: string }>(
      "GET",
      `/zones/${zoneId}/settings/ssl`,
    );
    const dns: DomainPlan["dns"] = [];
    for (const host of domain.hosts) {
      const rows = (await cf.records(zoneId, host)).filter((r) =>
        ["A", "AAAA", "CNAME"].includes(r.type),
      );
      if (rows.length > 1 || rows.some((r) => r.type !== "A"))
        throw new Error(
          `${host}: conflicting A/AAAA/CNAME records; reconcile these explicitly first`,
        );
      const existing = rows[0];
      const owner = `2server:${c.name}:${domain.name}`;
      if (existing && existing.comment !== owner && !domain.adoptDns)
        throw new Error(
          `${host}: existing DNS is unowned; set adoptDns after reviewing it`,
        );
      dns.push({
        host,
        existing,
        change:
          !existing ||
          existing.content !== c.originIp ||
          !existing.proxied ||
          existing.comment !== owner,
      });
    }
    const ruleset = await cf.ruleset(zoneId);
    const rule = cacheRule(c.name, domain);
    if ((ruleset?.rules ?? []).filter((r) => r.ref === rule.ref).length > 1)
      throw new Error("Duplicate managed cache rule");
    plans.push({
      domain,
      zoneId,
      dns,
      sslChange: ssl.value !== "strict",
      rule,
      ruleset,
    });
  }
  return plans;
}
export async function applyPolicies(cf: Cloudflare, plans: DomainPlan[]) {
  for (const p of plans) {
    const rules =
      p.domain.cache === "app"
        ? [p.rule]
        : [
            {
              ...cacheRule("unused", { ...p.domain, cache: "app" }),
              ref: `${p.rule.ref}_bypass`,
              description: `${p.rule.description}: bypass by default`,
            },
            p.rule,
          ];
    for (const rule of rules) {
      // Re-read each time; never overwrite unrelated rules in an existing zone.
      const ruleset = await cf.ruleset(p.zoneId);
      if (!ruleset)
        await cf.call("POST", `/zones/${p.zoneId}/rulesets`, {
          name: "2server cache policies",
          kind: "zone",
          phase: "http_request_cache_settings",
          rules: [rule],
        });
      else {
        const old = ruleset.rules?.find((r) => r.ref === rule.ref);
        await cf.call(
          old ? "PATCH" : "POST",
          `/zones/${p.zoneId}/rulesets/${ruleset.id}/rules${old ? `/${old.id}` : ""}`,
          { ...rule, position: { after: "" } },
        );
      }
    }
  }
}
export async function publishDns(
  cf: Cloudflare,
  c: Config,
  plans: DomainPlan[],
) {
  if (!c.originIp)
    throw new Error("Origin IPv4 is required before publishing DNS");
  // Last step, after origin routing is installed and checked.
  for (const p of plans) {
    if (p.sslChange)
      await cf.call("PATCH", `/zones/${p.zoneId}/settings/ssl`, {
        value: "strict",
      });
    for (const d of p.dns) {
      // Refuse concurrent edits between preflight and publish.
      const now = (await cf.records(p.zoneId, d.host)).filter((r) =>
        ["A", "AAAA", "CNAME"].includes(r.type),
      );
      if (
        JSON.stringify(now) !== JSON.stringify(d.existing ? [d.existing] : [])
      )
        throw new Error(`${d.host}: DNS changed since preflight; rerun plan`);
      if (d.change)
        await cf.call(
          d.existing ? "PATCH" : "POST",
          `/zones/${p.zoneId}/dns_records${d.existing ? `/${d.existing.id}` : ""}`,
          {
            type: "A",
            name: d.host,
            content: c.originIp,
            ttl: 1,
            proxied: true,
            comment: `2server:${c.name}:${p.domain.name}`,
          },
        );
    }
  }
}
