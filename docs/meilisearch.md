# Platform Meilisearch

Give this prompt to a coding agent in the repository owning your infrastructure:

```text
Read the installed 2server docs/meilisearch.md. Prepare a named platform-search
App from the meilisearch template on my existing connected VM. Keep installation
separate from Soot; show me the source manifest and exact operator commands.
Do not apply, start a service, provision a VM or print credential values.
```

Meilisearch is shared platform search infrastructure, like a shared Redis
service. Each product owns its indexes and restricted API keys. The template
has no Soot dependency, creates no data pools, and distributes no client keys.
It deploys Community Edition v1.54.3 in production mode with a persistent volume,
private credential files, bounded indexing resources and authenticated readiness.

## Install on an existing VM

Use a CLI build/release containing this template. The operator selects the VM
with the normal [connection workflow](control-state.md). Prepare a private env
file outside Git with `MEILISEARCH_MASTER_KEY` set to a random single-line value
of at least 32 characters. Do not pass the value in argv.

```sh
2srv init app platform-search --template meilisearch -o platform/search.yaml
2srv validate -f platform/search.yaml
2srv secret set --app platform-search --env-file /private/meili.env --apply
2srv plan -f platform/search.yaml
2srv deploy -f platform/search.yaml --apply
2srv app platform-search get
```

`init` and `validate` install nothing. `plan` may inspect the selected VM/image.
Only the operator's explicit `--apply` performs deployment. An example source:

```yaml
apiVersion: 2server.app/v1
kind: App
metadata: {name: platform-search}
template: meilisearch
spec:
  masterKeyEnv: MEILISEARCH_MASTER_KEY
  memoryMb: 1024
  indexingMemoryMb: 512
  cpus: 1
secrets:
  MEILISEARCH_MASTER_KEY: {provider: vm, key: MEILISEARCH_MASTER_KEY}
```

The default image is `getmeili/meilisearch:v1.54.3`; normal source deployment
resolves it to a digest. The data path defaults to
`/opt/2server/data/platform-search`. Each named instance has its own directory,
release files, container and secret namespace. We recommend one platform
instance, but the template supports multiple independent instances.
Indexing memory must be at most half the container memory; the remaining RAM
is needed for search and database overhead. Size for real documents and load;
1 GiB is a starting configuration, not a capacity promise.

The container runs as `65532:65532` with a read-only root, no capabilities and
`no-new-privileges`. Each deploy converts the data path to that user (the
`.2server-owner` marker stays root-owned) and makes the key-bearing config and
readiness files readable by it alone. Indexing temp files go to
`/meili_data/tmp`, not container memory.

## Internal clients and optional HTTPS

No host port is published. On the VM's 2server Docker network, bind a product's
endpoint from the selected instance:

```yaml
bindings:
  MEILISEARCH_URL: {extension: platform-search, output: endpoint}
```

The endpoint is `http://two-SERVER_NAME-platform-search:7700`. The template
publishes only that endpoint; the master key is not a binding output. The
operator creates product API keys with their own index/action restrictions using
the [Meilisearch keys API](https://www.meilisearch.com/docs/reference/api/keys).
Keep the master key for infrastructure administration only. For Soot, restrict
the service backend key to `soot_*` indexes and required document, search, task,
index and settings operations; the data-pool service enforces pool grants.
Other products use distinct index names and keys.

If the backend needs access from outside that Docker network, the operator can
add a separate HTTPS Domain. Substitute the actual server name and controlled
zone/hostname (the example server is named `example`); this is not a deployment target:

```yaml
apiVersion: 2server.app/v1
kind: Domain
metadata: {name: platform-search}
spec:
  zone: example.com
  hosts: [search.example.com]
  cache: app
  upstream: {kind: proxy, target: 'two-example-platform-search:7700'}
```

```sh
2srv validate -f platform/search-domain.yaml
2srv plan -f platform/search-domain.yaml
2srv deploy -f platform/search-domain.yaml --apply
```

Meilisearch Bearer authentication remains mandatory; `/health` alone is public.
Use normal firewall/private-network restrictions for the chosen backend access.
A health check is not proof of index permissions. Verify unauthenticated
`GET /indexes` is denied and a product key can access its indexes but not another
product's. Pass keys using a private curl config/header file, never command-line
values. The template also probes authenticated `/indexes` before committing a
release, without publishing its key or response.

## Connect Soot independently

Use the optional [Soot data-pool connector](https://github.com/2found/soot-forge/blob/main/packs/data-pool/README.md).
Its authoritative service stores pools in PostgreSQL 16+ (`pg_trgm` search),
not in Meilisearch, so run it against its own database and bind both hosts to
that service's HTTPS URL. The service owns grants, metadata and receipts;
giving two hosts the same Meilisearch address does not share a pool. Soot
clients receive per-Soot service tokens, never this master key. Installing or
removing the connector leaves platform Meilisearch untouched.

## Backup, upgrade and retirement

The template persists `/meili_data` including database, dumps and snapshots.
It does not create a backup scheduler or an automatic version migration.
Use the official [production guide](https://www.meilisearch.com/docs/resources/self_hosting/deployment/running_production)
and [dump/snapshot guidance](https://www.meilisearch.com/docs/learn/data_backup/snapshots)
for consistent backups and version-specific upgrades. For Soot, back up the
data-pool PostgreSQL database (`pg_dump`, or the stopped cluster directory)
separately from the Meilisearch snapshot. Back up private credentials separately.

Changing `dataPath` on an installed instance is rejected. Restarting or deleting
the named App retains its data. `2srv app platform-search delete --purge --apply`
removes it completely instead: the container, `/opt/2server/extensions/platform-search`,
the data path (only when its `.2server-owner` marker proves this instance owns
it), unused `getmeili/meilisearch` images, the instance lock and the app's VM
secrets. Delete or reroute its optional Domain first. Without `--apply` it only
prints the plan. See [extension purge](extensions.md#removing-an-app-completely)
for the checks and an audit snippet. Meilisearch is stateful: an old-image restart is
not a database downgrade or restore. Operator-requested retirement of the App
and its optional Domain are separate operations; retain data needed by consumers.
