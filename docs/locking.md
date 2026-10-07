# Locking and concurrent deployments

The lock protects a conflicting operation, not a command or an SSH connection.
Connected deployments of independent image apps can overlap image pulls,
preDeploy, startup, readiness, post-switch observation and draining. This applies
to source App files and `deploy/reload/rollback/scale app NAME`.

## Current boundaries

| Resource | Protected work | Duration |
| --- | --- | --- |
| `app:NAME` | App contract, secrets, templates, generation choice, preDeploy, rollout/rollback | Entire selected app operation, including final snapshot commit |
| Compose service identity, container names, upstream file | Explicit physical bindings that can alias across app names | Same app operation; separate services in one Compose project can overlap |
| `domains` | Domain ownership, certificates, Cloudflare policy read/modify/write, edge site release and its whole-release rollback | Domain phase only, through snapshot commit |
| Caddy kernel lock | Change upstream/site files, validate and reload; restore a failed route | Actual switch/restore only; app readiness, observation and drain run outside it |
| Control kernel mutex | Acquire/release/break reservations and compare-and-swap `current` | Short local filesystem transaction; no upload, rollout or provider request |
| `server` | Setup/bootstrap/restore, whole-manifest changes, extension/dependency lifecycle and operations without a scoped contract | Whole operation; conflicts with every reservation |

Reads and plans take no operation reservation and persist no revision/history.
Tag resolution uses the digest returned by its own `docker pull`, not a later
lookup of the mutable local tag. Docker owns cache coordination.

App secret updates reserve only their app. Server secret updates are exclusive
because all apps and domain operations may consume them. Extension and legacy
whole-manifest operations retain server scope: they can alter shared providers,
networks, authentication and routes. They must be decomposed into explicit
resource contracts before narrowing them; they are not assumed independent just
because their CLI names differ.

A source App with domains first reserves its app and rolls it out. It commits
the healthy app, then acquires `domains` (waiting at most 120 seconds), refreshes
the committed snapshot/certificate state, and reconciles domains. Another app
can continue its rollout during that wait. Domain errors preserve the committed
app and any issued certificate state, and report failure. Standalone Domain
files and individual domain CRUD use the same `domains` reservation.

Domain operations remain serialized with each other, even for different zones:
Cloudflare policies are zone-wide read/modify/write, and origin-check failure
currently rolls back the entire edge site release. Per-zone locks alone would
not make that rollback safe. Narrower domain locking requires per-site rollback
first. Apps switching their independent upstream snippets need only the short
Caddy kernel lock.

A custom preDeploy command may write a database shared by multiple apps. App
names cannot identify that external write set. Such migrations must use their
migration engine's database lock or an explicit shared database lock in the
migration command. The CLI does not assume that different app names imply
independent database schemas.

## Snapshot commits

Each session remembers its baseline. At commit, it fetches the latest revision
and applies only its changes: apps/domains by name, app secrets by app, portable
state by path, and other configuration by top-level resource. Unchanged entries
come from the latest snapshot. A conflicting edit fails rather than overwriting
another writer; values are not included in the error.

Uploads happen outside the control mutex. Inside the mutex the writer checks
all held reservation tokens and the expected current revision, then atomically
switches the symlink. If the revision changed during upload, only merge/upload/
commit is retried (at most 20 attempts); migrations and rollout are never rerun.
A failed final commit retains the private recovery snapshot as before.

## Crash recovery and compatibility

Reservations persist across operator crashes or SSH loss: external work may
still be running, so neither TTL expiry nor an operator PID proves safety.
`server lock` lists each scoped reservation's resources, owner and `lockId`.
`server unlock --lock-id ID --apply` archives only that reservation. It cannot
release another app's lock. Revoked writers cannot commit, including writers
whose domain reservation was revoked after their app rollout.

Scoped reservations occupy the old `control/lock` gate directory, so older
CLIs fail closed on acquire. An old global lock blocks new scoped writers.
Use the updated CLI for inspection/unlock of scoped locks; do not use an old
unlock implementation that treats the gate as a single reservation. Never mix
legacy local-manifest mutations with connected sessions on the same VM.

The implementation retains the existing per-app VM `flock` across rollout and
drain. This also protects runtime work still executing after an SSH disconnect.
Manually breaking a control reservation does not cancel that work.
