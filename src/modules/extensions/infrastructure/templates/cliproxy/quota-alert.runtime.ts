// The cliproxy quotaAlert program. It runs ONLY inside its own sidecar
// container (distroless Bun image: no shell, uid 65533, read-only root, no
// capabilities), never on the VM host. Only this file is mounted, so it imports
// nothing but Node builtins; 2server renders its config (quota-alert.ts).
//
// Threat model: everything read from the gateway's management API (account
// files, relayed upstream replies) is attacker-controlled once the gateway is
// compromised. It is parsed as data only, every value printed to Discord is
// either built from validated numbers or shown inside an inline code span with
// control, bidi and backtick characters removed, mentions are disabled, and
// response bodies are size- and time-bounded. The secrets this process holds
// (management key, webhook URL) are never logged or posted.
import { readFile, rename, writeFile } from 'node:fs/promises';

export type Config = {
  app: string;
  baseUrl: string;
  models?: string[];
  thresholdPercent: number;
  repageSeconds: number;
  intervalSeconds: number;
  gatewayFailures: number;
  antigravity: {models: string[]; endpoint: string; endpointPattern: string; userAgent: string};
  codex: {model: string; url: string; userAgent: string};
};
export type Secrets = {managementKey: string; webhookUrl: string};
export type Quota = {model: string; remainingPercent: number; resetTime: string | null};
export type Account = {
  name: string; provider: string; label: string | null; status: string | null;
  disabled: boolean; unavailable: boolean; cooldowns: number; error: string | null; quotas: Quota[];
};
export type Step = {low: boolean; at: number; since: number; streak?: number};
export type State = {keys: Record<string, Step>; updated?: number};
export type Probe = {name: string; http: number; reply: unknown};
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export const PATHS = {
  config: '/etc/quota-alert/config.json',
  secrets: '/run/secrets/quota-alert.json',
  state: '/state/state.json',
  heartbeat: '/state/heartbeat',
};
const MAX_BODY = 4 << 20;
const CALL_TIMEOUT_MS = 30_000;
const CYCLE_BUDGET_MS = 100_000;
const WEBHOOK = /^https:\/\/(?:(?:ptb\.|canary\.)?discord(?:app)?\.com)\/api\/webhooks\/[0-9]{5,25}\/[A-Za-z0-9_-]{20,200}$/;

const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const str = (v: unknown): string | undefined => typeof v === 'string' && v !== '' ? v : undefined;
const int = (v: unknown): number => typeof v === 'number' && Number.isInteger(v) ? v : 0;
const finite = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const parse = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return undefined; }
};

// Untrusted text for Discord: one line, no backticks, control or bidi
// characters, bounded, always inside a code span so markdown and links do not render.
export const code = (v: unknown, max = 80) =>
  '`' + (String(v ?? '').replace(/[`\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ').trim().slice(0, max) || '?') + '`';

// ---- probes: the same questions `app NAME quota` asks (cli.ts fetchQuotas) ----

export function targets(files: unknown, cfg: Config): Array<{name: string; req: Record<string, unknown>}> {
  const list = Array.isArray(obj(files)?.files) ? obj(files)!.files as unknown[] : [];
  const out = [];
  for (const raw of list) {
    const f = obj(raw), name = str(f?.name), authIndex = f?.auth_index;
    if (!f || !name || (typeof authIndex !== 'string' && typeof authIndex !== 'number') || authIndex === '' || f.disabled === true) continue;
    const provider = str(f.provider) ?? str(f.type) ?? '';
    if (provider === 'antigravity') {
      const hinted = str(obj(f.antigravity_capability_hints)?.endpoint);
      const endpoint = hinted && new RegExp(cfg.antigravity.endpointPattern, 'i').test(hinted) ? hinted : cfg.antigravity.endpoint;
      const project = str(f.project_id) ?? str(f.project) ?? '';
      out.push({name, req: {auth_index: authIndex, method: 'POST', url: `${endpoint}/v1internal:fetchAvailableModels`,
        header: {'Authorization': 'Bearer $TOKEN$', 'Content-Type': 'application/json', 'User-Agent': cfg.antigravity.userAgent},
        data: JSON.stringify({project})}});
    } else if (provider === 'codex') {
      const account = str(f.account_id) ?? str(obj(f.id_token)?.chatgpt_account_id);
      out.push({name, req: {auth_index: authIndex, method: 'GET', url: cfg.codex.url,
        header: {'Authorization': 'Bearer $TOKEN$', 'User-Agent': cfg.codex.userAgent, ...(account ? {'Chatgpt-Account-Id': account} : {})}}});
    }
  }
  return out;
}

// Account listing + probe replies -> the shape `app NAME quota` prints. Error
// texts are built from integers only; response bodies never leave this function.
export function accounts(files: unknown, probes: Probe[], cfg: Config): Account[] {
  const list = Array.isArray(obj(files)?.files) ? obj(files)!.files as unknown[] : [];
  const byName = new Map(probes.map(p => [p.name, p]));
  const out: Account[] = [];
  for (const raw of list) {
    const f = obj(raw), name = str(f?.name);
    if (!f || !name) continue;
    const provider = str(f.provider) ?? str(f.type) ?? '';
    const p = byName.get(name);
    let quotas: Quota[] = [], error: string | null = null;
    if (p && p.http !== 200) error = `probe failed (HTTP ${int(p.http)})`;
    else if (p) {
      const reply = obj(p.reply), sc = int(reply?.status_code), body = obj(parse(reply?.body)) ?? {};
      if (provider === 'antigravity') {
        const models = obj(body.models);
        if (sc === 200 && models) {
          for (const key of cfg.antigravity.models) {
            const q = obj(obj(models[key])?.quotaInfo);
            if (!q) continue;
            const fraction = q.remainingFraction === undefined || q.remainingFraction === null ? 0 : finite(q.remainingFraction);
            if (fraction === undefined) continue;
            quotas.push({model: key, remainingPercent: Math.round(fraction * 1000) / 10, resetTime: str(q.resetTime) ?? null});
          }
        } else if (sc >= 400) {
          const details = Array.isArray(obj(body.error)?.details) ? obj(body.error)!.details as unknown[] : [];
          const verify = details.some(d => str(obj(obj(d)?.metadata)?.validation_url));
          error = verify ? `Google account verification required (${sc})` : `HTTP ${sc}`;
        }
      } else if (sc === 200) {
        const w = obj(obj(body.rate_limit)?.primary_window);
        if (w) {
          const used = w.used_percent === undefined || w.used_percent === null ? 0 : finite(w.used_percent);
          const reset = finite(w.reset_at);
          if (used !== undefined) quotas.push({model: cfg.codex.model, remainingPercent: Math.max(0, Math.round((100 - used) * 10) / 10),
            resetTime: reset !== undefined && Math.abs(reset) < 1e11 ? new Date(Math.floor(reset) * 1000).toISOString() : null});
        }
      } else if (sc >= 400) error = `HTTP ${sc}`;
    }
    const cooldowns = Array.isArray(f.cooldowns) ? f.cooldowns
      : Array.isArray(obj(obj(f.runtime_only)?.quota)?.cooldowns) ? obj(obj(f.runtime_only)!.quota)!.cooldowns as unknown[] : [];
    out.push({name, provider, label: str(f.label) ?? null, status: str(f.status) ?? null,
      disabled: f.disabled === true, unavailable: f.unavailable === true, cooldowns: cooldowns.length, error, quotas});
  }
  return out;
}

// ---- the alert state machine: pure (config, data, previous state, now) ----
//   low -> alert once; still low -> silent until repageSeconds; recovered -> one
//   message. A model with no data this run keeps its previous state.

const stamp = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ');
const when = (t: number) => `${stamp(t)} UTC / ${stamp(t + 25200)} Asia/Ho_Chi_Minh`;
const epoch = (s: string | null) => {
  if (!s || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(s)) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.floor(t / 1000) : undefined;
};

function step(prev: Step | undefined, low: boolean, now: number, cfg: Config): {ev: 'low' | 'still' | 'recovered' | null; s: Step} {
  const p = {low: false, at: 0, since: 0, ...prev};
  if (low && !p.low) return {ev: 'low', s: {...p, low: true, at: now, since: now}};
  if (low && now - p.at >= cfg.repageSeconds) return {ev: 'still', s: {...p, low: true, at: now}};
  if (low) return {ev: null, s: p};
  if (p.low) return {ev: 'recovered', s: {...p, low: false, at: 0, since: 0}};
  return {ev: null, s: {...p, low: false, at: 0, since: 0}};
}

export type Result = {state: State; lines: string[]; summary: string};

export function evaluate(cfg: Config, list: Account[], state: State, now: number): Result {
  const prev = state.keys ?? {}, app = code(cfg.app);
  const groups = new Map<string, Array<{rem: number; reset: number | undefined}>>();
  for (const a of list) if (!a.disabled) for (const q of a.quotas) {
    if (cfg.models && !cfg.models.includes(q.model)) continue;
    (groups.get(q.model) ?? groups.set(q.model, []).get(q.model)!).push({rem: q.remainingPercent, reset: epoch(q.resetTime)});
  }
  const keys: Record<string, Step> = {...prev}, lines: string[] = [], summary: string[] = [];
  for (const [model, xs] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const best = Math.max(...xs.map(x => x.rem)), zero = xs.filter(x => x.rem <= 0).length;
    const resets = xs.map(x => x.reset).filter((t): t is number => t !== undefined), reset = resets.length ? Math.min(...resets) : undefined;
    const r = step(prev[`model:${model}`], best <= cfg.thresholdPercent, now, cfg);
    keys[`model:${model}`] = r.s;
    summary.push(`${model}=${best}%`);
    if (r.ev === 'recovered') lines.push(`**RECOVERED** ${code(model)} on ${app}: best remaining ${best}% across ${xs.length} account(s).`);
    else if (r.ev) lines.push(`**${r.ev === 'low' ? 'LOW' : 'STILL LOW'}** ${code(model)} on ${app}: best remaining ${best}% across ${xs.length} account(s), ${zero} at 0%. `
      + (reset !== undefined ? `Earliest reset ${when(reset)}.` : 'Reset time unknown.')
      + (r.ev === 'still' ? ` Low for ${Math.floor((now - r.s.since) / 60)} min.` : ''));
  }
  const bad = list.filter(a => !a.disabled && (a.error !== null || a.status === 'error' || (a.unavailable && a.cooldowns === 0)));
  const disabled = list.filter(a => a.disabled).length;
  const ap = prev.accounts ?? {low: false, at: 0, since: 0, streak: 0};
  // Two consecutive bad probes before paging: one failed upstream call is noise.
  const streak = bad.length ? (ap.streak ?? 0) + 1 : 0;
  const ar = step(ap, streak >= 2 ? true : streak === 1 ? ap.low : false, now, cfg);
  keys.accounts = {...ar.s, streak};
  if (ar.ev === 'recovered') lines.push(`**ACCOUNTS RECOVERED** ${app}: every enabled account is available again.`);
  else if (ar.ev) lines.push(`**ACCOUNTS** ${app}: ${bad.length} account(s) need attention: `
    + bad.slice(0, 10).map(a => `${code(a.label ?? a.name)} (${code(a.provider, 32)}: ${a.error ?? (a.status === 'error' ? 'status error' : 'unavailable')})`).join(', ')
    + (bad.length > 10 ? `, and ${bad.length - 10} more` : '') + '.'
    + (disabled ? ` ${disabled} disabled by the operator.` : ''));
  summary.push(`accounts=${list.length}`, `problem=${bad.length}`);
  return {state: {keys, updated: now}, lines, summary: summary.join(' ')};
}

// The gateway itself: the management API failing `gatewayFailures` runs in a
// row pages once (and re-pages like a low model); the first good run recovers it.
export function evaluateGateway(cfg: Config, state: State, now: number, http: number | null): Result {
  const prev = state.keys ?? {}, g = prev.gateway ?? {low: false, at: 0, since: 0, streak: 0};
  const streak = http === null ? 0 : (g.streak ?? 0) + 1;
  const r = step(g, streak >= cfg.gatewayFailures || (streak > 0 && g.low), now, cfg);
  const lines = r.ev === 'recovered' ? [`**GATEWAY RECOVERED** ${code(cfg.app)}: quota can be read again.`]
    : r.ev ? [`**GATEWAY** ${code(cfg.app)}: cannot read quota for ${streak} run(s); the management API ${http ? `answered HTTP ${int(http)}` : 'is unreachable'}.`] : [];
  return {state: {keys: {...prev, gateway: {...r.s, streak}}, updated: now}, lines, summary: `gateway=${http === null ? 'ok' : http || 'unreachable'}`};
}

// ---- I/O ----

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) { await reader.cancel(); throw new Error('response too large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// HTTP status (0 when unreachable) and parsed JSON body (undefined when not JSON).
async function management(cfg: Config, secrets: Secrets, fetcher: Fetch, method: string, path: string, body?: unknown) {
  try {
    const res = await fetcher(cfg.baseUrl + path, {method, redirect: 'error', signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      headers: {'Authorization': `Bearer ${secrets.managementKey}`, ...(body ? {'Content-Type': 'application/json'} : {})},
      ...(body ? {body: JSON.stringify(body)} : {})});
    return {http: res.status, body: parse(await readCapped(res))};
  } catch {
    return {http: 0, body: undefined};
  }
}

async function post(secrets: Secrets, fetcher: Fetch, lines: string[]): Promise<number> {
  try {
    const res = await fetcher(secrets.webhookUrl, {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({username: '2server quota alert', content: lines.join('\n').slice(0, 1900), allowed_mentions: {parse: []}})});
    await res.body?.cancel();
    return res.status;
  } catch {
    return 0; // The error text can carry the webhook URL; never print it.
  }
}

export async function loadState(path: string): Promise<State> {
  try {
    const s = obj(JSON.parse(await readFile(path, 'utf8')));
    if (s && obj(s.keys)) return s as State;
  } catch { /* first run or unreadable: start clean */ }
  return {keys: {}};
}

async function saveState(path: string, state: State) {
  await writeFile(`${path}.tmp`, JSON.stringify(state));
  await rename(`${path}.tmp`, path);
}

// One run. State advances only after Discord accepted the message, so a failed
// post is retried on the next run.
export async function cycle(cfg: Config, secrets: Secrets, statePath: string, fetcher: Fetch = fetch, now = () => Math.floor(Date.now() / 1000)) {
  const deadline = Date.now() + CYCLE_BUDGET_MS;
  const state = await loadState(statePath);
  const listing = await management(cfg, secrets, fetcher, 'GET', '/auth-files');
  let result: Result;
  if (listing.http !== 200 || !Array.isArray(obj(listing.body)?.files)) {
    result = evaluateGateway(cfg, state, now(), listing.http === 200 ? 502 : listing.http);
  } else {
    const probes: Probe[] = [];
    for (const t of targets(listing.body, cfg)) {
      if (Date.now() > deadline) break; // the rest have no data this run and keep their state
      const call = await management(cfg, secrets, fetcher, 'POST', '/api-call', t.req);
      probes.push({name: t.name, http: call.http, reply: call.body});
    }
    const t = now(), gateway = evaluateGateway(cfg, state, t, null), quota = evaluate(cfg, accounts(listing.body, probes, cfg), gateway.state, t);
    result = {state: quota.state, lines: [...gateway.lines, ...quota.lines], summary: `${gateway.summary} ${quota.summary}`};
  }
  let notified = true, status = 0;
  if (result.lines.length) {
    status = await post(secrets, fetcher, result.lines);
    notified = status >= 200 && status < 300;
  }
  if (notified) await saveState(statePath, result.state);
  return {...result, notified, status};
}

async function healthy(): Promise<boolean> {
  try {
    const cfg = JSON.parse(await readFile(PATHS.config, 'utf8')) as Config;
    const last = Number(await readFile(PATHS.heartbeat, 'utf8'));
    return Date.now() / 1000 - last <= cfg.intervalSeconds + CYCLE_BUDGET_MS / 1000 + 120;
  } catch {
    return false;
  }
}

async function main() {
  if (process.argv.includes('--health')) process.exit(await healthy() ? 0 : 1);
  // PID 1 ignores SIGTERM without a handler.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => process.exit(0));
  const cfg = JSON.parse(await readFile(PATHS.config, 'utf8')) as Config;
  const secrets = JSON.parse(await readFile(PATHS.secrets, 'utf8')) as Secrets;
  if (!WEBHOOK.test(secrets.webhookUrl)) throw new Error('quota alert: the webhook is not a Discord webhook URL');
  for (;;) {
    await writeFile(PATHS.heartbeat, String(Math.floor(Date.now() / 1000)));
    try {
      const r = await cycle(cfg, secrets, PATHS.state);
      console.log(`quota alert: ${r.summary}; ${r.lines.length} line(s)${r.lines.length ? (r.notified ? ' sent' : `, Discord answered ${r.status}; state kept for a retry`) : ''}`);
    } catch (e) {
      console.error(`quota alert: run failed (${e instanceof Error ? e.name : 'error'})`);
    }
    await Bun.sleep(cfg.intervalSeconds * 1000 + Math.floor(Math.random() * 15_000));
  }
}

if (import.meta.main) await main();
