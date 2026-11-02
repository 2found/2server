import { quote } from '../../../../../shared/infrastructure/process';
import type { Config } from '../../../../config/application/config';
import { extensionProject,extensionRoot } from '../../../application/stateful';
import { instanceName } from '../../../domain/instance';
import type { ExtensionSpecs } from '../../../domain/specs.generated';
import {
  ANTIGRAVITY_DEFAULT_ENDPOINT,ANTIGRAVITY_ENDPOINT_PATTERN,ANTIGRAVITY_QUOTA_MODELS,ANTIGRAVITY_USER_AGENT,
  CODEX_QUOTA_MODEL,CODEX_USAGE_URL,CODEX_USER_AGENT,
} from './quota';

// Opt-in `quotaAlert`: a root-owned systemd oneshot + timer on the VM that
// reads the gateway's live quota exactly as `app NAME quota` does (the
// management API, from inside the container's network namespace, with the
// shared probe constants of ./quota.ts) and posts to a Discord webhook when a
// model's pool is nearly exhausted. The webhook URL and management key reach
// the VM only as two root-only 0400 curl config files of the release bundle;
// the script, units and metrics never contain them.
type Spec = NonNullable<ExtensionSpecs['cliproxy']>;
type QuotaAlert = NonNullable<Spec['quotaAlert']>;

const WEBHOOK = /^https:\/\/(?:(?:ptb\.|canary\.)?discord(?:app)?\.com)\/api\/webhooks\/[0-9]{5,25}\/[A-Za-z0-9_-]{20,200}$/;
// Keys travel inside a curl config file; the same alphabet as hooks.ts SAFE_KEY.
const SAFE_KEY = /^[A-Za-z0-9_.:+/=-]+$/;

export const QUOTA_ALERT_SECRET_FILES = ['quota-alert.mgmt.conf', 'quota-alert.webhook.conf'];
export const quotaAlertUnit = (c: Config) => `${extensionProject(c, 'cliproxy')}-quota-alert`;
export const quotaAlertStateDir = (c: Config) => `${extensionRoot('cliproxy', c)}/quota-alert.d`;
export const quotaAlertMetrics = (c: Config) => `/opt/2server/metrics/${instanceName(c, 'cliproxy')}-quota-alert.prom`;

export function checkWebhook(url: string): string {
  if (!WEBHOOK.test(url)) throw new Error('quotaAlert.webhookEnv must hold a Discord webhook URL (https://discord.com/api/webhooks/ID/TOKEN)');
  return url;
}

// Non-secret settings the script and its jq programs read at run time.
export function quotaAlertConfig(c: Config, q: QuotaAlert) {
  return {
    app: instanceName(c, 'cliproxy'),
    ...(q.models ? {models: q.models} : {}),
    thresholdPercent: q.thresholdPercent,
    repageSeconds: q.repageMinutes * 60,
    antigravity: {
      models: ANTIGRAVITY_QUOTA_MODELS.map(([key]) => key),
      endpoint: ANTIGRAVITY_DEFAULT_ENDPOINT,
      endpointPattern: ANTIGRAVITY_ENDPOINT_PATTERN,
      userAgent: ANTIGRAVITY_USER_AGENT,
    },
    codex: {model: CODEX_QUOTA_MODEL, url: CODEX_USAGE_URL, userAgent: CODEX_USER_AGENT},
  };
}

// One /api-call per probe-able account; the request bodies mirror cli.ts fetchQuotas.
const TARGETS_JQ = String.raw`$cfg[0] as $c
| .files[]?
| select(.name and .auth_index and ((.disabled // false) | not))
| (.provider // .type // "") as $p
| select($p == "antigravity" or $p == "codex")
| if $p == "antigravity" then
    ((.antigravity_capability_hints.endpoint? // "") | if type == "string" and test($c.antigravity.endpointPattern; "i") then . else $c.antigravity.endpoint end) as $ep
    | ([.project_id, .project] | map(select(. != null and . != "")) | first // "") as $project
    | {name, req: {auth_index, method: "POST", url: "\($ep)/v1internal:fetchAvailableModels",
        header: {"Authorization": "Bearer $TOKEN$", "Content-Type": "application/json", "User-Agent": $c.antigravity.userAgent},
        data: ({project: $project} | tojson)}}
  else
    ((.account_id // ((.id_token | objects | .chatgpt_account_id) // "")) // "") as $acct
    | {name, req: {auth_index, method: "GET", url: $c.codex.url,
        header: ({"Authorization": "Bearer $TOKEN$", "User-Agent": $c.codex.userAgent} + (if $acct != "" then {"Chatgpt-Account-Id": $acct} else {} end))}}
  end
`;

// Account listing + probe replies -> the shape `app NAME quota` prints. Probe
// failures keep only a status code; response bodies never leave this program.
const ACCOUNTS_JQ = String.raw`$cfg[0] as $c
| ($probes | map({key: .name, value: .}) | from_entries) as $byName
| [ $files[0].files[]? | select(.name) | . as $f
  | $byName[$f.name] as $p
  | ($f.provider // $f.type // "") as $prov
  | (if $p == null then {quotas: [], error: null}
     elif $p.http != 200 then {quotas: [], error: "probe failed (HTTP \($p.http))"}
     else
       ($p.reply.status_code? // 0) as $sc
       | (($p.reply.body? | if type == "string" then (try fromjson catch null) else . end) // {}) as $b
       | if $prov == "antigravity" then
           if $sc == 200 and ($b.models? | type) == "object" then
             {quotas: [ $c.antigravity.models[] as $k | $b.models[$k].quotaInfo? | select(. != null)
                 | {model: $k, remainingPercent: (((.remainingFraction // 0) * 1000 | round) / 10), resetTime: (.resetTime // null)} ], error: null}
           elif $sc >= 400 then
             {quotas: [], error: (if (try ([$b.error.details[]?.metadata?.validation_url? | select(. != null)] | length) catch 0) > 0
                then "Google account verification required (\($sc))" else "HTTP \($sc)" end)}
           else {quotas: [], error: null} end
         else
           if $sc == 200 then
             {quotas: [ $b.rate_limit.primary_window? | select(. != null)
                 | {model: $c.codex.model, remainingPercent: ([0, ((100 - (.used_percent // 0)) * 10 | round) / 10] | max),
                    resetTime: (if (.reset_at | type) == "number" then (.reset_at | todate) else null end)} ], error: null}
           elif $sc >= 400 then {quotas: [], error: "HTTP \($sc)"}
           else {quotas: [], error: null} end
         end
     end) as $r
  | {name: $f.name, provider: $prov, label: ($f.label // null), status: ($f.status // null),
     disabled: ($f.disabled // false), unavailable: ($f.unavailable // false),
     cooldowns: (($f.cooldowns // (($f.runtime_only | objects | .quota.cooldowns?) // [])) | length),
     error: $r.error, quotas: $r.quotas} ]
`;

// The alert state machine. Pure: (config, accounts, previous state, now) ->
// (new state, message lines, metrics). Keys: "model:<m>" and "accounts".
//   low -> alert once; still low -> silent until repageSeconds; recovered -> one
//   message. A model with no data this run keeps its previous state.
export const QUOTA_EVALUATE_JQ = String.raw`$cfg[0] as $c | $accts[0] as $accounts
| def tick: "\u0060";
  def epoch: sub("\\.[0-9]+"; "") | sub("[+-]00:?00$"; "Z") | fromdateiso8601;
  def stamp: strftime("%Y-%m-%d %H:%M");
  def when: "\(stamp) UTC / \((. + 25200) | stamp) Asia/Ho_Chi_Minh";
  def num: tostring;
  def safe: gsub("[^A-Za-z0-9._:/()+-]"; "_");
  def clean: tostring | gsub("[\u0060\\r\\n]"; " ") | .[0:80];
  def step($p; $low):
    ($p // {low: false, at: 0, since: 0}) as $p
    | if $low and ($p.low | not) then {ev: "low", s: ($p + {low: true, at: $now, since: $now})}
      elif $low and ($now - $p.at) >= $c.repageSeconds then {ev: "still", s: ($p + {low: true, at: $now})}
      elif $low then {ev: null, s: $p}
      elif $p.low then {ev: "recovered", s: ($p + {low: false, at: 0, since: 0})}
      else {ev: null, s: ($p + {low: false, at: 0, since: 0})} end;
  $c.app as $app
| ($state.keys // {}) as $prev
| ([ $accounts[] | select(.disabled | not) | .name as $n | (.quotas // [])[]
     | {model, rem: .remainingPercent, reset: (.resetTime // null)} ]
   | group_by(.model)
   | map({model: .[0].model, n: length, best: (map(.rem) | max), zero: (map(select(.rem <= 0)) | length),
          reset: ([.[] | .reset | select(. != null) | try epoch catch empty] | min)})
   | map(select(($c.models == null) or (.model as $m | any($c.models[]; . == $m))))) as $stats
| [ $stats[] | . as $m | step($prev["model:" + $m.model]; $m.best <= $c.thresholdPercent) as $r
    | $m + {key: ("model:" + $m.model), ev: $r.ev, s: $r.s} ] as $ms
| def bad: (.error != null) or (.status == "error") or (.unavailable == true and .cooldowns == 0);
  ([ $accounts[] | select((.disabled | not) and bad) ]) as $bad
| ([ $accounts[] | select(.disabled) ] | length) as $disabled
| ($prev["accounts"] // {low: false, at: 0, since: 0, streak: 0}) as $ap
# Two consecutive bad probes before paging: one failed upstream call is noise.
| (if ($bad | length) > 0 then ($ap.streak // 0) + 1 else 0 end) as $streak
| step($ap; (if $streak >= 2 then true elif $streak == 1 then ($ap.low // false) else false end)) as $ar
| ($ar.s + {streak: $streak}) as $as
| ($ms | map(select(.ev != null) | . as $m
    | if .ev == "recovered" then
        "**RECOVERED** \(tick)\(.model)\(tick) on \($app): best remaining \(.best | num)% across \(.n) account(s)."
      else
        "**\(if .ev == "low" then "LOW" else "STILL LOW" end)** \(tick)\(.model)\(tick) on \($app): best remaining \(.best | num)% across \(.n) account(s), \(.zero) at 0%. "
        + (if .reset != null then "Earliest reset \(.reset | when)." else "Reset time unknown." end)
        + (if .ev == "still" then " Low for \((($now - .s.since) / 60) | floor) min." else "" end)
      end)) as $modelLines
| (if $ar.ev == null then []
   elif $ar.ev == "recovered" then ["**ACCOUNTS RECOVERED** \(tick)\($app)\(tick): every enabled account is available again."]
   else [ "**ACCOUNTS** \(tick)\($app)\(tick): \($bad | length) account(s) need attention: "
        + ([ $bad[:10][] | "\(tick)\((.label // .name) | clean)\(tick) (\(.provider): \(if .error != null then .error elif .status == "error" then "status error" else "unavailable" end))" ] | join(", "))
        + (if ($bad | length) > 10 then ", and \(($bad | length) - 10) more" else "" end) + "."
        + (if $disabled > 0 then " \($disabled) disabled by the operator." else "" end) ] end) as $accountLines
| def lab($m): "{app=\"\($app | safe)\",model=\"\($m | safe)\"}";
  {
    state: {keys: ($prev + ($ms | map({(.key): .s}) | add // {}) + {accounts: $as}), updated: $now},
    lines: ($modelLines + $accountLines),
    metrics: ([
      "two_cliproxy_quota_alert_timestamp_seconds{app=\"\($app | safe)\"} \($now)",
      "two_cliproxy_quota_alert_probe_ok{app=\"\($app | safe)\"} 1",
      "two_cliproxy_quota_accounts_total{app=\"\($app | safe)\"} \($accounts | length)",
      "two_cliproxy_quota_accounts_problem{app=\"\($app | safe)\"} \($bad | length)",
      "two_cliproxy_quota_accounts_alerting{app=\"\($app | safe)\"} \(if $as.low then 1 else 0 end)"
    ] + ($ms | map(
      "two_cliproxy_quota_best_remaining_percent\(lab(.model)) \(.best)",
      "two_cliproxy_quota_accounts_at_zero\(lab(.model)) \(.zero)",
      "two_cliproxy_quota_low\(lab(.model)) \(if .s.low then 1 else 0 end)")) | join("\n"))
  }
`;

const SCRIPT = String.raw`#!/bin/bash
# Generated by 2server (cliproxy quotaAlert). Reads the gateway's live quota
# like "app NAME quota" and posts to a Discord webhook. Holds no secrets: the
# management key and webhook URL are read from root-only curl config files.
set -Eeuo pipefail
umask 077
dir=@@DIR@@
stateDir=@@STATE_DIR@@
metrics=@@METRICS@@
container=@@CONTAINER@@
owner=@@OWNER@@
app=@@APP@@
exec 9>@@LOCK@@
flock -n 9 || { echo 'quota alert: previous run still active'; exit 0; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
now=$(date +%s)

publish() { # FILE -> metrics textfile, replaced atomically
  mkdir -p "$(dirname "$metrics")"
  local m; m=$(mktemp "$(dirname "$metrics")/.cliproxy-quota.XXXXXX")
  cat "$1" > "$m"; chmod 644 "$m"; mv -f "$m" "$metrics"
}
fail() {
  echo "quota alert: $1" >&2
  printf 'two_cliproxy_quota_alert_timestamp_seconds{app="%s"} %s\ntwo_cliproxy_quota_alert_probe_ok{app="%s"} 0\n' "$app" "$now" "$app" > "$tmp/fail.prom"
  publish "$tmp/fail.prom"
  exit 1
}
api() { # METHOD PATH [BODYFILE] -> HTTP status on stdout, body in $tmp/out
  : > "$tmp/out"
  local args=(-sS --max-time 30 -X "$1" -K "$dir/quota-alert.mgmt.conf" -o "$tmp/out" -w '%{http_code}') code
  [ -z "$@{3:-}" ] || args+=(-H 'Content-Type: application/json' --data-binary "@$3")
  code=$(nsenter -t "$pid" -n curl "$@{args[@]}" "http://127.0.0.1:@@PORT@@/v0/management$2" 2>/dev/null) || code=000
  printf '%s' "$code"
}

test "$(cat /opt/2server/edge/owner 2>/dev/null)" = "$owner" || fail 'this server does not own the app'
test "$(docker inspect -f '{{index .Config.Labels "io.2server.owner"}}' "$container" 2>/dev/null)" = "$owner" || fail 'gateway container not found'
pid=$(docker inspect -f '{{.State.Pid}}' "$container" 2>/dev/null) || pid=0
[ "$@{pid:-0}" -gt 0 ] || fail 'gateway is not running'

code=$(api GET /auth-files)
[ "$code" = 200 ] && jq -e '.files | type == "array"' "$tmp/out" >/dev/null 2>&1 || fail "management API answered $code"
cp "$tmp/out" "$tmp/files.json"

jq -c --slurpfile cfg "$dir/quota-alert.json" -f "$dir/quota-targets.jq" "$tmp/files.json" > "$tmp/targets"
: > "$tmp/probes"
while IFS= read -r target; do
  name=$(printf '%s' "$target" | jq -r .name)
  printf '%s' "$target" | jq -c .req > "$tmp/req"
  code=$(api POST /api-call "$tmp/req")
  jq -cRs --arg name "$name" --arg http "$code" '{name: $name, http: (($http | tonumber?) // 0), reply: (try fromjson catch null)}' "$tmp/out" >> "$tmp/probes"
done < "$tmp/targets"

jq -n -c --slurpfile cfg "$dir/quota-alert.json" --slurpfile files "$tmp/files.json" --slurpfile probes "$tmp/probes" \
  -f "$dir/quota-accounts.jq" > "$tmp/accounts.json" || fail 'could not read the quota replies'

state='{}'
if [ -s "$stateDir/state.json" ] && jq -e 'type == "object"' "$stateDir/state.json" >/dev/null 2>&1; then state=$(cat "$stateDir/state.json"); fi
jq -n -c --slurpfile cfg "$dir/quota-alert.json" --slurpfile accts "$tmp/accounts.json" --argjson state "$state" --argjson now "$now" \
  -f "$dir/quota-evaluate.jq" > "$tmp/result.json" || fail 'could not evaluate the quota'

notify=1
lines=$(jq '.lines | length' "$tmp/result.json")
if [ "$lines" -gt 0 ]; then
  jq -c '{username: "2server quota alert", content: (.lines | join("\n") | .[0:1900]), allowed_mentions: {parse: []}}' "$tmp/result.json" > "$tmp/payload"
  code=$(curl -sS --max-time 20 -K "$dir/quota-alert.webhook.conf" -H 'Content-Type: application/json' --data-binary "@$tmp/payload" -o /dev/null -w '%{http_code}' 2>/dev/null) || code=000
  case "$code" in 2??) ;; *) notify=0 ;; esac
fi
{
  jq -r '.metrics' "$tmp/result.json"
  printf 'two_cliproxy_quota_alert_notify_ok{app="%s"} %s\n' "$app" "$notify"
} > "$tmp/ok.prom"
publish "$tmp/ok.prom"
if [ "$notify" = 0 ]; then
  echo "quota alert: Discord answered $code; state kept so the next run retries" >&2
  exit 1
fi
mkdir -p "$stateDir"
jq '.state' "$tmp/result.json" > "$stateDir/.state.tmp"
mv -f "$stateDir/.state.tmp" "$stateDir/state.json"
echo "quota alert: $(jq 'length' "$tmp/accounts.json") account(s) checked, $lines message line(s) sent"
`;

// String.raw still interpolates a literal dollar-brace, so the script spells
// shell parameter expansion as "$@{" and it is restored here.
function fill(template: string, values: Record<string, string>): string {
  return template.replaceAll('$@{', '$' + '{').replace(/@@([A-Z_]+)@@/g, (_m, key: string) => {
    if (!(key in values)) throw new Error(`Unfilled quota alert placeholder ${key}`);
    return values[key];
  });
}

export function quotaAlertScript(c: Config, port: number): string {
  return fill(SCRIPT, {
    DIR: quote(`${extensionRoot('cliproxy', c)}/current`),
    STATE_DIR: quote(quotaAlertStateDir(c)),
    METRICS: quote(quotaAlertMetrics(c)),
    CONTAINER: quote(extensionProject(c, 'cliproxy')),
    OWNER: quote(c.name),
    APP: quote(instanceName(c, 'cliproxy')),
    LOCK: quote(`/var/lock/2server-${instanceName(c, 'cliproxy')}-quota-alert.lock`),
    PORT: String(port),
  });
}

export function quotaAlertUnits(c: Config, q: QuotaAlert): {service: string; timer: string} {
  const root = extensionRoot('cliproxy', c), state = quotaAlertStateDir(c), unit = quotaAlertUnit(c);
  return {
    service: `[Unit]
Description=2server cliproxy quota alert (${c.name}/${instanceName(c, 'cliproxy')})
After=docker.service network-online.target
[Service]
Type=oneshot
UMask=0077
ExecStart=/bin/bash ${root}/current/quota-alert.sh
TimeoutStartSec=120
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=${state} /opt/2server/metrics /run/lock
`,
    timer: `[Unit]
Description=2server cliproxy quota alert schedule (${instanceName(c, 'cliproxy')})
[Timer]
OnBootSec=90s
OnUnitActiveSec=${q.intervalMinutes}min
RandomizedDelaySec=15s
Unit=${unit}.service
[Install]
WantedBy=timers.target
`,
  };
}

// Release files. Secrets are passed in (resolved by hooks.ts) and land only in
// the two curl config files, which prepareRelease makes root-only 0400.
export function quotaAlertFiles(c: Config, q: QuotaAlert, port: number, secrets: {managementKey: string; webhookUrl: string}): Record<string, string> {
  if (!SAFE_KEY.test(secrets.managementKey)) throw new Error('Management key contains characters unsafe for a curl config');
  const webhook = checkWebhook(secrets.webhookUrl), units = quotaAlertUnits(c, q);
  return {
    'quota-alert.sh': quotaAlertScript(c, port),
    'quota-alert.json': JSON.stringify(quotaAlertConfig(c, q)) + '\n',
    'quota-targets.jq': TARGETS_JQ,
    'quota-accounts.jq': ACCOUNTS_JQ,
    'quota-evaluate.jq': QUOTA_EVALUATE_JQ,
    'quota-alert.service': units.service,
    'quota-alert.timer': units.timer,
    'quota-alert.mgmt.conf': `header = ${JSON.stringify('Authorization: Bearer ' + secrets.managementKey)}\n`,
    'quota-alert.webhook.conf': `url = ${JSON.stringify(webhook)}\n`,
  };
}

export function quotaAlertPrepareRelease(release: string): string {
  return QUOTA_ALERT_SECRET_FILES
    .map(f => `chown 0:0 ${quote(`${release}/${f}`)} && chmod 0400 ${quote(`${release}/${f}`)}`)
    .join('\n');
}

const removeUnits = (c: Config) => {
  const unit = quotaAlertUnit(c);
  return `systemctl disable --now ${unit}.timer 2>/dev/null || true
systemctl stop ${unit}.service 2>/dev/null || true
rm -f /etc/systemd/system/${unit}.service /etc/systemd/system/${unit}.timer ${quote(quotaAlertMetrics(c))}`;
};

// Runs after every deploy: installs the units when enabled, removes them (and
// the metrics file) when the option is absent. Idempotent.
export function quotaAlertInstall(c: Config, q: QuotaAlert | undefined): string {
  const unit = quotaAlertUnit(c);
  if (!q) return `if [ -e /etc/systemd/system/${unit}.timer ]; then
${removeUnits(c)}
systemctl daemon-reload
fi`;
  const root = extensionRoot('cliproxy', c);
  return `install -d -m 700 ${quote(quotaAlertStateDir(c))}
install -d -m 755 /opt/2server/metrics
install -m 644 ${quote(root + '/current/quota-alert.service')} /etc/systemd/system/${unit}.service
install -m 644 ${quote(root + '/current/quota-alert.timer')} /etc/systemd/system/${unit}.timer
systemctl daemon-reload
systemctl enable ${unit}.timer
systemctl restart ${unit}.timer
# A failing first run (for example a wrong webhook) must not fail the deploy; the timer retries.
systemctl start ${unit}.service || echo 'quota alert: first run failed; see journalctl -u ${unit}' >&2`;
}

export const quotaAlertTeardown = (c: Config) => removeUnits(c);
