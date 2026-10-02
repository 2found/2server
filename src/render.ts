import type { Config, Domain } from "./config";
import type { Credentials } from "./monitoring";
function upstream(u: Domain["upstream"]) {
  return u.kind === "import" ? `import ${u.name}` : `reverse_proxy ${u.target}`;
}
export function renderSite(d: Domain, auth?: Credentials): string {
  if (d.requireAuth && !auth)
    throw new Error(`Missing authentication for ${d.name}`);
  const authBlock = auth
    ? `basic_auth {\n    ${auth.username} ${auth.passwordHash}\n  }\n  header Cache-Control "no-store"`
    : "";
  const routes = d.routes
    .map(
      (r) =>
        `${r.strip ? "handle_path" : "handle"} ${r.prefix.replace(/\/$/, "")}/* {\n    ${upstream(r.upstream)}\n  }`,
    )
    .join("\n  ");
  const routing =
    d.cache === "app"
      ? `${routes}\n  handle {\n    ${upstream(d.upstream)}\n  }`
      : `handle ${d.cache === "images" ? "/i/*" : "/a/*"} {\n    ${upstream(d.upstream)}\n  }\n  handle {\n    respond 404\n  }`;
  return `${d.hosts.join(", ")} {\n  tls /etc/2server/current/tls/${d.name}/cert.pem /etc/2server/current/tls/${d.name}/key.pem\n  header {\n    -Server\n    X-Content-Type-Options nosniff\n    X-Frame-Options DENY\n    Referrer-Policy strict-origin-when-cross-origin\n  }\n  ${d.cache === "app" ? "encode zstd gzip" : ""}\n  ${authBlock}\n  ${routing}\n}\n`;
}
export function renderEdge(c: Config) {
  return {
    services: {
      caddy: {
        image: "caddy:2.10.2-alpine",
        container_name: c.edge.container,
        command: [
          "caddy",
          "run",
          "--config",
          c.edge.configPath,
          "--adapter",
          "caddyfile",
        ],
        restart: "unless-stopped",
        stop_grace_period: "75s",
        security_opt: ["no-new-privileges:true"],
        pids_limit: 256,
        healthcheck: {
          test: ["CMD", "wget", "-T", "2", "-q", "-O", "/dev/null", "http://127.0.0.1:2019/config/"],
          interval: "15s", timeout: "3s", retries: 3, start_period: "10s",
        },
        mem_limit: "256m",
        ports: ["80:80", "443:443"],
        volumes: [
          "/opt/2server/edge:/etc/2server:ro",
          "/opt/2server/runtime:/etc/caddy:ro",
          "two_server_caddy_data:/data",
          "two_server_caddy_config:/config",
        ],
        networks: [c.edge.network],
        logging: {
          driver: "json-file",
          options: { "max-size": "10m", "max-file": "3" },
        },
      },
    },
    networks: { [c.edge.network]: { external: true } },
    volumes: { two_server_caddy_data: {}, two_server_caddy_config: {} },
  };
}
export const baseCaddyfile = `{\n  grace_period 60s\n}\nimport /etc/2server/apps/*.caddy\nimport /etc/2server/current/sites/*.caddy\n`;
