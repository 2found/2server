# VM-owned configuration and recovery

2server executes on the operator machine and treats the VM as the source of
truth. It does not require a resident agent, public control API or persistent
local manifest. A connection file is an optional shortcut. SSH must use a trusted
host key and passwordless sudo. Install Bun and the tools required by the selected
operation; a GCP IAP connection additionally needs authenticated gcloud/IAP access.

## New VM

Use `server bootstrap -f server.local.json --env-file secrets.env --apply` with
an empty server manifest. It runs setup, publishes state and saves the local
connection in one operation. See the [quick start](../README.md#quick-start).
Bootstrap is create-only; use the migration path below for an existing setup.

## First migration from machine A

Run from the consuming project (use `bun 2server/src/cli.ts` for a submodule), or
use the linked `2server` executable. Existing local-manifest mode is still available
for initial setup and migration. Publish the **complete** manifest, not a release
manifest containing only one app:

```bash
2server server publish -f deployments/lohi/server.local.json --env-file 2server/.env
2server server publish -f deployments/lohi/server.local.json --env-file 2server/.env --apply
# connection.json contains just the manifest's ssh object:
2server connect --connection connection.json
```

Publishing saves only environment variables referenced by the manifest, plus
existing certificate pairs and generated monitoring credentials from the old
operator state directory. It never uploads the operator's SSH private key or
arbitrary shell/cloud-login environment. Missing secrets remain missing and the
operation that needs them fails explicitly. Publication is create-only: it refuses
to overwrite an existing control record. This operation does not change running
containers, adopt legacy apps, issue certificates or alter DNS.

## Machine B: only the connection

```bash
2server connect --ssh ubuntu@vm.example --identity ~/.ssh/server_key
2server get app
2server deploy app api --image ghcr.io/example/api@sha256:<64-hex-digest> --apply
2server domains --apply
2server get monitor
```

`connect` checks the VM and saves only SSH fields to `.2server/connection.yaml`
in the current project, mode 0600. It creates `.2server/.gitignore` containing `*`.
Commands discover the nearest `.2server/connection.yaml` from their working
directory upwards (legacy `connection.json` is also accepted). Explicit `--ssh` / `--connection` take precedence; explicit
`-f` or a legacy manifest path selects local mode. With multiple projects/VMs,
pass a connection explicitly when the working directory is ambiguous.

Direct SSH also accepts `--port`; SSH config aliases/agents work normally. GCP:

```json
{"kind":"gcp","project":"example-project","zone":"asia-southeast1-a","instance":"server","iap":true}
```

Use `connect --connection file.json` once, or append `--connection file.json` to
any manifest/resource operation. The file is a structured SSH object, never a
shell command. A machine-specific SSH identity path is kept only in the local
connection file; it is removed from the VM snapshot. Stateless CI can supply
`--ssh` on every invocation and omit `connect` entirely.

Connected commands fetch the current VM snapshot every time. Resource CRUD and
`deploy app --image` persist the complete updated manifest after successful
operation. `scripts/release.sh app/2server/deploy.yaml registry/image:tag context` builds,
pushes, deploys the resolved digest and saves applied state on the VM; it does not
rewrite the source file. Image build/registry
push authentication still belongs to the builder. Existing app migrations and
frontend build arguments remain the application's responsibility.

Environment-based app secrets need no credential file on machine B. Explicit
GCP/AWS Secret Manager references still require the operator's authorized provider
identity/CLI; they are not silently converted into frozen secret copies. Use env
references for a self-contained VM-owned secret set. VM/provider power, disks,
backup bucket provisioning and Terraform CRUD retain the original provider
workflow; they cannot depend on contacting a VM that is stopped or destroyed.

## Storage and secrets

The root-only directory `/opt/2server/control/` contains immutable `revisions/`
and an atomically switched `current` symlink. Each revision holds:

- `snapshot.json`: authoritative manifest, referenced secrets and portable state.
- `server.json`: the same manifest for inspection.
- `.env`: an inspection copy of the referenced environment secrets.

The path is fixed and root-owned, independent of SSH username or home directory.
Operators A and B may log in as different OS users; both must be authorized for
passwordless sudo. Every access refuses symlinked, incorrectly owned or group/world
writable control directories. Reading a snapshot also rejects group/world-readable
control/revision directories or snapshots, and symlinked revision files. The directory is never shared through a network API.

Directories are mode 0700 and files 0600, transferred over SSH stdin. These files
are not mounted into application containers or served by Caddy. Unprivileged host users and ordinary app containers cannot read them. Do not
mount this directory, its ancestors, or the Docker socket into application
containers. Infrastructure with a Docker socket is a root-equivalent trusted
operator, even if the socket mount is read-only. Root/sudo operators
can read them, as they can read runtime container secrets. They rely on host/disk
access controls at rest; the portable backup described below is encrypted.
Do not source or hand-edit the generated `.env`/`server.json`: update through the
CLI so the atomic snapshot remains consistent. `.env` values use JSON quoting;
the CLI reads the exact values from `snapshot.json`, with no shell interpolation.

```bash
# Write the selected referenced keys into a private local secrets.env (0600).
2server server env --env-file secrets.env --apply
# Or supply new keys along with the app/extension spec that references them:
2server create app worker --spec worker.json --env-file secrets.env --apply
```

The supplied file is parsed as dotenv without shell expansion, not executed.
Unreferenced keys and process-control environment overrides are rejected.
VM values win over stale exported variables or a checkout `.env`; absent VM keys
never fall back to a developer's secrets. Secret changes are saved configuration;
reload the affected app/extension/domain explicitly to apply them to running
services. Exporting config with `server config --output .2server/server.json`
includes ordinary app env and secret references, but excludes secret values.

Only a private temporary workspace holds fetched secrets/state during a command;
it is removed on completion. If saving back to the VM fails after an operation,
the CLI returns an error and retains a mode-0700 recovery directory whose path is
reported. Preserve it until the target state is reconciled. A hard-killed process
may also leave its private temp directory; clean it after confirming no operation
is active. Never attach those files to an issue or public artifact.

Resource reservations protect mutations that can conflict. Independent image-app
deployments overlap; app secrets reserve their app, while domain reconciliation
reserves shared domain state only during that phase. Setup, server secrets and
shared extension/dependency changes remain exclusive. Snapshot commits merge
independent changes, check reservation ownership and atomically compare/swap the
current revision. See [locking boundaries and rationale](locking.md).

Reads (`get`, `describe`, logs, status, validation, verification, secret listing,
config/backup exports) and plans take no operation reservation and persist no
revision/history. This includes source plans resolving image tags: Docker owns
its layer cache, and resolution uses the digest returned by that pull. Live
container observations may reflect an in-progress deployment.

Provider plans keep their separate local Terraform lock because they write
generated inputs and plan files. Backup-storage holds that lock before writing
its shared tfvars file, through the end of plan/apply, including dry runs.

The lock deliberately has no automatic expiry: a disconnected operator might
still have an in-flight deployment/provider request. Inspect it without taking
another lock or writing an operation log:

```bash
2server server lock
```

For scoped operations the result includes a `locks` array, each with its resource
keys and `lockId`; legacy/global locks retain the top-level `lockId`. Both include
creation time and the creating operator, machine,
PID and command for new locks. The PID belongs to the operator machine, not the
VM. Older locks may have no owner metadata. After checking that the original
operator/CI process and target operations have stopped, break that exact lock:

```bash
2server server unlock --lock-id <lockId>          # inspect only
2server server unlock --lock-id <lockId> --apply  # archive and release
```

Both commands discover the saved connection and accept `--ssh`, `--connection`,
or an explicit `-f server.json`. They work even before initial publication and
can recover an empty lock directory left by an interrupted acquisition. A changed
or released lock rejects an applied unlock; inspect again rather than reusing an
old ID. No age threshold silently authorizes a break.

Breaking a scoped lock releases only that reservation, retaining other active
reservations. Use the updated CLI to inspect/break scoped locks. Breaking a lock moves it into root-only `control/broken-locks/` with an audit of
who broke it and when. It does not cancel a running deployment, provider request,
or remove app/edge/local operator locks. It does not change the current control
snapshot. Updated CLI writers serialize acquire/release/break and snapshot commits
with a short kernel-managed mutex; a revoked writer cannot commit or release its
replacement's lock. The original operation must still be stopped before unlocking,
because external work already in flight cannot be revoked this way.

Do not bypass a held lock with local-manifest mode. Old revisions remain private
recovery points and can contain old secrets;
prune reviewed unused revisions explicitly after backup. Do not mix local `-f`
mutations with connected operations after migrating a server.

## Encrypted backup outside the VM

Install `age` and `age-keygen` on the operator machine. Generate a recovery identity
outside the repository and store it in your password manager/offline key store.
Keep its public recipient in a separate file; SSH recipients supported by age can
also be used. Losing the private identity makes the backup unrecoverable.

```bash
age-keygen -o /private/recovery.agekey
age-keygen -y /private/recovery.agekey > /private/recipients.txt
2server server backup --output .2server/server.age --recipient-file /private/recipients.txt
```

This is an explicit snapshot, not a scheduled database backup. Repeat after
configuration/secret changes; your CI can run it after successful deploys and
copy the encrypted artifact to private object storage. A file kept only on the
VM is not disaster recovery. `.2server/` is ignored by Git, so clone alone does
not restore it: sync the encrypted backup separately. Do not store its decryption
identity beside it. Backups contain config, env secrets, certificate pairs and
monitoring credentials, **not database data, Docker volumes, source, container
images, Terraform state or cloud login sessions**.

## Restore on a replacement VM

Keep the original Terraform state/tfvars in a separate durable backend/backup;
never bootstrap another Terraform root over live resources. Restore/create the VM
through that provider workflow, then review a replacement manifest (same server
name), updating SSH, public IP/provider identity and disk attachments for the new
VM. Ensure referenced images still exist in the registry.

```bash
2server server restore -f replacement.json --backup .2server/server.age \
  --backup-identity /private/recovery.agekey
2server server restore -f replacement.json --backup .2server/server.age \
  --backup-identity /private/recovery.agekey --apply
2server connect --connection replacement-ssh.json
2server setup --apply
# Restore database/volume backups before starting dependent apps.
2server extensions --apply
2server deploy --apply
2server domains --apply
2server verify
```

Restore is create-only and does not restart applications or publish DNS by itself.
Changing SSH must not accidentally preserve the old origin IP/VM/disk IDs. Existing
Caddy adoption also needs its original Caddy/Compose configuration restored; the
control snapshot does not invent a legacy deployment stack. Database recovery and
DNS cutover need their normal readiness/data checks. This is a configuration
recovery path, not a claim of full-server HA or automatic lossless recovery.
