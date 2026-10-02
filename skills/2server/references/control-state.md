# VM-owned configuration

Read `docs/control-state.md` in the product checkout for the exact supported
commands, storage layout and recovery boundaries.

- Shared state is always `/opt/2server/control/`, root-owned 0700/0600. Different
  SSH usernames work through authorized sudo. Never move it into a user home or
  mount it/its ancestors/Docker socket into an app. Docker administrators are
  root-equivalent; file permissions do not isolate secrets from them.
- Existing setup on machine A: publish the complete canonical manifest using
  `server publish -f ... --env-file ... --apply`. This migrates config, referenced
  secrets and portable certificate/monitoring state, without rolling workloads.
  It does not adopt undeclared legacy Compose applications.
- Machine B: `connect --ssh user@host [--identity ...]` or
  `connect --connection file.json`. The latter file is the structured `ssh`
  object for GCP IAP/direct SSH. The command validates access and writes only
  `.2server/connection.json` plus `.gitignore` in the current project. Never copy
  another machine's private-key path blindly. Select the consuming project as cwd.
- Subsequent commands need no manifest flag. Each fetches fresh authoritative
  state from the VM. An explicit connection overrides discovery; `-f` selects
  legacy local mode. Never use local mode to bypass a VM lock or missing secret.
- Use `server env --env-file secrets.env --apply` to update referenced values;
  supplying it on create/update also supports keys introduced by the new spec.
  Secrets are not printed. Missing Cloudflare keys must produce setup instructions
  for the exact variable, account/zone scope and the connected secret update command;
  do not ask for a token in chat. Reload affected resources after changing secrets.
- `deploy app NAME --image repository@sha256:... --apply` persists its desired
  digest. The connected release helper builds/pushes then calls this path.
  Preserve application-specific migrations and build requirements.
- `server backup --output .2server/server.age --recipient-file ...` needs age.
  Keep the decryption identity outside the project and back it up separately.
  `.2server/` is ignored, so a Git push is not a backup. Copy encrypted artifacts
  off the VM after config changes. These are not DB/volume or Terraform backups.
- Restore is create-only and needs a reviewed replacement manifest with the same
  server name and corrected SSH, origin/provider IDs and disks. It publishes only
  control state. Restore application data and original legacy Caddy configuration
  before cutover. Never infer full-server recovery from a config restore.
- If synchronization fails, retain the reported private recovery directory.
  Do not blindly rerun deployments or remove a lock before proving the prior
  operator/CI request has stopped. Old revisions contain old secrets; review and
  prune them explicitly after backup. Root access can read VM secrets.

Provider provisioning, power operations, disk/bucket changes and Terraform state
retain their separate provider workflow; a stopped/lost VM cannot be the only
place needed to recover it. Explicit cloud Secret Manager references still need
provider identity. Env-based app secrets require only authorized VM access.
