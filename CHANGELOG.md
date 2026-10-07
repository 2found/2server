# Changelog

## Unreleased

Release candidate; these entries describe the working tree, not the npm `latest`
package. CI selects the next version at publish time.

- Independent repository contributor guidance in `AGENTS.md`, with enforced
  template boundaries and documented compatibility exceptions. Native summary,
  diagnostic, alert, backup permission and portable-state contributions replace
  monitoring/PostgreSQL behavior in core while retaining legacy identities.
- External extension runtimes now own their schemas and source hooks beside
  their templates. Email Routing and Workers share generic source dispatch and
  VM lifecycle guards; new runtimes require only an explicit adapter registration.
- `email-routing` App template for Cloudflare Free inbound forwarding: scoped
  API credentials (local or read from VM control state), destination verification,
  conflict checks for mail DNS and foreign rules, idempotent owned-rule updates
  and live readiness verification. Explicit opt-ins allow exact obsolete MX
  replacement and permission additions to existing exact-zone token policies.
  A separate account-pinned opt-in creates a minimum-rights policy for one new zone.
  No outbound SMTP or mailbox is provisioned.

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
- `runtime.engine: worker` App definitions and the `url-shortener` template: a
  Cloudflare Worker with a D1 database and a custom hostname, deployed from the
  same `plan`/`deploy -f FILE --apply` workflow without a VM session. The VM
  extension engine skips worker apps, and retirement stays explicit in Cloudflare.
- Research plan for portable object storage and optional Soot operations. These
  integrations are not shipped capabilities.

Existing manifests remain compatibility inputs. New workflows use named App
files. Review [release checks](docs/release.md) and
[identity requirements](docs/operator-guide.md#applications) before upgrading.
