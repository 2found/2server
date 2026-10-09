# Development and verification

Use Bun >= 1.3 and Node >= 20. Install with `bun install --frozen-lockfile`;
run the source CLI with `bun src/cli.ts`. See [CLI architecture](ARCHITECT-CLI.md)
for module ownership and [release](release.md) for artifact verification.

## Checks

```bash
bun run check
DOCKER_TESTS=1 bun run check # Caddy routing/recovery and Prometheus startup/security
TERRAFORM_TESTS=1 bun test tests/provision.test.ts # local built-in Terraform provider
terraform -chdir=terraform/gcp init -backend=false
terraform -chdir=terraform/gcp validate
terraform -chdir=terraform/aws init -backend=false
terraform -chdir=terraform/aws validate
terraform fmt -check -recursive terraform
```

Docker runtime tests need Docker, Compose, `jq` and `flock`; macOS also needs GNU `gmv`.
Cloudflare interactions use HTTP mocks; no live DNS, billing, SSH, cloud VM or
OAuth change is performed by these tests. Before a production rollout, verify
the workload's declared readiness, public HTTPS/authentication where applicable,
data persistence and relevant backup/restore or provider behavior.
Fresh-VM bootstrap, live provider permissions and DNS propagation require a staging rollout.


For Terraform mock-provider tests, use Terraform >= 1.7 (1.9.8 verified):

```bash
TERRAFORM_BIN=terraform scripts/test-terraform.sh
```

The temporary roots use mocked providers and create no cloud resources. Docker
checks use isolated local resources; PostgreSQL tests exercise real recovery with
local substitutes for cloud object transfers. Live IAM and disk resizing need a
staging check. Do not point test fixtures at a production manifest.

The repository's [AGENTS.md](../AGENTS.md) is self-contained contributor guidance.
Architecture tests prohibit importing template implementations outside explicit
composition and importing sibling template behavior. Contribution tests cover
bound instances, shared alerts/diagnostics, backup IAM intent and portable state
allowlists, including legacy paths and traversal/symlink rejection. See the
[extension compatibility boundaries](extension-boundaries.md).

## Soot isolated checks

Run `bun test tests/soot-template.test.ts tests/soot-deployment.test.ts` for offline
C1/receipt, isolation and source-plan races. After obtaining the exact local
afb1e0d image, run `DOCKER_TESTS=1 SOOT_RUNTIME_IMAGE=VERIFIED_LOCAL_IMAGE bun test
tests/soot-runtime.test.ts`. The fixture verifies the mounted producer receipt,
C3 source transactions, edit conflicts, restart/guarded restore, retained owner-API
history and HTTPS with a local trusted certificate. It uses disposable loopback
containers and never publishes a registry image or copies live databases.
[Soot's verification boundaries](soot.md#verification-boundaries) distinguish
these checks from public DNS, registry availability and a staging VM rollout.
