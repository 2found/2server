# Changelog

## Unreleased

Release candidate; these entries describe the working tree, not the npm `latest`
package. CI selects the next version at publish time.

- Named native `soot` template separates pinned Linux runtime code from reviewed
  offline C1 source. Private plan artifacts bind VM/control/source/receipt and C3
  revisions; initialization and replacement need exact explicit review. Runtime
  guards retain edits, store/vault identity and acknowledged history. Specialized
  stop/join, host readiness and guarded restore preserve single-owner bbolt
  lifecycle; no live database copy or automatic source reseeding. Operator docs,
  examples, skill and isolated Linux/TLS checks distinguish local verification
  from registry/public-DNS/VM acceptance.

- Cloudflare token setup distinguishes Account and Zone permissions and resource
  scope for public domains, WAF, email, Workers and D1. Mail MX replacement needs
  DNS Edit. Worker plans check zone/account identity before provider mutations;
  upload/custom-domain failures report actionable rights without response bodies.
  Permission errors link to the maintained token guide rather than a removed
  README section. Optional account mail diagnostics name their own account right.

- Repository marketplaces for Claude Code and Codex distribute the same operating
  skill from `skills/`, independently versioned from the npm CLI. Installed/copy-only
  skills resolve the operator's CLI package rather than importing a sibling source
  checkout; source operations run from the consuming project. Focused references
  distinguish named app secrets from legacy whole-server setup.

- 2found product branding in `BRANDING.md`, linked from contributor and operating
  guidance. README/docs prefer `2srv`; the installed command shares the existing
  launcher with the retained `2server` alias. Package and state identities stay stable.
- Canonical CLI architecture guide in `docs/ARCHITECT-CLI.md`, covering command
  routing, module ownership, config/credentials and plan/apply lifecycle. Contributor,
  development and skill references use it; the old architecture URL remains a pointer.
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

- README organized around connect/bootstrap, validate/plan/deploy, command
  discovery and agent onboarding, with a task-based docs index. Operating docs
  remove duplicated contracts and dated evidence; speculative designs are
  summarized in the roadmap. Consuming-project implementation logs live outside
  the product repository.
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
