#!/bin/bash
# Read-only resource attribution for a Docker VM. Run as root on the VM through
# the declared transport, for example:
#   <ssh-command> 'sudo -n bash -s -- 120' < usage-snapshot.sh
# Argument: measurement window in seconds (default 120, 30-900).
#
# It changes nothing: no restart, no container start, no file outside a private
# temporary directory that is removed on exit. It prints process names, never
# command lines, and never healthcheck arguments, so values passed in argv or
# environment are not echoed.
set -uo pipefail
export LC_ALL=C
window=${1:-120}
[[ "$window" =~ ^[0-9]+$ ]] && [ "$window" -ge 30 ] && [ "$window" -le 900 ] || { echo "window must be 30-900 seconds" >&2; exit 2; }
[ "$(id -u)" = 0 ] || { echo "run as root (sudo -n bash -s)" >&2; exit 2; }
[ -f /sys/fs/cgroup/cgroup.controllers ] || { echo "cgroup v2 is required" >&2; exit 2; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
cores=$(nproc)

section() { printf '\n== %s ==\n' "$1"; }
usage() { awk '$1 == "usage_usec" { print $2 }' "$1/cpu.stat" 2>/dev/null; }
# One line per cgroup that owns CPU: system services, container scopes, user
# sessions and the init scope. Nested docker scopes are listed by their scope.
cgroups() {
  find /sys/fs/cgroup/system.slice /sys/fs/cgroup/user.slice /sys/fs/cgroup/init.scope \
    -mindepth 0 -maxdepth 2 -name cpu.stat -printf '%h\n' 2>/dev/null | sort -u
}
snapshot() { while IFS= read -r cg; do printf '%s %s\n' "$cg" "$(usage "$cg")"; done < <(cgroups); }
stat_cpu() { awk '$1 == "cpu" { print $2+$3+$4+$5+$6+$7+$8+$9, $9, $5 }' /proc/stat; }  # total, steal, idle (jiffies)

section "host"
printf 'cores=%s window=%ss kernel=%s\n' "$cores" "$window" "$(uname -r)"
uptime
free -m | sed -n '1,3p'
printf 'swap devices: %s\n' "$(swapon --noheadings --show=NAME 2>/dev/null | tr '\n' ' ' | sed 's/ $//' || true)"
df -hP / /var/lib/docker 2>/dev/null | awk 'NR == 1 || !seen[$0]++'
for r in cpu memory io; do printf 'pressure %-6s %s\n' "$r" "$(tr '\n' ' ' < /proc/pressure/$r 2>/dev/null)"; done

# Container names for docker scopes, and restart/OOM counts.
docker ps -a --no-trunc --format '{{.ID}} {{.Names}}' > "$tmp/names" 2>/dev/null || true
name_of() {
  local base="${1##*/}" id
  case "$base" in
    docker-*.scope) id="${base#docker-}"; id="${id%.scope}"; awk -v id="$id" '$1 == id { print "container:" $2; f=1 } END { if (!f) print "container:" substr(id,1,12) }' "$tmp/names";;
    *) printf '%s\n' "${1#/sys/fs/cgroup/}";;
  esac
}

snapshot > "$tmp/before"; read -r t0 s0 i0 < <(stat_cpu); start=$(date +%s)
since=$(date '+%Y-%m-%d %H:%M:%S')  # journalctl's local-time form
sleep "$window"
snapshot > "$tmp/after"; read -r t1 s1 i1 < <(stat_cpu); end=$(date +%s)
elapsed=$((end - start))

section "cpu over ${elapsed}s (percent of ONE core; host has $cores)"
awk -v total=$((t1 - t0)) -v steal=$((s1 - s0)) -v idle=$((i1 - i0)) -v cores="$cores" 'BEGIN {
  if (total > 0) printf "host busy %.1f%% of all cores, steal %.1f%%\n", 100 * (total - idle - steal) / total, 100 * steal / total }'
# Delta per cgroup; parents include children, so leaves are what to rank.
join "$tmp/before" "$tmp/after" | awk -v s="$elapsed" '$3 >= $2 { printf "%s %.2f\n", $1, ($3 - $2) / 1e4 / s }' > "$tmp/delta"
# A parent whose children are listed is skipped; its unattributed rest follows.
awk 'NR == FNR { path[NR] = $1; n = NR; next }
     { for (i = 1; i <= n; i++) if (index(path[i], $1 "/") == 1) next; print }' "$tmp/delta" "$tmp/delta" |
while read -r cg pct; do
  printf '%6.2f%%  %s\n' "$pct" "$(name_of "$cg")"
done | sort -rn | head -40
# CPU spent by processes whose cgroup no longer exists (exited oneshots, timers,
# transient units, `docker run --rm` probes) shows only in the parent's total.
awk '
  { pct[$1] = $2 }
  END {
    p = "/sys/fs/cgroup/system.slice"
    if (!(p in pct)) exit
    for (c in pct) if (index(c, p "/") == 1 && split(substr(c, length(p) + 2), parts, "/") == 1) children += pct[c]
    printf "%6.2f%%  system.slice total; %.2f%% not in any live child (exited timers, transient units, finished containers)\n", pct[p], pct[p] - children
  }' "$tmp/delta"

section "oneshot units that ran during the window (CPU per run from the journal)"
journalctl --since "$since" -o cat --no-pager 2>/dev/null \
  | awk '/: Consumed .* CPU time/ { unit = $1; sub(/:$/, "", unit); match($0, /Consumed [^ ]+ CPU time/); cpu = substr($0, RSTART + 9, RLENGTH - 18); runs[unit]++; last[unit] = cpu }
         END { for (u in runs) printf "%4d runs  last %-8s %s\n", runs[u], last[u], u }' | sort -rn | head -20

section "timers (schedule)"
systemctl list-timers --all --no-pager --no-legend 2>/dev/null | awk '{ print $(NF-1), $NF }' | sort -u | while read -r unit service; do
  [ -n "$service" ] || continue
  interval=$(systemctl show "$unit" -p TimersMonotonic -p TimersCalendar --value 2>/dev/null | tr '\n' ' ' | sed -E 's/ ; next_elapse=[^}]*//g; s/ *$//')
  printf '%-55s %s\n' "$service" "${interval:-?}"
done | head -40

section "restart loops and failed units"
systemctl list-units --state=failed,activating,auto-restart --no-pager --no-legend 2>/dev/null | head -20
journalctl --since "$since" -o cat --no-pager 2>/dev/null | awk '/Scheduled restart job/ { n[$1]++ } END { for (u in n) printf "%4d restarts in window  %s\n", n[u], u }'

section "docker activity in the window (each exec/run starts processes)"
# Only the action verb: an exec action carries its command line.
docker events --since "$start" --until "$end" --format '{{.Type}} {{index (split (printf "%s" .Action) ":") 0}} {{.Actor.Attributes.name}}' 2>/dev/null > "$tmp/events"
awk '{ n[$1 " " $2]++ } END { for (k in n) printf "%6d  %s\n", n[k], k }' "$tmp/events" | sort -rn | head -15
echo "--- exec_start / start / health_status by container"
awk '$2 ~ /^(exec_start|start|health_status)$/ { n[$2 " " $3]++ } END { for (k in n) printf "%6d  %s\n", n[k], k }' "$tmp/events" | sort -rn | head -25

section "container healthchecks (interval, probe binary) and restarts"
docker ps -q 2>/dev/null | xargs -r docker inspect -f \
  '{{.Name}} {{if .Config.Healthcheck}}{{.Config.Healthcheck.Interval}} {{with .Config.Healthcheck.Test}}{{index . 0}} {{if gt (len .) 1}}{{index . 1}}{{else}}-{{end}}{{end}}{{else}}none -{{end}} restarts={{.RestartCount}} oom={{.State.OOMKilled}} started={{.State.StartedAt}}' 2>/dev/null \
  | awk '{ probe = ($2 == "none") ? "-" : ($3 == "CMD-SHELL") ? "shell" : $4; sub(/^.*\//, "", probe); printf "%-45s %-6s %-10s %s %s %s\n", substr($1, 2), $2, probe, $(NF-2), $(NF-1), $NF }' | sort -k2,2 | head -60
printf 'containers: %s running, %s total\n' "$(docker ps -q | wc -l)" "$(docker ps -aq | wc -l)"
docker ps -a --filter status=exited --filter status=restarting --format '{{.Names}} {{.Status}}' 2>/dev/null | head -20

section "memory by container (MiB, current / peak where available)"
while IFS= read -r cg; do
  [ -f "$cg/memory.current" ] || continue
  printf '%8.0f %8s  %s\n' "$(( $(cat "$cg/memory.current") / 1048576 ))" "$(awk '{ printf "%.0f", $1 / 1048576 }' "$cg/memory.peak" 2>/dev/null || echo -)" "$(name_of "$cg")"
done < <(cgroups | awk 'NR == FNR { p[NR] = $0; n = NR; next } { for (i = 1; i <= n; i++) if (index(p[i], $0 "/") == 1) next; print }' - <(cgroups)) | sort -rn | head -25

section "busiest processes now (name only)"
ps -eo pcpu=,rss=,comm= --sort=-pcpu | awk '$3 != "ps"' | head -15 | awk '{ printf "%5s%%  %6.0f MiB  %s\n", $1, $2 / 1024, $3 }'
