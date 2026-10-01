# Resource CLI and stateful extensions

## Goal
Add Docker/kubectl-style resource operations to the single-VM product, plus
PostgreSQL backup/restore, provider disk growth, persistent Redis, and NATS.

## Approach
Reuse config validation, provider SSH, secret resolution, uploads, edge locks,
Cloudflare ownership, blue/green app health checks and Terraform roots. Add a
resource command dispatcher without breaking the original CLI. Manifest edits
are atomic and happen only after successful operations. All mutations retain
the --apply dry-run boundary. Stateful extensions have separate Compose projects,
private configuration, bounded resources and explicit removal retaining data.
Use existing GCS/S3 buckets and VM identity for backups; never distribute cloud
keys to containers. Restore into a new database, never overwrite a live database.
Use attached provider disks and grow ext4/XFS without formatting existing data.

## Work units
- [x] Resource contract, parsing and app replica lifecycle
- [x] Domain retirement, VM lifecycle, basic monitoring and disk operations
- [x] PostgreSQL/Redis/NATS deployment and backup/restore
- [x] Failure tests and real Docker integration
- [x] CLI documentation, examples and skill updates

## Deviations
- **Task tracking** — No plan or ticket was supplied and TaskCreate is unavailable
  in this environment. This plan records verifiable work units and their status.
- **Redis mode** — The request permits simple Redis or Sentinel. Use authenticated
  single-node Redis with AOF; a single VM cannot provide host-level Sentinel HA.

- **Provider verification** — Runtime tests use local Docker and mocked cloud
  boundaries. No request to deploy these new services or resize production was
  made; live provider verification remains a staging operation.
- **Terraform test compatibility** — System Terraform is 1.6. Mock-provider tests
  need 1.7+, so `scripts/test-terraform.sh` runs isolated copies and accepts
  `TERRAFORM_BIN`; production roots retain 1.6 compatibility.

## Verification
- TypeScript check passed; 43 non-Docker tests passed (42 in the full run plus
  the subsequently added protected-destroy test in the focused resource run).
- Four real Docker integration cases passed: Caddy routing/rollback, existing
  Caddy adoption, Prometheus readiness/auth boundaries, and PostgreSQL/Redis/NATS.
- Stateful integration proved password rejection, persistence after restart,
  NATS Core and JetStream, real PostgreSQL dump/restore, existing-target refusal,
  and checksum rejection before database creation. Object storage was substituted
  with a local transport; no production bucket was accessed.
- GCP/AWS Terraform validate passed. Four mock-provider plan tests passed with
  isolated Terraform 1.9.8; the system Terraform 1.6 remains unchanged.
- Skill validation, example manifest validation, CLI help and diff whitespace
  checks passed. No production deployment, commit or push was performed.

## Remaining operational validation
Live bucket IAM/transfers and attached-volume growth require a staging VM in
the target provider account. Redis is standalone; all extensions are single-VM.
VM destruction keeps provider protection enabled by default, refuses a protected
destroy before applying any resources, and cannot destroy protected data disks.
