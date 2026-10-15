# VM usage audit

Use this when a VM is slow, saturated or expensive, or before resizing it. It is a
**read-only investigation that ends in a ranked proposal**. Changing a service,
redeploying, restarting or resizing is a separate step the operator approves.

On a small host the cost is rarely one big process. It is usually a dozen small,
repeated costs: probes that start a process, timers that poll, a client stuck in a
retry loop, a cache that quietly switched off, duplicated agents. Nobody chose any
of them as a "workload". Attribute first, then ask of each consumer: *work or
waste?*

## Ground rules

- Measure before you propose, and measure again after a change with the same
  method. One reading is an anecdote: take at least two windows at a
  representative time, and note the traffic level at that time.
- Do not resize to fix an unattributed cost. A bigger VM hides a retry loop until
  traffic grows into it.
- Read-only on production: no restarts, no `docker run` experiments against live
  data, no redeploy "to measure", no kill by process name. Killing by port must
  target listeners only (`lsof -sTCP:LISTEN`). Use read-only database access.
- Never print command lines, environment, healthcheck shell strings or `docker
  inspect` output wholesale: they carry credentials. The bundled script prints
  process names and probe binaries only.
- Rule out the obvious first: is the database (often managed, elsewhere) the slow
  part? Is it the edge/CDN, or the client? Check the request path before blaming
  the VM.

## 1. Take a snapshot

From the consuming project, with the declared transport (see
[VM and connection](vm.md)):

```bash
# Prints the quoted transport command; review it, then run it with the script on stdin.
bun <absolute-skill-directory>/scripts/ssh-command.ts server.local.json 'sudo -n bash -s -- 120'
<printed command> < <absolute-skill-directory>/scripts/usage-snapshot.sh
```

`scripts/usage-snapshot.sh WINDOW` (30-900s, default 120) needs root and cgroup v2
and changes nothing. It reports:

| Section | What it answers |
| --- | --- |
| host | cores, load, memory, swap, disk; **PSI** `some` for cpu/memory/io |
| cpu over the window | per-cgroup CPU from `cpu.stat usage_usec` deltas: containers by name, systemd services, and the **part of `system.slice` no live child accounts for** |
| oneshot units | timer services that ran, with CPU per run from the journal's `Consumed` line |
| timers | every timer's schedule |
| restart loops | failed/activating units and `Scheduled restart job` counts |
| docker activity | events by verb, and exec/start/health events per container |
| healthchecks | interval and probe binary per container, restarts, OOM kills, start time |
| findings | automatic hits for the patterns below: short or interpreter healthchecks, fast polling timers, containers 2server does not manage, active cloud vendor agents |
| memory | current and peak per container/service |

How to read the numbers:

- CPU is in percent of **one** core; a 2-vCPU host has 200%. `host busy` is of
  all cores. `steal` above a few percent means the hypervisor, not you.
- PSI is the saturation signal. CPU `some avg60` of 20-40% on a small web host
  means requests regularly wait for a CPU; that is the latency users feel even
  when "CPU usage" looks moderate. Memory/io `full` above zero means stalls.
- The `not in any live child` line is the trap that per-container tools miss:
  CPU from processes whose cgroup is already gone (timer oneshots, `docker run
  --rm` probes, transient units). A large value means look at the oneshot and
  docker activity sections.
- Docker's own `containerd.service` / `docker.service` CPU grows with every
  `exec` and container start: healthchecks, `docker exec` collectors, `docker
  run` probes. Multiply the events by roughly 30-100ms each.
- Peaks far above current memory with no swap mean an OOM risk at the next
  spike; check `oom=true` and the kernel log.

## 2. Attribute and classify

Rank the leaves, then for each of the top consumers (cover ~80% of busy CPU)
decide which class it is. These are the patterns seen in practice, in rough order
of how much they cost:

**Application doing avoidable work** (usually the largest)
- A client loop: a probe/poll endpoint answering `429` or an error that the
  client retries immediately. Look at the app's request log by route and status,
  not just its CPU. Fix the client and give the cheap probe its own budget,
  rather than adding capacity.
- The fix already exists but is not deployed: compare the running image's
  revision with the default branch before profiling anything.
- Per-request CPU = container CPU-seconds per second / requests per second. A
  hot path costing tens of milliseconds (password hashing without a cache, token
  verification per request, a pure-JS crypto fallback) shows up here.
- A cache that switched itself off: after a dependency is recreated (new
  address), some clients never re-dial. Check the cache's client list and hit
  counters, not just that the app is "up".

**Probing and polling overhead**
- Container healthchecks start a process per probe. An interpreter (`bun -e`,
  `node -e`, `python -c`) costs far more than `wget`/`curl` or the binary's own
  `health` command. Intervals under ~10s are rarely justified; 30s with
  `start_interval` (Docker Engine 25+) keeps startup detection fast.
- Edge/proxy active health checks hitting an expensive page (a server-rendered
  `/`) every few seconds: point them at a static liveness route.
- Probes implemented as `docker run --rm curl` per attempt: each starts a
  container (~1-2s of host CPU). Probe from the host to the container address
  when the network allows.
- Collectors that fork per item (`jq`, `docker inspect` per container): batch
  into one call per kind.
- Timers polling every few seconds (`OnUnitInactiveSec=10s`) for something that
  changes rarely: make it event-driven (`docker events --filter`, inotify,
  systemd path units) with a slow safety timer. Note Docker 29 removed some event
  template fields; test the format on the running engine.

- An installed extension keeps the healthcheck and template it was applied
  with. A newer CLI's cheaper template reaches the VM only when the extension
  is re-applied: after a CLI upgrade, `plan` each installed extension file and
  re-apply the ones that show changes.

**Restart loops and failures**
- A unit or container that restarts every few seconds costs its whole startup
  each time. The restart sections show it; the journal shows why.

**Duplicates and leftovers**
- Two instances of the same service (an old project and a managed one), vendor
  agents that duplicate your own monitoring (cloud logging/metrics/OS-config
  agents next to node-exporter/Prometheus), stale monitoring observers for
  retired containers, exited old generations holding disk. Confirm which one
  receives traffic before proposing removal.

**Real work**
- Traffic-proportional CPU in the app and database after the above is removed.
  Only this justifies capacity: then consider right-sizing (vCPU count, memory,
  swap) with the measured headroom.

## 3. Operator overhead (deploys and locks)

Slow or blocked deploys are also a resource problem. `[2srv lock]` events on
stderr give `waitMs`/`heldMs` per reservation (see `docs/locking.md` in the
installed product).

- Each remote step used to pay a full SSH/IAP connection (seconds). Current CLIs
  reuse one master per transport; `TWO_SERVER_SSH_MUX=0` disables it if you
  suspect it.
- Long holds come from what runs inside the reservation: readiness and
  observation windows, migrations, image pulls. Draining the old generation now
  runs after release.
- An app deploy that meets a brief server operation fails at once by default;
  `TWO_SERVER_LOCK_WAIT=SECONDS` lets scoped mutations wait instead.
- Never break a lock because it is old; inspect it.

## 4. Propose

For each candidate, write: the measurement, the cause, the change, its rollout
cost (does it recreate a container or restart a stateful service? brief
downtime?), the risk, and the metric that will prove it. Rank by
`expected saving × confidence ÷ risk`. Prefer:

1. Fixes in the application or client that remove work (largest, lowest risk to
   the platform).
2. Cheaper probes, longer intervals, batching, event-driven timers.
3. Removing duplicates and leftovers, after confirming what serves traffic.
4. Capacity, last, sized from the remaining real work.

Report in this shape:

```text
Window: <UTC start, length, traffic level>   Host: <cores, PSI cpu some avg60, steal>
Top consumers: <name  % of one core  class>
Proposals (ranked):
  1. <change> — saves ~X% of a core / Y MiB; evidence; rollout cost; risk; verify by
Not changed / needs decision: <items that need the operator>
```

After an approved change, re-run the snapshot under similar traffic and report
before/after numbers, not impressions.

## Further reading

- Brendan Gregg, the USE method and *Linux performance analysis in 60 seconds*:
  utilization, saturation, errors per resource.
- Linux kernel documentation: *PSI - Pressure Stall Information* and *Control
  Group v2* (`cpu.stat`, `cpu.pressure`, `memory.peak`).
- Docker documentation: `HEALTHCHECK` / Compose `healthcheck` (`interval`,
  `start_period`, `start_interval`), and `docker events` filters.
- systemd documentation: `systemd.timer` (`OnUnitActiveSec`, `OnCalendar`),
  `systemd.path`, and resource accounting (`systemd-cgtop`).
