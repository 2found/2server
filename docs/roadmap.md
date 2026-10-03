# Next direction: portable storage, edge apps and Soot

Research and proposal, 2026-10-03. **None of the proposed template names, manifest
fields or APIs below are supported by this release.** Current source, shipped CLI
help and installed-template commands remain the operating contract.

The goal is a small deployment tool with optional capabilities: the same named
App workflow on a VM or, eventually, an edge runtime. Keep application data access
in a small reusable library and operations intelligence in Soot. Do not turn the
core CLI into an object-storage SDK or an agent framework.

## Current evidence

| Area | Implemented now | Gap |
| --- | --- | --- |
| Apps | Source App files, named templates, bindings, VM secrets, deployment locks/history | Source dispatch and extension lifecycle assume a VM connection |
| Cloudflare | DNS, certificates, Caddy routes and cache rules | No Workers runtime, account-level app ownership or Worker deployment history |
| Storage | VM data disks; PostgreSQL pgBackRest/GCS backup | No app-facing object API or portable object reference |
| Monitoring | Workload discovery, service metrics, named Discord receivers | Generic authenticated Alertmanager receiver for Soot is missing |
| Soot | Go daemon, durable cases, senses, fixed operations, takeover and Alertmanager intake | Not an installed 2server template; production retention, identity and reconciliation need work |

Soot was inspected at `<kiem-lai-repo>/soot`: `README.md`, `docs/2server.md`,
`docs/architecture.md`, `internal/modules/operations/execute.go`, and
`internal/storage/store.go`. Its local `go.mod` replaces AgentRay with a sibling
checkout. A published template must consume a versioned, reproducible Soot binary
or image, not assume that checkout layout. A separate resident pilot is in
progress in that repository; this research does not claim a live rollout.

The consuming Lohi code also shows the migration boundary: `api` TTS/community
storage and `tts-api` signing use GCS directly, while audio/image proxies recognize
GCS hosts and bucket paths. Replacing the provider therefore requires a one-time
app adapter integration and compatibility reader for stored URLs. A new 2server
setting cannot transparently rewrite already shipped application code.
The compatibility reader must accept only explicitly owned bucket/host mappings;
never turn a stored arbitrary URL into a privileged server-side fetch.

## Recommended order

| Stage | Deliverable | Exit evidence |
| --- | --- | --- |
| 0 — release baseline | Current VM workflow, documented identity/backup boundaries and tested npm package | Artifact install, runtime tests, staging bootstrap/deploy/recovery |
| 1 — storage API | Small backend-neutral library; native GCS and S3/R2 adapters; logical object references | Same conformance tests on three private provider buckets; one real app integrated |
| 2 — Soot observation | Named optional resident template, durable state and authenticated monitoring feed | Restart preserves cases; duplicate alert deduplicates; no unauthorized mutation |
| 3 — edge runtime | Workers App adapter using versioned Wrangler; existing R2 binding | Upload → test → activate → rollback with exact account/name/env ownership |
| 4 — controlled automation | Soot operation reconciliation and resumable storage transfer | Interrupted repair/copy is reconciled, never blindly repeated; checked recovery |

Storage and Soot observation can be developed independently after the release.
Workers follows once provider ownership/credentials and storage bindings are clear.
This order puts the existing VM users first and provides a concrete object-storage
use case for the edge adapter. Defer multi-cloud scheduling, general plugin loading,
a full S3 gateway and autonomous database repairs.

## Storage: one app API, multiple backends

### Choose native adapters behind a narrow contract

Use native GCS authentication/API and an S3 adapter shared by AWS S3 and R2 with
explicit provider profiles. GCS has an XML interoperability path for some S3 tools,
but using it requires HMAC credentials; it is not a reason to discard the existing
workload identity integration. [GCS interoperability](https://docs.cloud.google.com/storage/docs/interoperability),
[GCS signing](https://docs.cloud.google.com/storage/docs/authentication/signatures).

R2 has an S3-compatible API with a documented operation/feature matrix; compatibility
must be tested per capability, not inferred from an endpoint setting. Use the
Workers R2 binding adapter when running inside Workers, where the native interface
differs from S3. [R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/),
[R2 Worker bindings](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).

Proposed package boundary: a separate `@2server/storage` workspace/package. It must
not import the deployment CLI, SSH, Zod's full config graph or VM secrets. Start with
Bun/Node server applications, since those are actual consumers. Add a Worker entry
point with no Node-only imports when the edge adapter lands; defer other SDK languages
until there is a consumer. Use explicit backend imports so an S3 user need not load GCS.

Proposed API, illustrative rather than executable:

```ts
type ObjectRef = { store: string; location: string; key: string };
// location is an immutable backend configuration revision, not a public URL.
// Transport-specific options stay inside each adapter.
interface ObjectStore {
  put(input: Upload): Promise<ObjectRef>; // streaming body, size/type/checksum
  get(ref: ObjectRef, options?: ReadOptions): Promise<Download>; // stream + range
  head(ref: ObjectRef): Promise<ObjectMetadata>;
  delete(ref: ObjectRef, condition?: Revision): Promise<void>;
  list(options: ListOptions): Promise<ObjectPage>; // opaque cursor, bounded page
  sign(ref: ObjectRef, options: SignOptions): Promise<SignedRequest>;
}
```

Keep multipart/resumable machinery behind streaming upload. `SignedRequest`
includes method, required headers and expiry, not only a URL. Normalize not-found,
permission, precondition, unsupported capability, throttling and transient failures.
Do not log credentials or signed query strings. `get` must support byte ranges for
audio; preserve content type, length, disposition and cache policy. Validate tenant
prefixes at the app authorization boundary; a caller cannot select arbitrary buckets.

Expose provider revision as an opaque token. GCS generation conditions and S3 ETag
conditions are different; support create-only and compare-and-set where the adapter
can enforce them atomically. Never implement conditional writes as HEAD followed
by an unconditional PUT. ETag is not a portable checksum. Use an explicit checksum
manifest when verifying transferred content. [GCS preconditions](https://docs.cloud.google.com/storage/docs/request-preconditions),
[S3 conditional requests](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-requests.html).

A capability descriptor reports signing, conditional writes, multipart/resumable
upload and retention/versioning support. Unsupported requests fail explicitly;
provider-native IAM, retention locks and lifecycle rules are not silently emulated.
Bucket policy/provisioning belongs to the template's control adapter, not this SDK.

### What “without migrating” can mean

1. **No repeated application rewrite:** integrate the common API once. Subsequent
   backend choices change configuration/bindings, not provider-specific call sites.
2. **No bulk move required for cutover:** retain old backend locations for reads,
   set the new backend as the write destination, and persist the returned location
   in each new object reference. Existing data remains readable where it lives.
3. **No permanent provider dependency:** this still requires copying old bytes,
   validating them and retiring the old backend. Transfer time, storage duplication
   and egress costs remain; the tool can automate work, not eliminate it.

For new data use immutable keys/object references. The app's existing database
keeps the current reference when a logical asset changes, using its normal
transaction/compare-and-set behavior. Keep every referenced backend revision in
configuration; reject removal while references or pending transfers depend on it.
Do not read-fallback on every 404: deleted objects can otherwise reappear from an
old bucket. Mutable legacy paths require a location index and durable deletion
markers; start with immutable object adoption before adding that complexity.

A future transfer records source revision, target reference, content checksum and
copy state per object. Resume idempotently, verify before atomically updating the
app's location index, and refuse stale source revisions. Concurrent writes and
deletes must be captured or quiesced during the final reconciliation. Keep source
objects for a documented recovery window; deleting them is a separate explicit
operation. Cloud objects do not support a cross-provider transaction.

A stable media domain can hide provider URLs for public delivery. Private access
must still pass app authorization and be signed on demand. R2 S3 presigned URLs use
its S3 endpoint, not a custom domain; retaining a custom private URL needs an
authenticated proxy/Worker or app endpoint. Avoid proxying every large upload through
the VM merely to hide URLs. Existing signed URLs expire naturally; they are not
portable database identifiers. [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).

### Fit it into 2server without command growth

A proposed `storage` template is a named App holding backend profiles, bucket
ownership/adoption policy and bindings. Begin with **existing buckets**: verify
identity/access, never create, empty or change lifecycle rules implicitly. Later
provisioning is an explicit reviewed plan. Store only secret references in source;
use scoped identities where available. Avoid granting apps bucket-admin rights.
VM metadata access remains explicit and shared; GCS permission is not per-app isolation.

Use existing init/deploy/secret/app commands. Add `app NAME check` and, only when
transfer exists, `app NAME transfer` under the installed template's own CLI. The
library performs normal object I/O; do not create core `s3`, `gcs`, `r2`, `upload`
or `download` command families. Bucket retirement and app retirement are distinct.
Backup repositories keep their pgBackRest ownership/retention contract; do not
route database backups through an immature application-storage adapter.

Conformance gates: stream large files within bounded memory; range/empty/unicode
objects; metadata; bounded pagination; expired signing; incorrect credentials;
concurrent conditional writes; multipart cancellation; old-location reads; deleted
object non-resurrection; restart halfway through a copy. Run provider checks with
unique owned prefixes and delete only fixture objects. Mocks are useful for failures
but do not prove provider compatibility or IAM.

## Cloudflare Workers as another App runtime

Keep `init app NAME`, `plan`, `deploy` and `app NAME logs|rollback|help`. A proposed
`cloudflare-worker` template owns account, environment, Worker name, artifact and
resource bindings. Its adapter uses a pinned, project-local Wrangler version; never
install Wrangler globally or expose every Wrangler verb through core CLI. Treat
Wrangler as the bundling/deployment tool and retain native escape hatches in the
consuming project. [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/).

Current dispatch opens a VM session before inspecting the workload. To support
edge-only apps, add a small target dispatch boundary before `connectedCommand`:
VM applications retain current locking/state; Cloudflare operations select explicit
account/app ownership. Do not require a dummy VM. The provider is authoritative for
live versions/deployments; Git owns source intent. Cloud account credentials belong
to operator/CI secret storage; Worker runtime secrets belong to Cloudflare. The
existing `provider: vm` contract cannot represent edge-only secrets unchanged:
introduce explicit secret-provider validation for this target, with no local
plaintext fallback or replication into a fictitious VM snapshot.

Suggested release path: validate account/name/environment and required bindings →
build/dry-run locally → upload a version → smoke its version URL → activate that
exact version → verify public route. Record artifact hash, compatibility date,
Wrangler version and Cloudflare version/deployment IDs. Initially activate at 100%;
gradual traffic is optional later. Workers versions track code/config, not data in
R2, KV, D1 or Durable Objects, so rollback cannot undo those writes.
[Versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/).

Secret updates must follow that same release boundary: ordinary `wrangler secret
put` creates and deploys a version immediately. Use the version-aware API/workflow
to avoid accidental activation while preparing a candidate. Keep values out of
source/build logs and verify required secret names before release.
[Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

Own Worker routes/custom domains separately from Caddy origins: they do not need
an origin IP or Origin CA certificate. Detect collisions with VM-owned domains;
require explicit adoption instead of overwriting routes. Limit the first version
to HTTP Workers and existing R2 bindings. Cron, queues, Durable Objects migrations,
D1 and broad framework adapters can wait for specific users.

A Worker cannot inherit the VM's private `edge` Docker network. Storage via provider
APIs is straightforward; a VM database needs an explicit authenticated network/API
path. Do not publish PostgreSQL to the internet as an automatic binding side effect.

Acceptance: wrong account denied, missing binding rejected, failed smoke leaves
current traffic unchanged, route ownership conflict refused, rollback restores the
chosen version, and concurrent deploys cannot silently overwrite ownership/history.
Provider API partial failures require reconciliation; they are not a transaction
with local files or VM state.

## Soot: an optional resident operator

Ship as an optional named `soot` template. Roles, tools, skills and allowed repairs
remain Soot pack configuration. The 2server extension owns binary/image installation,
service lifecycle, data/secret paths, probes, backup and monitoring integration;
it does not implement agents or import AgentRay's server.

Soot's current state store assumes one process per directory. Generic App volumes
are per-generation, so a normal blue/green deploy cannot maintain one continuous
case history. Prefer a dedicated systemd lifecycle initially, matching Soot's own
recipe: unprivileged service identity, private state directory, stop/start upgrade
with a short pause, locked exclusive store, health check before success. A future
container lifecycle can work if it enforces the same singleton persistent mount.
Do not allow two generations to write the store. Data-format upgrades need a
backup/restore contract; binary rollback is not automatically data rollback.

The first template release should be observation-only: configured readiness senses,
redacted inspection outputs and human handoff. Use the monitoring extension's existing
discovery to supply app identities/targets, not a second independent Docker discovery
system. No Docker socket, root control snapshot or unrestricted sudo for the daemon.
For privileged inspection, expose narrow read-only results through an audited bridge.
Keep case/model/API secrets in the named app's namespace and service-readable private
files; do not dump the full VM environment into the pack or model context.

Monitoring must gain a generic HTTPS/private-local webhook receiver with a bearer
secret reference and `send_resolved`, rendered inside its own extension. Soot already
accepts `/hooks/alertmanager`; container loopback is not the VM host. Define reachable
addresses and private credentials explicitly, reject redirects, then test unauthorized
requests and duplicate firing/resolved groups. Do not patch generated Alertmanager
files by hand or misuse a Discord receiver for this integration.

For repair, the current executor accepts fixed argv, journals intent, claims a
resource, checks readiness and blocks uncertain outcomes. Its 15-second limit is
shorter than many 2server operations. Killing SSH can leave the remote rollout
running. Before granting deploy/restart authority, add an operation-ID/status
reconciliation adapter that proves completion or fences the resource for a human.
Reuse 2server's operation locks; Soot's local case lock alone cannot exclude a human
CLI session. Destructive DB restores, IAM changes and secret rotation stay outside
initial unattended runbooks.

Production gates: retention/closure before the bounded store fills; daemon readiness
that reflects storage/sense failures; bounded model cost and concurrency; takeover
cancels/fences in-flight actions; crash after journal-before-result does not rerun a
repair; restore preserves cases/ownership; untrusted alert text cannot select argv;
real model and real authenticated alert delivery checked separately from scripted
fixtures. A monitor outside the VM still owns whole-VM failure detection.

Keep custom commands minimal: only add a Soot-specific case/action inspection verb
if generic get/logs and Soot's API cannot serve it. Agent guidance belongs in Soot
packs and a focused 2server skill reference once this template actually ships.

## Decisions to make during implementation

- Pick the first real storage consumer and immutable asset class; integrate it
  before designing a universal gateway or copying production data.
- Fix the source and retention policy for storage location metadata. It should
  live with the app's object ownership records, not in operator CLI history.
- Publish reproducible Soot artifacts and stabilize their state-format contract.
- Choose a Worker provider-secret reference and ownership store that works from
  another machine without adding a central 2server daemon.

These are implementation decisions and acceptance criteria, not reasons to grow
core CLI help now. Each stage should ship only after its failure/recovery cases are
proved and its docs distinguish local fixtures from live evidence.
