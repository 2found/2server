# Roadmap

These are design directions, not supported commands or installed templates.
The [docs index](README.md) and CLI/template help describe shipped behavior.
Each addition must fit the existing named App workflow and extension boundaries.

## Portable object storage

A small backend-neutral library could provide logical object references over
GCS and S3-compatible storage, including R2. Integrate one real app and run the
same conformance suite across private provider buckets before generalizing it.

Keep app data access outside the CLI. Existing stored provider URLs need a bounded
compatibility reader with explicitly owned host/bucket mappings. Changing an
infrastructure setting cannot rewrite shipped app code. Migration needs retained
location metadata, resumable copying, checksums, ownership and deletion rules;
no claim of provider portability removes the cost of moving bytes.

## Edge lifecycle

The `url-shortener` Worker + D1 template and `email-routing` already ship.
Extend external runtimes through template-owned `Extension.source` adapters;
core must not branch on provider names. General Worker deployment history,
versioned rollback and portable object-storage bindings remain future work.
Acceptance needs exact account/name/environment ownership, readiness gates,
foreign-route rejection and recovery after partial provider failure.

## Optional Soot operations

A named Soot template could add observation and human handoff. It would consume
a reproducible versioned artifact and own its service lifecycle, private state,
secrets, backup and probes; agent behavior belongs in Soot packs.

Begin with observation and bounded reporting through an explicitly selected
monitoring receiver. Require durable case/outbox state, restart/dedup checks,
model-failure handling and recovery updates. Do not grant a daemon the Docker
socket or root control snapshot. Unattended repair needs operation identity,
resource fencing and reconciliation after SSH loss before authority is expanded.

## Read replicas

PostgreSQL remains single-VM without automatic failover. A future read-offload
mode could use asynchronous physical replication to an explicitly supplied VM.
Same-VM replicas add neither host capacity nor host-failure protection.

Prerequisites include private TLS connectivity, dedicated replication credentials,
owned slots and volumes, bounded retained WAL, lag/health reporting, write
rejection and an isolated bootstrap/reseed path. Reads must tolerate staleness;
read-after-write stays on the primary. A replica is not a backup.

## Release gates

Prioritize current users: artifact installation, fresh-VM bootstrap, repeated
release, failure preservation and isolated recovery. New capabilities need
adverse-case tests and provider-specific staging evidence. Multi-cloud scheduling,
a general plugin loader and autonomous database repair remain outside the
current scope. Operator evidence and deployment-specific decisions belong in
the consuming repository.
