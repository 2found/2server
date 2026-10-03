# Source-driven deployment

Read `docs/source-config.md` for the supported schema and CLI contract.

- Locate the app's reviewed `2server/*.yaml`, or a shared `platform/*.yaml`.
  Deploy with `deploy -f FILE` or `apply -f FILE`; do not reconstruct a desired
  App spec by merging old VM configuration. Paths inside files are relative to
  the file. Unknown fields fail. Keep secrets out of env/runtime templates.
- Connection is optional: nearest `.2server/connection.yaml` (legacy JSON is
  supported), or explicit `--connection` / `--ssh`. Show which VM/file is selected.
- Source documents declare secret references. If missing, explain which namespace
  and key to set with `secret set [--app NAME] --env-file PRIVATE_FILE --apply`.
  Never ask for values in chat, print them, or fall back to machine-local dotenv.
  `secret list` shows names only. Deletion is explicit and refuses deployed refs.
- Builds belong to the app release script; prefer spec.preDeploy for VM-side migrations. Pass the build's own
  digest as an optional image override. For migration-required apps, only pass
  `--migrations-applied` after migration succeeds. Without a configured preDeploy hook, the CLI does not perform it.
- `init app NAME -o app/2server/deploy.yaml` creates an App with a domain.
  Edit its image/port/hostname and remove domains if it is private. App/Domain
  plans inspect Cloudflare before rollout; apply still rechecks current state.
- `init app NAME --template TEMPLATE -o platform/NAME.yaml` creates a named App,
  then validate/plan/apply it. It does not install or provision anything by itself.
  `secret set --app NAME` supplies its values; `app NAME help` lists installed
  template commands. Default templates are not evidence that existing Redis/NATS/Postgres resources
  are adopted. Existing data paths and ownership must be checked before applying.
- Tags are registry-resolved every time; no registry failure fallback. A plan may
  pull layers but never switches traffic. Apply recomputes against current VM
  revision and takes the operator lock. Do not delete a held lock to force a run.
- Use one App manifest; no companion Compose/runtime file. The CLI generates
  container/Caddy configuration. Declare healthCheck, logical volumeMounts and
  optional instanceEnv in spec. Only instanceEnv substitutes `${generation}`;
  public env stays literal. Physical volume bindings and runtime identities stay
  on the VM. Preserve them when switching source versions. Existing legacy
  runtimeFile input is compatibility-only; never export its resolved secrets.
- Use `rollback -f FILE --apply` for a saved app generation. Stateful extensions
  use restore/update, and deletion preserves data. Removing a file does nothing
  remotely. Removing domains from an App file does not retire DNS.

## Pre-deploy tasks

Declare a migration program shipped inside the app image:

```yaml
spec:
  preDeploy:
    command: [bun, run, scripts/migrate-schema.ts]
    timeoutSeconds: 300
```

The CLI runs this once for every applied deployment (including the same image),
using the resolved candidate image and candidate environment/secrets on the VM,
under the app lock before starting the candidate or stopping current workers.
This is an argv array, not shell text; use an explicit shell only when needed.
The one-shot container uses the edge network and app resource limits, with no
app data volumes, host mounts, published ports or Docker socket. Use it for
external database migrations; per-instance database initialization belongs to
that instance. A nonzero exit/timeout aborts rollout and removes the task
container. Logs stay private beside the VM release's app.env as pre-deploy.log.
Migrations must be idempotent and compatible with the still-serving old app.
Traffic rollback does not undo database changes and does not rerun preDeploy.

Use `preDeploy.secrets` to override credentials only for the one-shot task, e.g.
`DATABASE_URL: {provider: vm, key: MIGRATION_DATABASE_URL}`. Keep the runtime
`spec.secrets.DATABASE_URL` on a DML-only login. Task credentials are written to
a separate private env file and are not passed to the application container.
Scaling to zero skips the task; other applied releases rerun it.

Build scripts should build/push and call `2server deploy -f FILE --apply`.
With preDeploy configured, remove local migration/secret-fetch commands and
`--migrations-applied`. That flag remains a legacy acknowledgement for apps
without a configured hook; it never bypasses a configured preDeploy task.

For Caddy-based app images, check the executable's file capabilities. Declare
`spec.capabilities: [NET_BIND_SERVICE]` when required; do not remove cap-drop ALL,
no-new-privileges or use privileged mode to make the candidate start.
