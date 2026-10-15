# Changelog

## Unreleased

- Deploys of different apps no longer wait for each other's domain phase. An App
  file with domains used to take the server-wide `domains` reservation on every
  deploy and republish the edge, reload Caddy and rewrite its Cloudflare cache
  rules even when nothing had changed. When the committed specs, the stored
  certificate, the live edge files (digests compared on the VM), DNS, SSL mode
  and cache rules already match, the deploy now only verifies the origin and
  public routes, without the reservation. Any difference, failed read or failed
  check runs the full phase as before and prints why.

- Domains that share a Cloudflare zone keep their cache rule positions. Without
  a zone path policy, a Domain's rule had to be the last in the zone, so each
  deploy moved its rule to the end, behind its neighbour's, and no Domain in a
  shared zone ever counted as unchanged. Domain rules select disjoint hosts;
  the rule now only has to sit before the first zone policy, or, without one,
  have no unmanaged rule after it.

- The route switch no longer runs `caddy validate` before `caddy reload` under
  the edge lock. A reload validates the whole configuration and keeps the
  running one when it is rejected, so the extra pass only lengthened the lock
  that every app's switch shares. Failed reloads restore the previous route as
  before.

- Deploys hold their locks for a fraction of the time. Each remote step reuses
  one OpenSSH connection per transport instead of opening its own; through a
  GCP IAP tunnel a step went from 4-7s to about 0.15s, and later steps skip
  `gcloud` altogether by running the `ssh` command it reports. A connected
  `plan` of a monitoring file took 32s and 4.2s of local CPU; it takes about 7s
  and 1s. The master lives under a private `/tmp/2srv-ssh-<uid>/` and closes
  120s after last use; `TWO_SERVER_SSH_MUX=0` turns reuse off.

- The previous generation drains and stops after the rollout returns. It used
  to keep the app's control reservation (and any server-scoped operation queued
  behind it) for `drainSeconds` plus the stop, 70s+ by default. A detached VM
  process keeps the app's VM lock until it has stopped, so the next rollout of
  the same app still waits for it (now up to 120s + drain + stop); other apps
  and server operations do not. A generation that fails to stop is logged to
  the journal under tag `2server`.

- Readiness and origin probes run `curl` on the host against the container's
  address, about 25ms, instead of starting a `curlimages/curl` container per
  attempt (~1.5s and ~2s of host CPU each on a busy 2 vCPU host). An `internal`
  network, a host without `curl` or a container without an IPv4 address there
  keep the containerized probe. A digest the VM already holds is no longer
  pulled again under the app lock, and extension image tags resolve in
  parallel.

- Cloudflare reads overlap: a domain's zone, SSL mode, records and cache
  ruleset are fetched together, a zone shared by several domains is looked up
  once, and DNS publish re-reads every host of a domain together before the
  first write. Writes stay sequential.

- `TWO_SERVER_LOCK_WAIT=SECONDS` (0-3600) lets an app or other scoped mutation
  wait for a conflicting reservation, such as a brief server operation, instead
  of failing at once. Server-scoped operations still fail at once. Waiting
  acquires back off from 250ms to 2s between polls.

- The monitoring runtime collector forks about a quarter as many `jq`: every
  app generation, retired contract, extension bundle and template identity is
  read by one `jq` per kind instead of one to three per item, and the observer
  configuration by one instead of five. On a host with ~40 containers a run
  went from ~2.4s to ~1.0s of CPU, every minute. The metrics are unchanged.
  Takes effect when the monitoring extension is next applied.

- The skill has a VM usage audit: `scripts/usage-snapshot.sh` attributes CPU,
  pressure, memory, timers, restarts and Docker exec activity on a host without
  changing it, and `references/usage-audit.md` guides an agent from that
  measurement to a ranked, verifiable optimization proposal.

- `2server-metadata-events.service` (0.2.19) no longer exits at once on
  Docker 29. Its `docker events --format '{{.ID}}'` named a field Docker 29
  removed, so the stream failed on start and systemd restarted the unit every
  5s, running the policy each time. The format now reads `.Action`. Takes
  effect at the next `server bootstrap`; a host bootstrapped with 0.2.19 needs
  it re-run.

- The monitoring runtime collector costs about a quarter of the CPU it did. It
  forked a `docker inspect` and four to six `jq` per probed container every
  minute, plus a `jq` per app field and three per upstream; with ~40 containers
  that was 11-12s of CPU per run on a 2 vCPU host. It now snapshots every
  container with one `docker ps`, one `docker inspect` and one `jq`, reads each
  app and the upstream list with a single `jq`, and still inspects by name
  anything the snapshot lacks. The metrics are unchanged. Takes effect when the
  monitoring extension is next applied.

- The cloud-metadata policy refreshes when a container starts instead of every
  5s. `2server-metadata-events.service` follows `docker events` and runs the
  policy for each start, so a granted workload restarted outside a deploy gets
  its access back at once instead of up to 5s later; the timer remains as a 60s
  safety net. Deny stays the chain default. Takes effect at the next
  `server bootstrap`.

- A single-upstream route no longer drops its only server for one slow probe.
  App and Compose blue/green Caddy snippets now give `/healthz` 4s (was 2s) and
  need three misses (was two), about 15s, before they remove the sole peer. On a
  CPU-starved host the old values ejected a working server and answered every
  request with `503 no upstreams available` until two probes passed again. A
  server that stays unready is still removed. Multi-replica pools keep the
  faster 2s/two-miss ejection, since a sibling serves while one is unready. The new snippet takes effect at
  the app's next deploy.

- Template container healthchecks run every 30s instead of every 5s (NATS,
  PostgreSQL, Redis, Meilisearch, imgproxy) or 10s (Prometheus, Alertmanager,
  node-exporter). Docker starts a process for every probe, which cost a 2 vCPU
  host about a fifth of a core. `start_interval: 2s` keeps the start period
  fast, so `up --wait` still sees readiness within about 2s. The time before a
  failing container turns `unhealthy` is unchanged (about 120s; 60s for
  monitoring). Needs Docker Engine 25 or newer. The new check applies when the
  extension is next applied, which recreates its container.

- Soot installs as a bare runtime and upgrades its own package: handoff,
  readiness check, and the previous release restored on failure. A repository
  ships its slice with `kind: SootSource` (`init soot-source` writes one)
  without restarting the runtime. `deploy -f FILE --apply` plans, prints the
  decision and applies it; replacing Nest edits needs the source id or
  `--replace-edits`. `app NAME rotate-token` applies a rotated operator token.

- Soot and Meilisearch no longer run as root. Both run as `65532:65532`, with a
  read-only root, all capabilities dropped and `no-new-privileges`. Soot's
  host adapter gives that user its four writable mounts before every start,
  walking by directory descriptor so it never follows a planted link, and
  hands them back to root when an older release without a `user` is restored.
  The mounted release stays root's; that user's group reads only its receipt.
  Staging re-owns the inbox and archive cache for the user already running.
  Meilisearch converts its data path in place (the `.2server-owner` marker
  stays root's), spills indexing temp files to `/meili_data/tmp`, and only
  that user can read its key-bearing config and readiness files.

- App Domains gain three opt-ins: `healthPath` points the origin and public
  probes at a readiness path for API origins that do not answer `GET /`;
  `allowFraming` drops the edge's `X-Frame-Options: DENY` for an embeddable
  widget host; `clientIp: cloudflare` forwards the visitor address
  (`CF-Connecting-IP`) as `X-Forwarded-For` on direct proxy targets, trustworthy
  only while the origin admits Cloudflare ranges alone.

- Soot `spec.secretEnv` delivers further declared VM secrets to the runtime
  through a private `credentials/app.env`, validated before the old owner
  stops; the public-web challenge secret must be listed. List-valued `*Env`
  fields now count as secret references. Restore verifies only operator-port
  domains, retries public verification with a DoH fallback and names an
  unresolved public phase; retirement accepts domain-retirement edge releases.

- Opt-in Service hardening: numeric `user` (data path handed to that UID:GID
  without following links), `readOnly` (read-only root plus a small `/tmp`
  tmpfs), `capDropAll` and `pidsLimit`. Existing Services render unchanged.

- `app NAME delete --purge` (and `delete extension NAME --purge`) removes a
  template app or Service completely: container, extension root, owned data
  path, unused images, instance lock, app-scoped VM secrets and deployment
  records. It refuses routed domains, unproven data ownership, unsafe paths and
  templates with host or external artifacts (PostgreSQL). Soot purges through
  its host adapter after retire semantics. Plain delete still retains data.

- Source image App applies/deploys download images before reserving the app,
  then reload and revalidate VM state/secrets under lock. Runtime digest pulls,
  migrations, readiness and drain retain their existing protection. Connected
  control locks emit stderr wait/hold timings and blocking reservation IDs;
  contention is reported separately from SSH/ownership failures.

- Independent `meilisearch` App template for platform search: persistent named
  instances, app-scoped private master-key files, indexing resource bounds and
  authenticated readiness. Soot connectors and data pools are configured separately.

- Release CI now uses the exact package version and an immutable Git tag, then distributes the npm CLI with versioned docs, download metadata and checksums after verification. Ordinary main pushes no longer invent npm versions.

Release candidate; these entries describe the working tree, not the npm `latest`
package. CI publishes the version in `package.json` under its matching Git tag.

- Named native `soot` template separates pinned Linux runtime code from reviewed
  offline C1 source. Private plan artifacts bind VM/control/source/receipt and C3
  revisions; initialization and replacement need exact explicit review. Runtime
  guards retain edits, store/vault identity and acknowledged history. Specialized
  stop/join, host readiness and guarded restore preserve single-owner bbolt
  lifecycle; no live database copy or automatic source reseeding. Operator docs,
  examples, skill and isolated Linux/TLS checks distinguish local verification
  from registry/public-DNS/VM acceptance.
  Pre-commit package readiness failures recover the retained supervisor before
  aborting the source lease; a blocked close or recovery preserves its fence.

- Monitoring reads explicit container/upstream observers from the current VM
  control revision per collection, scoped to its named App or legacy spec.
  Retained app contracts and extension retirement markers exclude retired
  targets from stale observers; missing active targets still alert. Invalid
  discovery configuration preserves the last complete metrics file.

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
