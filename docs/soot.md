# Soot on an owned VM

Deploy a pinned Linux Soot runtime and an independently reviewed C1 config bundle
as a named app. The runtime owns validation, source transactions, activation,
deployment acknowledgments and config rollback. 2server stages verified inputs
and supervises the process through the native `sourceDeployment` capability.
It does not rebuild Soot, fetch packs, infer a singleton or copy live databases.

The [example](../examples/soot/app.yaml) uses placeholder registry and DNS names.
Its receipt describes runtime commit `afb1e0d568071d59fe7d4ff7e3cf88e872915b4d`,
version `0.1.0-ac-config-review`, Linux amd64, and OCI manifest
`sha256:35c9af6ab29b4ffea7374a1233b677afef1a79188b8188eba1d0642451f24f23`.
That local producer receipt does not establish registry availability. The example
AI policy is unconfigured; choose a real provider/model and credentials before
source activation, then review the bundle digest with the producer's tooling.
No example is an authorized deployment target.

## Source and mount contract

```sh
2srv init app assistant --template soot -o platform/assistant.yaml
2srv validate -f platform/assistant.yaml
2srv secret set --app assistant --env-file /private/assistant.env --apply
2srv plan -f platform/assistant.yaml --plan-output /private/assistant-plan.json
```

Set `spec.image` to a registry repository with an exact `@sha256:` pin,
`spec.runtimeReceipt` to the matching producer receipt, and `spec.bundle` to an
already materialized offline C1 directory containing `soot.bundle.json`.
Locators resolve relative to the App file. `tokenEnv` names an app-scoped VM
secret containing at least 32 URL-safe characters; no secret value enters a
document, displayed diff or process argument. Named instances cannot use global
or local `.env` values. Every instance has its own container, credentials and
`/opt/2server/data/NAME` store. Changing state/auth identity requires an explicit
operator migration, not a source update.

The candidate must use `listen: 0.0.0.0:7788`, a relative inventoried `ai_config`,
the matching `token_env`, and `data_dir: /state` (portable `data`/`state` is also
accepted before C3 normalizes it). Shared AI owns `credentials_dir: /credentials`.
All config, prompt, skill, pack, archive and installed receipt inputs remain
bounded and checked. Links, hardlinks, traversal, case collisions, unknown C1
fields, private/compiled content, mismatched digests and unsupported executable
closures fail closed. The measured image supplies `/bin/sh` and `/bin/timeout`;
selected programs must fit that closure. Runtime admission repeats on prepare
and commit. Full runtime config semantics are enforced by Soot.

Installed pack receipts must match the local absolute materialization directory;
2server relocates only their installation paths for the fixed VM inbox. Git
packs require an already obtained archive at
`BUNDLE/obtained-archives/ARCHIVE_SHA256.tar`; its bytes and installed tree are
verified offline, then staged into the instance's private runtime archive cache.
Plans never install, fetch or refresh a pack. No source digest is recomputed to
silently accept changed operator inputs.

| Container path | VM storage | Lifetime |
| --- | --- | --- |
| `/config` | `extensions/NAME/config` | Writable active config; runtime-owned saves |
| `/transactions` | `extensions/NAME/transactions` | Persistent C3 fences, acknowledgments, snapshots and inbox |
| `/state` | `/opt/2server/data/NAME` | Persistent conversations, receipts and monitoring |
| `/credentials` | `extensions/NAME/credentials` | Persistent token file, vault and private per-instance home |
| `/release` | `extensions/NAME/releases/UUID` | Read-only reviewed source, runtime receipt and supervisor definition |

Paths under `extensions/` are beneath `/opt/2server/`. Reviewed source is retained
under `releases/UUID/source`, separate from `/config`; C3 receives a private
inbox staging tree. Both trees must match the reviewed file/directory inventory
before commit and after a code handoff, including installed receipt bytes.
Restart never copies source defaults. Bind mounts forbid Docker from creating missing host paths.
Foreign ownership, overlapping state roots and altered mounts block effects.

## Two explicit reviewed phases

On a fresh instance, plan inspects absence and creates a private local artifact.
Review its server, instance, control revision and source/image/receipt pins;
set `reviewed_initialization: true` in that exact artifact, then apply:

```sh
2srv deploy -f platform/assistant.yaml --plan-file /private/assistant-plan.json --apply
```

Initialization is create-only. It installs an inert management definition with
no AI provider because Soot requires one definition even in management mode.
It establishes authenticated management and persistent mounts; it does not
apply the authored source or publish traffic. A nonempty/partially initialized
root is a recovery condition, never permission to reset it. Plan again after
initialization and use a new artifact path.

The source phase reads `GET /v1/settings/deploy/state`. Its `DeployPlan` binds
the request, runtime identity, baseline D ID/generation/digest, persisted P and
active A revisions, checked fingerprints F, candidate source/package/compatibility,
staging UUID/digest and exact difference digest. Review only this safe scope and
digest output; mission contents and credential values are not displayed.
If there is no D, add `plan.reviewed_replacement` with
`kind: initial_source_review` and an exact copy of `plan.bindings`. If P/A/F
has drifted since D, use `kind: reviewed_replacement` with those exact bindings.
An operator must explicitly make this decision after review. An agent must not
invent it merely because `--apply` was requested. `--apply` alone cannot approve
source replacement, and refreshing current revisions does not approve edits
since the last deployment. Raw changes require runtime `source.review` first.

Apply holds the normal VM control lock, compares local/control/host/runtime
facts again, stages exact bytes, and submits C3 prepare/commit. Any stale binding
requires abort/replan/review. The runtime lease independently excludes settings
writers and detects changes before writes and activation. Async activation is
polled through the same request's sanitized transaction receipt, including brief
listener handoffs. No ambiguous POST is replayed with a new ID.

Only acknowledged source and package plus `/readyz` permit supervisor pointer
publication. Shared domain/DNS/TLS reconciliation then publishes the declared
Domain. HTTPS `/readyz`, missing-bearer denial and authenticated active receipt
verification must pass. A runtime acknowledgment followed by edge/control failure
is reported as an unresolved later phase; inspect retained private recovery and
the runtime receipt before retrying. Readiness does not prove provider delivery
or a model smoke test.

## Restart, handoff and guarded restore

```sh
2srv app assistant release-status
2srv app assistant restart --apply
2srv app assistant restore-release --plan-output /private/restore.json
# Review scope and exact request; set reviewed_restore: true in this artifact.
2srv app assistant restore-release --plan-file /private/restore.json --apply
```

Restart uses the acknowledged installed release and retains saved/active edits;
it never resolves local bundle locators. A package replacement retains the C3
lease, disables old supervisor restart, sends TERM and waits for exit/store close
before creating the replacement on the same mounts. An uncertain stop or timeout
blocks replacement; there is no forced concurrent bbolt opener or live DB copy.
Compatible prior runtime receipts/supervisor files are retained for restore.

Restore binds current P/A/F, exact prior revision/package and `soot/api1-store1`.
Concurrent edits, unavailable snapshots/packages and incompatible stores refuse
restoration. The runtime restores config through its journal and acknowledges a
new active generation; vault, operator credentials, conversations, accepted-run
history, receipts and monitoring are not restored to old values. Different-code
restore uses the same stop/join handoff and repeats the same fenced request.
The source App remains the desired configuration; inspect active release status
after restore before planning another source deployment. Core `rollback` is not
the Soot restore workflow.

Removal explicitly stops only the owned process and retains roots, secrets,
releases and snapshots. Retire/reroute declared domains first; DNS retirement is
separate. Interrupted initialization, prepared leases, source conflicts and
missing mounts require inspection, not recursive cleanup or force unlock.
No database backup/DR contract is claimed: encrypted control backup excludes
Soot databases and volumes. A future data backup requires a runtime-supported
snapshot or stopped-store procedure; never copy a live bbolt file.

## Verification boundaries

Offline schema/digest checks, mocked adapter races and an opted-in isolated
Linux runtime fixture are separate evidence levels. Use
`DOCKER_TESTS=1 SOOT_RUNTIME_IMAGE=VERIFIED_LOCAL_IMAGE bun test tests/soot-runtime.test.ts`
after obtaining the exact package. The fixture uses temporary mounts, loopback
ports and a local trusted TLS certificate, exercises C3/edit conflicts/restart/
restore and reads retained history through the owner API. It never publishes an
image or copies a live DB. It is not public DNS, registry or staging VM evidence.
Live acceptance requires a dedicated consuming-project target, provider/registry
availability, owned DNS and trusted public HTTPS evidence. Keep that fixture and
its credentials outside this product repository.

From a checkout, `bun scripts/test-soot-vm.ts --fixture PRIVATE_FILE` validates two
named sources and inspects a pre-existing dedicated server before planning. The
strict private JSON fixture has `version: 1`, `nonproduction: true`, `server`,
`connectionFile`, an independently reviewed `providerIdentityDigest`, and exactly
two distinct `instances` with `name`, `sourceFile`, `planOutput`, and optional
`reviewedPlan`, `restoreOutput` and `reviewedRestore` paths. Paths resolve relative
to the private fixture. A mismatched target prints only its inspected identity
digest and stops; do not automatically accept that digest. `--step` selects
`plan`, `deploy`, `status`, `restart`, `restore` or `retire`; `--instance NAME`
narrows the scope and remote effects require `--apply`. This driver never creates
a VM, imports/publishes a registry image, sets secrets or fabricates review.
