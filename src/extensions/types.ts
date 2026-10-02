import { z } from "zod";
import type { Config, Domain } from "../config";

// Extension authoring standard — see docs/extensions.md.
//
// One manifest extension = one declaration file under src/extensions/. The
// registry in ./index.ts is the single list; engines (stateful.ts,
// deploy-extensions.ts), CLI dispatch (resources.ts), source documents
// (documents.ts, templates.ts, file-command.ts) and config validation
// (config.ts) all derive their behavior from these fields.

// Credentials a domain-facing extension contributes to the edge release,
// keyed by the domain name they protect (Caddy basic_auth).
export type Credentials = {
  username: string;
  password: string;
  passwordHash: string;
};
export type AuthMap = Record<string, Credentials>;

// Hooks for extensions whose lifecycle is the shared stateful engine
// (src/stateful.ts): postgres, redis, nats. All shell strings run under
// `set -Eeuo pipefail` on the VM while holding the per-extension lock.
export interface StatefulHooks {
  // Build this extension's release files and its compose service fragment.
  // `files` starts with extension.json; the engine appends compose.json.
  // `service` is pre-filled with the shared safety baseline (image, container
  // name, restart, mem/cpu limits, pids_limit, no-new-privileges, ownership
  // labels, edge network, bounded logging, no published ports). Mutate both.
  files(c: Config, files: Record<string, string>, service: Record<string, unknown>): void | Promise<void>;
  // Extra preflight shell appended after ownership/data-path checks. Used for
  // disk mounts, credentials and data-layout invariants. Default: "".
  preflight?(c: Config): string;
  // Host preparation before the release activates (idempotent, runs inside
  // the deploy script). Example: redis vm.overcommit sysctl. Default: "".
  prepareHost?(c: Config): string;
  // Per-release file adjustments run inside the release dir. `release` is the
  // absolute bundle path. Example: making pgbackrest.conf world-readable.
  // Default: "".
  prepareRelease?(c: Config, release: string): string;
  // Operator-side step between preflight and upload. Example: provisioning
  // backup storage. Default: none.
  beforeUpload?(c: Config): Promise<void>;
  // Post-start verification shell run while the release is still unattached;
  // a failure restores the previous bundle. Default: "".
  verify?(c: Config): string;
  // Install shell appended after the release pointer flips (systemd units,
  // metric files). Failures do not roll back the release. Default: "".
  postInstall?(c: Config): string;
  // Extra remote SSH invocations after the deploy script returns (they must
  // not take the extension's deployment lock). Default: none.
  afterDeploy?(c: Config): Promise<void>;
  // Extra shell at the start of removal, before `compose down`. Default: "".
  teardown?(c: Config): string;
}

export interface Extension {
  // Key of config.extensions — camelCase: "postgres", "imageProxy".
  name: string;
  // Name used in `2server init extension <name>` and Extension source
  // documents — kebab-case DNS-style, matching ^[a-z][a-z0-9-]{0,47}$.
  // Omit when it equals `name`.
  cliName?: string;
  // Zod schema for the manifest value at config.extensions[name]. Parsed
  // output must be falsy when disabled or carry the full desired state.
  schema: z.ZodType;
  // Bare spec used by `init extension` to generate an Extension document.
  // Reference every required secret via its *Env field; init wraps them as
  // provider:vm references automatically.
  template?: Record<string, unknown>;
  // Where the enabled spec lives. Default: config.extensions[name]; generic
  // services resolve their entry from config.extensions.services[name].
  spec?(c: Config): unknown;
  // Narrowed extensions object used when a single extension is deployed
  // through `create|update|reload extension`. Must include only the keys this
  scoped(c: Config): Partial<Config["extensions"]>;
  // Deploy the configured extension onto the VM. Stateful extensions leave
  // this unset; the engine (src/stateful.ts) owns their lifecycle.
  deploy?(c: Config): Promise<void>;
  // Stop the extension on the VM before its manifest entry is removed.
  // Must not delete user data volumes. Stateful extensions leave this unset.
  remove?(c: Config): Promise<void>;
  // Container whose stdout `logs extension NAME` tails. Default:
  // `two-<server>-<name>`.
  logTarget?(c: Config): string;
  // Domains this extension publishes when enabled (e.g. monitoring's
  // authenticated Prometheus route). Appended to config.domains by
  // withExtensionDomains and reconciled by the extension deploy workflow.
  domains?(c: Config): Domain[];
  // Edge credentials for published domains, keyed by domain name.
  auth?(c: Config, state: string): Promise<AuthMap>;
  // Cross-field validation beyond `schema`; runs inside configSchema's
  // superRefine with access to the whole parsed config. Keep unconditional
  // checks unconditional — e.g. webhook name uniqueness must hold even while
  // monitoring is disabled.
  validate?(c: Config, ctx: z.RefinementCtx): void;
  // Stateful extensions declare their engine hooks here.
  stateful?: StatefulHooks;
  // Host data paths that must be distinct and non-overlapping across
  // extensions (checked by config.ts). Stateful extensions return dataPath.
  dataPaths?(c: Config): string[];
  // Fields that may never change once the extension exists in the manifest
  // (guards implicit data migration through source-file apply).
  immutable?: string[];
  // Extension source documents may carry a `webhooks:` receiver list only
  // for the extension that owns alerting (monitoring).
  acceptsWebhooks?: boolean;
}
