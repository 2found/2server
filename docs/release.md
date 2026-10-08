# Release runbook

Release `@2server/cli` from `2found/2server`. Verify the registry before
announcing a version. `package.json` is the version source; CI publishes exactly
that version under the matching immutable Git tag. Both `2srv` and its `2server`
alias must work in the installed artifact. Follow [BRANDING.md](../BRANDING.md) for public release copy.

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

The [Publish CLI workflow](https://github.com/2found/2server/blob/main/.github/workflows/publish.yml)
checks pull requests and pushes to `main`. A new stable version in `package.json`
is the release intent; ordinary pushes with an existing tag do not publish.
There is no CI-only auto-increment: source, tag and npm artifact share one version.

1. Verify runs typecheck, unit/failure tests, Docker integration, Terraform mock
   tests/formatting, docs links, pack inspection and installed-package smoke tests.
2. CI validates version/tag identity and rejects downgrade, then creates
   `v<version>` on the verified commit. A manual matching tag uses the same path.
3. Distribution checks npm for the exact version before packing. If that version
   came from this commit, a partial-run retry skips npm publication. If it belongs
   to another commit, or source is behind npm, bump `package.json`; CI fails rather
   than inventing another number. The transition starts at `0.2.15`, above the
   registry's `0.2.14` observed when this flow was introduced.
4. CI smoke-tests the exact tarball, stages a draft GitHub Release with that
   tarball, a docs archive, `release.json`, `DOWNLOADS.md` and `checksums.txt`,
   publishes npm with provenance, then publishes the complete GitHub Release.
   Its body is the download page, and docs links point at the same version tag.

Tagging and distribution share one workflow dependency graph: a tag created by
`GITHUB_TOKEN` does not start a second workflow. Releases are serialized. Rerun
failed jobs or dispatch `publish.yml` with an existing tag to resume an unpublished
release. Published versions/assets and tags are immutable; fixes require a bump.
2server ships the npm CLI and its operating skill; it has no native desktop app.

The 2found website release-sync workflow consumes published releases, pins docs
to their source tag, builds/verifies the snapshot and updates the static site.
Unpublished/draft versions are never advertised. Its schedule also repairs a
missed notification; website updates do not mint a new product version.

The workflow uses repository secret `NPM_TOKEN`, with permission to publish this
package under the account's npm policy. Check its scope/expiry privately; never
print it or distribute it with operator configuration.

A subsequent improvement is [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/):
configure package trust for `2found/2server`, workflow `publish.yml`, on GitHub-hosted
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

The 2found website consumes published release catalogs hourly. Optional secret
`WEBSITE_DISPATCH_TOKEN`, scoped only to dispatch `2found/2found.dev`, triggers an
immediate refresh. A notification failure does not undo the product release;
the scheduled consumer repairs missed refreshes. Never store that token in source.
