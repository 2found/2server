import { quote } from "../../../shared/infrastructure/process";
import type { Config } from "../../config/application/config";
import type { Extension } from "../domain/types";

// Generic service extensions: one instance per arbitrary name, declared as a
// `kind: Service` source document or `extensions.services.<name>` in the
// manifest. A service is one container on the edge network — no blue/green, no
// published ports, secrets resolved like apps. Lifecycle is the shared
// stateful engine: versioned release bundles, per-extension lock, ownership
// checks, compose up --wait with rollback. See docs/extensions.md.
import { serviceSchema,type ServiceSpec } from "../domain/service";

export function serviceSpecOf(c: Config, svc: string): ServiceSpec | undefined {
  return (c.extensions.services ?? {})[svc];
}

// One Extension view per configured service, so the engines and CLI dispatch
// treat a named service exactly like a declared extension.
export function serviceExtension(svc: string, spec: ServiceSpec): Extension {
  return {
    name: svc,
    cliName: svc,
    schema: serviceSchema,
    template: {},
    outputs: spec.port ? { endpoint: { type: 'endpoint', protocol: 'http', port: spec.port } } : {},
    immutable: ["dataPath"],
    stateful: {
      async files(c, files, service) {
        const { resolveEnvMap } = await import("../../apps/application/environment");
        service.command = spec.command;
        service.healthcheck = spec.healthCheck
          ? {
              test: ["CMD", ...spec.healthCheck.command],
              interval: `${spec.healthCheck.intervalSeconds}s`,
              timeout: `${spec.healthCheck.timeoutSeconds}s`,
              start_period: `${spec.healthCheck.startPeriodSeconds}s`,
              retries: spec.healthCheck.failureThreshold,
            }
          : undefined;
        if (spec.user) service.user = spec.user;
        if (spec.dataPath) {
          service.user ??= "0:0";
          service.volumes = [`${spec.dataPath}:/data`];
        }
        if (spec.readOnly) {
          service.read_only = true;
          service.tmpfs = ["/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777"];
        }
        if (spec.capDropAll) service.cap_drop = ["ALL"];
        if (spec.pidsLimit) service.pids_limit = spec.pidsLimit;
        // Environment lives inside compose.json, not an env_file: the engine
        // $-escapes compose.json, so secret values stay literal. An env_file
        // would let Compose interpolate/parse secret values and corrupt them.
        service.environment = await resolveEnvMap({
          name: svc,
          env: spec.env,
          secrets: spec.secrets,
          bindings: spec.bindings,
        }, c);
      },
      prepareHost: () => serviceDataOwnership(spec),
    },
    spec: (c) => serviceSpecOf(c, svc),
  };
}

// Runs after the engine writes the ownership marker. Never follows links the
// workload planted. The marker stays root-owned; a replaced marker fails the
// ownership checks closed.
export function serviceDataOwnership(spec: Pick<ServiceSpec, 'user' | 'dataPath'>): string {
  if (!spec.user || !spec.dataPath) return "";
  const [uid, gid] = spec.user.split(":"), data = quote(spec.dataPath), marker = quote(`${spec.dataPath}/.2server-owner`);
  return `test -d ${data} && test ! -L ${data}
find ${data} -xdev ! -path ${marker} \\( ! -user ${uid} -o ! -group ${gid} \\) -exec chown -h ${uid}:${gid} {} +
chown 0:0 ${marker}
chmod 0644 ${marker}`;
}
