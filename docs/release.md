# Release runbook

This checkout prepares the next `@2server/cli` release. Registry `latest` was
`0.2.4` when inspected on 2026-10-03; the source version remains `0.2.0` because
CI chooses a registry-safe version without committing a version bump.
Check the registry again before announcing a release.

## Local candidate

```sh
bun install --frozen-lockfile
bun run release:check
```

The command typechecks/tests, checks local Markdown file links, packs the npm
allowlist into ignored `.release/`, inspects package contents, and installs that
exact tarball in a temporary project. It exercises the installed executable,
offline bootstrap, all shipped template schemas, duplicate-file refusal, invalid
schema and unknown-template rejection. It does not publish, SSH, provision or
change production; npm installation downloads public dependencies.

For runtime/provider changes, also run:

```sh
DOCKER_TESTS=1 bun run check
TERRAFORM_TESTS=1 bun test tests/provision.test.ts
TERRAFORM_BIN=terraform scripts/test-terraform.sh
terraform fmt -check -recursive terraform
```

Use Terraform >= 1.7 for mocked-provider tests (CI pins 1.9.8). Docker checks need
Docker Compose, jq and flock; macOS also needs GNU gmv. See
[development prerequisites and limits](development.md). Mock cloud transfers do
not prove bucket IAM or live provider permissions.

## Publish path

The [Publish CLI workflow](https://github.com/lohi-ai/2server/blob/main/.github/workflows/publish.yml)
checks pull requests and pushes to `main`. Only `main` publishes, including manual
dispatch. **Pushing to main is a release**, not a draft operation.

1. Verify runs typecheck, unit/failure tests, Docker integration, Terraform mock
   tests/formatting, docs links, pack inspection and installed-package smoke tests.
2. Publish queries npm. It skips the current commit if already published;
   otherwise it uses the higher of the source version and the next registry patch.
   Deliberate minor/major bumps in `package.json` are respected.
3. CI packs and smoke-tests the final version again, retains the exact tarball and
   integrity metadata as a 30-day Actions artifact, then publishes that tarball
   with provenance. Publishing is serialized for `main`.

Repository secret `NPM_TOKEN` was present at inspection. Its existence does not
prove current scope/expiry. It needs permission to publish this package under the
account's npm policy. Never print it, check it into source or distribute it with
operator configuration. The existing token-based path is retained for this release.

A subsequent improvement is [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/):
configure package trust for `lohi-ai/2server`, workflow `publish.yml`, on GitHub-hosted
runners, then upgrade the workflow to npm >= 11.5.1 and Node >= 22.14.0. Verify an
OIDC publish before removing the existing token. `id-token: write` alone does not
configure package trust. This preparation does not modify npm account settings.

After publishing, inspect the successful run and
`npm view @2server/cli version dist.integrity dist.attestations --json`, then install the published version in
an isolated project and run its help/init/validate flow. Announce only the version
actually published. Revert a bad code release with a new patch; do not assume
unpublishing or moving a dist-tag repairs users' existing installations.

## Upgrade and live acceptance

The [unreleased changelog](../CHANGELOG.md) covers current changes. In particular,
review cloud identity requirements before applying setup: bridge workloads that
need VM metadata must declare `spec.labels.cloud-metadata: allow`. That grants the
VM identity, not per-app isolation. See [the operator guide](operator-guide.md#applications).
Keep migration-only credentials in `preDeploy.secrets`; do not move them into
runtime secrets as a workaround for an older CLI.

On an isolated staging VM, record the exact artifact/digest and verify:

- Empty VM bootstrap, connect from another machine, install a named template,
  deploy an app with a domain, and repeat an unchanged deploy.
- Missing secret, unhealthy candidate and conflicting DNS fail with the current
  app still reachable where the operation contract guarantees it.
- Runtime identity access is denied by default and works only when explicitly
  allowed; intended registry/object-store operations succeed with scoped IAM.
- Public HTTPS, authenticated and unauthenticated cases; monitoring discovers the
  app; an authorized notification test arrives at its intended destination.
- Database backup and an isolated restore with real provider storage; encrypted
  control backup is recoverable using an age identity kept off the VM.

Local integration success is not evidence that this staging sequence ran. Keep
operator manifests, credentials and QA evidence in the consuming repository or a
private directory, outside the generic npm package.

## License

`package.json` currently declares `UNLICENSED`. No open-source grant is inferred
from public source/npm distribution. The owner must choose any change of license;
then add the actual license text and update package metadata before announcing
an open-source release. Until that decision, keep the current declaration.

## Preparation evidence — 2026-10-03

- Default typecheck/unit suite: 158 passed, 19 opt-in integration tests skipped,
  zero failures, including on Bun 1.3.0 (CI's minimum). Installed-tarball smoke
  passed on Node 20 + Bun 1.3.0, with 143 public package files. The package gate
  rejects private artifacts and requires all runtime source/assets; it does not
  constitute a full content-based secret scan.
- Docker integration initially found four stale metric assertions: Redis/NATS
  metrics now carry `app` labels. The assertions were corrected, and the entire
  affected real stateful-services test passed on rerun. The other 173 tests passed
  in the full run; its one skipped Terraform state test passed separately.
- Terraform 1.9.8 mock-provider suites: GCP 7, AWS 2, GCS backup 3 passed;
  formatting passed. Local built-in-provider provisioning checks: 5 passed.
- Bun dependency audit: no reported vulnerabilities. Skill frontmatter validation,
  Markdown file links and `git diff --check` passed.
- Existing repository secret name and recent successful publish runs were checked
  read-only; no token value was read or changed. No new staging VM, live cloud
  mutation, commit/push or npm publish was performed for this preparation.

Account settings, live staging acceptance and the final publish remain separate
from local preparation. A previous production migration is not a substitute for
fresh-VM acceptance of this full working-tree candidate.
