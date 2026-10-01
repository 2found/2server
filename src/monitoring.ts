import { chmod, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { domainSchema, type Config, type Domain } from "./config";
export const monitoringName = "two-server-monitoring";
export type Credentials = {
  username: string;
  password: string;
  passwordHash: string;
};
export type AuthMap = Record<string, Credentials>;
export function monitoringSettings(c: Config) {
  const m = c.extensions.monitoring;
  if (!m) return undefined;
  const options = typeof m === "object" ? m : undefined;
  const zones = [
    ...new Set(
      c.domains.filter((d) => d.name !== monitoringName).map((d) => d.zone),
    ),
  ];
  const zone = options?.zone ?? (zones.length === 1 ? zones[0] : undefined);
  if (!zone) throw new Error("Specify extensions.monitoring.zone");
  return {
    zone,
    hostname: options?.hostname ?? `monitor.${zone}`,
    username: options?.username ?? "admin",
    passwordEnv: options?.passwordEnv,
    adoptDns: options?.adoptDns ?? false,
  };
}
export function monitoringDomain(c: Config): Domain | undefined {
  const m = monitoringSettings(c);
  if (!m) return;
  return domainSchema.parse({
    name: monitoringName,
    zone: m.zone,
    hosts: [m.hostname],
    cache: "app",
    adoptDns: m.adoptDns,
    requireAuth: true,
    upstream: { kind: "proxy", target: `two-${c.name}-prometheus:9090` },
  });
}
export function withMonitoring(c: Config): Config {
  const domain = monitoringDomain(c);
  return domain
    ? {
        ...c,
        domains: [
          ...c.domains.filter((d) => d.name !== monitoringName),
          domain,
        ],
      }
    : c;
}
export function monitoringCredentialPath(state: string) {
  return join(state, "monitoring-credentials.json");
}
export async function monitoringAuth(
  c: Config,
  state: string,
  create = true,
): Promise<AuthMap> {
  const m = monitoringSettings(c);
  if (!m) return {};
  const path = monitoringCredentialPath(state);
  let password: string;
  if (m.passwordEnv) {
    const value = process.env[m.passwordEnv];
    if (
      !value ||
      Buffer.byteLength(value) < 16 ||
      Buffer.byteLength(value) > 72 ||
      /[\r\n\0]/.test(value)
    )
      throw new Error(
        `Monitoring password ${m.passwordEnv} must be 16–72 bytes without newlines`,
      );
    password = value;
  } else if (await Bun.file(path).exists()) {
    const saved = await Bun.file(path).json();
    if (
      typeof saved.password !== "string" ||
      Buffer.byteLength(saved.password) < 16 ||
      Buffer.byteLength(saved.password) > 72 ||
      /[\r\n\0]/.test(saved.password)
    )
      throw new Error("Invalid saved monitoring credentials");
    await chmod(path, 0o600);
    password = saved.password;
  } else {
    if (!create)
      throw new Error(
        `Monitoring credentials not found at ${path}; use the operator state from deployment`,
      );
    password = randomBytes(32).toString("base64url");
    await mkdir(state, { recursive: true, mode: 0o700 });
    await chmod(state, 0o700);
    const temp = path + ".next";
    await Bun.write(
      temp,
      JSON.stringify({ username: m.username, password }, null, 2) + "\n",
      { mode: 0o600 },
    );
    await rename(temp, path);
  }
  return {
    [monitoringName]: {
      username: m.username,
      password,
      passwordHash: await Bun.password.hash(password, {
        algorithm: "bcrypt",
        cost: 12,
      }),
    },
  };
}
