# Development and verification

Use Bun >= 1.3 and Node >= 20. Install with `bun install --frozen-lockfile`;
run the source CLI with `bun src/cli.ts`. See [architecture](architecture.md)
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
public HTTPS/sign-in and actual image/audio MISS→HIT plus range/error cases.
Fresh-VM bootstrap, live provider permissions and DNS propagation require a staging rollout.


For Terraform mock-provider tests, use Terraform >= 1.7 (1.9.8 verified):

```bash
TERRAFORM_BIN=terraform scripts/test-terraform.sh
```

The temporary roots use mocked providers and create no cloud resources. Docker
checks use isolated local resources; PostgreSQL tests exercise real recovery with
local substitutes for cloud object transfers. Live IAM and disk resizing need a
staging check. Do not point test fixtures at a production manifest.
