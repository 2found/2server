# Install the 2server skill

The `2server` plugin packages one operating skill, its references and read-only
helpers. It uses the installed `2srv` CLI; it does not install the CLI, connect
to a VM or provision infrastructure during plugin installation.

## Prerequisites

Use Bun >= 1.3, Node >= 20 and a Claude Code/Codex release with plugin marketplace
support. Install the product separately:

```sh
npm install -g @2server/cli@latest
2srv help
```

Run infrastructure commands from the consuming project's repository. The skill
finds version-matched product docs through the installed launcher, so a source
checkout is not required. Copied skills work the same way. Standard npm/Bun bin
symlinks and `npm link` are supported; an unrelated custom shell wrapper is not
treated as a product package.

## Claude Code

After the catalog is published in `2found/2server`, run in a shell:

```sh
claude plugin marketplace add 2found/2server
claude plugin install 2server@2found-2server
claude plugin details 2server
```

In Claude Code, `/plugin marketplace add 2found/2server` and
`/plugin install 2server@2found-2server` provide the same installation flow.
Start a new session and invoke `/2server:2server`, or describe a 2server operation
for automatic skill selection. These instructions target Claude Code with local
shell access; installation in Claude's hosted surfaces does not supply a local
CLI or SSH access.

## Codex

```sh
codex plugin marketplace add 2found/2server
codex plugin add 2server@2found-2server
codex plugin list --marketplace 2found-2server
```

Start a new thread and select the 2server skill or invoke `$2server:2server`.
Codex namespaces the installed plugin skill as `2server:2server`. If a client has
marketplace browsing but no `plugin add` subcommand, add the source, then install
through its Plugins Directory. Confirm available commands with `codex plugin --help`.

To refresh a Git-backed source, use
`codex plugin marketplace upgrade 2found-2server`, then reinstall with
`codex plugin add 2server@2found-2server`. In Claude Code, use
`claude plugin marketplace update 2found-2server`, then
`claude plugin update 2server@2found-2server`. Restart the session after updates.

## Local verification before publication

Use the absolute checkout path instead of `2found/2server` in either marketplace
add command. This tests the working tree; it does not prove the hosted repository
contains those changes. Validate Claude's manifests first:

```sh
claude plugin validate ./skills --strict
claude plugin validate . --strict
```

For an isolated installation test, set `CLAUDE_CONFIG_DIR` and `CODEX_HOME` to
separate temporary directories. Add the local checkout, install the plugin and
check its skill inventory. Do not replace the user's existing settings to test a
catalog. Remove only the temporary directories when finished.

For a direct skill installation, copy `skills/2server/` into a supported skill
directory, such as `~/.agents/skills/2server/` for Codex or
`~/.claude/skills/2server/` for Claude Code. A standalone copy is invoked as
`$2server` in Codex or `/2server` in Claude Code. Keep the references and scripts beside
`SKILL.md`. Do not install both a copied skill and the plugin unless duplicate
discovery is intended.

## Distribution and official directories

The repository exposes two catalogs with the same marketplace and plugin IDs:

| Host | Catalog | Plugin manifest |
| --- | --- | --- |
| Claude Code | [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json) | [`skills/.claude-plugin/plugin.json`](../skills/.claude-plugin/plugin.json) |
| Codex | [`.agents/plugins/marketplace.json`](../.agents/plugins/marketplace.json) | [`skills/.codex-plugin/plugin.json`](../skills/.codex-plugin/plugin.json) |

Both point to `./skills` relative to the repository root. Only the skill bundle
is installed; product `src/`, `bin/`, private manifests and deployment state do
not belong to the plugin. Plugin version `0.1.1` is independent of npm's CLI
version. Keep both manifests' identities/versions aligned; increment the plugin
version when releasing skill changes so cached installations can update.

Adding a GitHub marketplace is separate from listing in an official directory:

- Claude Code: register this repo marketplace directly. Listing in Anthropic's
  directory requires its separate submission and acceptance process.
- ChatGPT/Codex: register this repo marketplace directly. Listing in the public
  Plugins Directory requires a developer submission, review and publication.
  A repository catalog is not evidence of approval. The compatibility manifest
  here is sufficient for repo installs; prepare the current portable package,
  listing icons and publisher metadata before public submission.

Official references: [Claude marketplace creation](https://code.claude.com/docs/en/plugin-marketplaces),
[Codex plugin packaging and marketplaces](https://developers.openai.com/plugins/build/plugins),
[OpenAI public submission](https://developers.openai.com/plugins/deploy/submission).
