# Changelog

## Unreleased

Release candidate; these entries describe the working tree, not the npm `latest`
package. CI selects the next version at publish time.

- Shorter README with a two-stage setup/deploy flow, named template Apps and
  focused links to operating/recovery contracts.
- Task-only `preDeploy.secrets` overrides, allowing a migration login separate
  from the running app's database login.
- Correct PostgreSQL pgBackRest configuration mount in generated releases.
- Explicit workload metadata access, host firewall reconciliation and scoped GCP
  workload IAM declarations. Existing workloads using cloud identity must review
  `cloud-metadata: allow` before applying setup.
- Package installation smoke checks, documentation link checks, Docker and mocked
  Terraform verification before publishing; release artifacts retained in CI.
- Research plan for portable storage, Cloudflare Workers and optional Soot operations.
  These integrations are not shipped capabilities.

Existing manifests remain compatibility inputs. New workflows use named App
files. Review [release checks](docs/release.md) and
[identity requirements](docs/operator-guide.md#applications) before upgrading.
