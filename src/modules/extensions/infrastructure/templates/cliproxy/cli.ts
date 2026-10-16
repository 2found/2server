import { lstat,readFile } from 'node:fs/promises';
import { basename,resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { quote,ssh } from '../../../../../shared/infrastructure/process';
import type { Config } from '../../../../config/application/config';
import { instanceName } from '../../../domain/instance';
import { CLIPROXY_PORT,clientKey,cliproxyContainer,managementKey } from './hooks';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
type Reply = {status: number; body: unknown};
const MAX_FILE = 1024 * 1024;
const ANTIGRAVITY_QUOTA_MODELS: Array<[string, string]> = [
  ['gemini-3.8-flash-high', 'Gemini 3.8 Flash'],
  ['claude-sonnet-5-5-high', 'Claude Sonnet 5.5'],
  ['claude-opus-5-5-high', 'Claude Opus 5.5'],
  ['claude-opus-4-6-thinking', 'Claude Opus 4.6 Thinking'],
  ['gpt-oss-120b-medium', 'GPT-OSS 120B'],
];

const cooldownItemSchema = z.object({
  model_key: z.string().optional(),
  scope: z.string().optional(),
  reason: z.string().optional(),
  remaining_seconds: z.number().optional(),
  retry_at: z.string().optional(),
});

const authFileSchema = z.object({
  name: z.string().optional(),
  provider: z.string().optional(),
  type: z.string().optional(),
  label: z.string().optional(),
  status: z.string().optional(),
  status_message: z.string().optional(),
  plan_type: z.string().optional(),
  priority: z.number().optional(),
  disabled: z.boolean().optional(),
  unavailable: z.boolean().optional(),
  auth_index: z.string().optional(),
  project_id: z.string().optional(),
  project: z.string().optional(),
  account_id: z.string().optional(),
  success: z.number().optional(),
  failed: z.number().optional(),
  cooldowns: z.array(cooldownItemSchema).nullish(),
  antigravity_capability_hints: z.object({endpoint: z.string().optional()}).optional(),
  id_token: z.object({chatgpt_account_id: z.string().optional()}).nullish(),
  runtime_only: z.union([
    z.boolean(),
    z.object({
      requests: z.object({success: z.number().optional(), failed: z.number().optional()}).optional(),
      quota: z.object({cooldowns: z.array(cooldownItemSchema).nullish()}).optional(),
    }),
  ]).optional(),
});
type AuthFileRecord = z.infer<typeof authFileSchema>;

const managementEnvelopeSchema = z.object({
  status: z.string().optional(),
  error: z.string().optional(),
  message: z.string().optional(),
  url: z.string().optional(),
  state: z.string().optional(),
  user_code: z.string().optional(),
  status_code: z.number().optional(),
  body: z.unknown().optional(),
  files: z.array(z.unknown()).optional(),
});

const antigravityModelsSchema = z.object({
  models: z.record(z.string(), z.object({
    displayName: z.string().optional(),
    quotaInfo: z.object({
      remainingFraction: z.number().optional(),
      resetTime: z.string().optional(),
    }).optional(),
  })).optional(),
  error: z.object({
    message: z.string().optional(),
    details: z.array(z.object({
      metadata: z.object({validation_url: z.string().optional()}).optional(),
    })).optional(),
  }).optional(),
});

const codexUsageSchema = z.object({
  plan_type: z.string().optional(),
  rate_limit: z.object({
    primary_window: z.object({
      used_percent: z.number().optional(),
      reset_at: z.number().optional(),
    }).optional(),
  }).optional(),
});

const modelsListSchema = z.object({
  data: z.array(z.object({id: z.string().nullish()}).passthrough()).nullish(),
});

const importedAuthSchema = z.object({
  type: z.string(),
});
// One HTTP request to the runtime, made from the VM inside the container's
// network namespace (the management API refuses non-loopback clients). The
// key and body arrive on stdin and are written to a private temp dir, so
// neither appears in argv or the process list. Mutations hold the instance's
// extension lock, so they never interleave with a deploy of the same app.
export function requestScript(c: Config, method: Method, path: string, body: boolean, mutate: boolean): string {
  if (!/^\/[A-Za-z0-9/._~%?=&-]*$/.test(path)) throw new Error('Unsupported request path');
  const container = quote(cliproxyContainer(c));
  return `set -euo pipefail
test "$(cat /opt/2server/edge/owner)" = ${quote(c.name)}
test "$(docker inspect -f '{{index .Config.Labels "io.2server.owner"}}' ${container} 2>/dev/null)" = ${quote(c.name)} || { echo 'cliproxy is not running on this server' >&2; exit 3; }
${mutate ? `exec 7>/var/lock/2server-extension-${instanceName(c, "cliproxy")}.lock
flock -w 30 7` : ''}
pid=$(docker inspect -f '{{.State.Pid}}' ${container})
test "$pid" -gt 0 || { echo 'cliproxy is not running' >&2; exit 3; }
umask 077
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
IFS= read -r key
cat > "$t/body"
printf 'header = "Authorization: Bearer %s"\\n' "$key" > "$t/curl.conf"
code=$(nsenter -t "$pid" -n curl -sS --max-time 30 -X ${method} -K "$t/curl.conf" ${body ? `-H 'Content-Type: application/json' --data-binary @"$t/body"` : ''} -o "$t/out" -w '%{http_code}' ${quote(`http://127.0.0.1:${CLIPROXY_PORT}${path}`)})
printf '%s\\n' "$code"
head -c ${MAX_FILE} "$t/out"`;
}

export const transport = {
  async request(c: Config, key: string, method: Method, path: string, body?: unknown, mutate = false): Promise<Reply> {
    const payload = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    const out = await ssh(c, `sudo -n bash -c ${quote(requestScript(c, method, path, body !== undefined, mutate))}`, `${key}\n${payload}`);
    const newline = out.indexOf('\n'), status = Number(newline < 0 ? out : out.slice(0, newline)), text = newline < 0 ? '' : out.slice(newline + 1);
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return {status, body: parsed};
  },
  sleep: (ms: number) => Bun.sleep(ms),
};

function failure(reply: Reply, c: Config): never {
  const parsed = managementEnvelopeSchema.safeParse(reply.body);
  const message = parsed.success ? String(parsed.data.error ?? parsed.data.message ?? '') : String(reply.body);
  if (reply.status === 401) throw new Error(`cliproxy rejected the key; after secret set, redeploy app ${c.instance?.name ?? 'cliproxy'} so the runtime reads it`);
  throw new Error(`cliproxy answered ${reply.status || 'nothing'}${message ? `: ${message.slice(0, 200)}` : ''}`);
}
async function management(c: Config, method: Method, path: string, body?: unknown, mutate = false) {
  const reply = await transport.request(c, managementKey(c), method, '/v0/management' + path, body, mutate);
  if (reply.status < 200 || reply.status > 299) failure(reply, c);
  const parsed = managementEnvelopeSchema.safeParse(reply.body);
  return parsed.success ? parsed.data : {};
}

// Account listings carry labels, throughput, and cooldown state, never token material.
function account(f: AuthFileRecord) {
  const message = f.status_message ? f.status_message.slice(0, 160) : undefined;
  const planType = f.plan_type ? f.plan_type.slice(0, 64) : undefined;
  const rt = typeof f.runtime_only === 'object' ? f.runtime_only : undefined;
  const reqSuccess = f.success ?? rt?.requests?.success ?? 0;
  const reqFailed = f.failed ?? rt?.requests?.failed ?? 0;
  const rawCooldowns = f.cooldowns ?? rt?.quota?.cooldowns ?? [];
  const cooldowns = rawCooldowns.map(c => ({
    model: String(c.model_key || c.scope || 'account'),
    reason: String(c.reason || 'quota'),
    remainingSeconds: c.remaining_seconds ?? 0,
    ...(c.retry_at ? {retryAt: c.retry_at} : {}),
  }));
  return {
    name: f.name,
    provider: f.provider ?? f.type,
    label: f.label || undefined,
    status: f.status,
    ...(planType ? {planType} : {}),
    ...(message ? {message} : {}),
    ...(typeof f.priority === 'number' && f.priority ? {priority: f.priority} : {}),
    ...(reqSuccess > 0 || reqFailed > 0 ? {success: reqSuccess, failed: reqFailed} : {}),
    ...(cooldowns.length ? {cooldowns} : {}),
    disabled: !!f.disabled,
    unavailable: !!f.unavailable,
  };
}
async function rawAuthFiles(c: Config): Promise<AuthFileRecord[]> {
  const body = await management(c, 'GET', '/auth-files');
  const list = Array.isArray(body.files) ? body.files : [];
  const out: AuthFileRecord[] = [];
  for (const item of list) {
    const p = authFileSchema.safeParse(item);
    if (p.success) out.push(p.data);
    else if (item && typeof item === 'object' && typeof (item as {name?: unknown}).name === 'string')
      out.push({name: (item as {name: string}).name});
  }
  return out;
}
async function accounts(c: Config) {
  return (await rawAuthFiles(c)).map(account);
}

function parseJsonUnknown(raw: unknown): unknown {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return undefined; }
  }
  return raw;
}

async function fetchQuotas(c: Config, targetAccount?: string) {
  const app = c.instance?.name ?? 'cliproxy';
  const files = await rawAuthFiles(c);
  const selected = targetAccount
    ? files.filter(f => f.name === accountName(targetAccount))
    : files;
  if (targetAccount && !selected.length) throw new Error(`Account ${targetAccount} not found; see app ${app} accounts`);

  const results = [];
  for (const f of selected) {
    const base = account(f);
    const authIndex = f.auth_index || undefined;
    const provider = String(f.provider ?? f.type ?? '');
    const quotas: Array<{model: string; label: string; remainingPercent: number; resetTime?: string}> = [];
    let validationUrl: string | undefined;
    let probeError: string | undefined;
    let planType = base.planType;

    if (authIndex && !f.disabled && provider === 'antigravity') {
      const rawEndpoint = f.antigravity_capability_hints?.endpoint;
      const endpoint = rawEndpoint && /^https:\/\/[a-z0-9.-]+$/i.test(rawEndpoint)
        ? rawEndpoint
        : 'https://daily-cloudcode-pa.googleapis.com';
      const project = f.project_id || f.project || '';
      try {
        const call = await management(c, 'POST', '/api-call', {
          auth_index: authIndex,
          method: 'POST',
          url: `${endpoint}/v1internal:fetchAvailableModels`,
          header: {
            'Authorization': 'Bearer $TOKEN$',
            'Content-Type': 'application/json',
            'User-Agent': 'antigravity/hub/2.9.1',
          },
          data: JSON.stringify({project}),
        });
        const parsed = antigravityModelsSchema.safeParse(parseJsonUnknown(call.body));
        if (call.status_code === 200 && parsed.success && parsed.data.models) {
          const modelsObj = parsed.data.models;
          for (const [modelKey, label] of ANTIGRAVITY_QUOTA_MODELS) {
            const q = modelsObj[modelKey]?.quotaInfo;
            if (!q) continue;
            const frac = q.remainingFraction ?? 0;
            quotas.push({
              model: modelKey,
              label,
              remainingPercent: Math.round(frac * 1000) / 10,
              ...(q.resetTime ? {resetTime: q.resetTime} : {}),
            });
          }
        } else if (typeof call.status_code === 'number' && call.status_code >= 400) {
          const errObj = parsed.success ? parsed.data.error : undefined;
          for (const d of errObj?.details ?? []) {
            if (d.metadata?.validation_url) validationUrl = d.metadata.validation_url;
          }
          const errMsg = errObj?.message ? errObj.message.slice(0, 160) : `HTTP ${call.status_code}`;
          probeError = validationUrl ? `Google account verification required (${call.status_code})` : `${call.status_code}: ${errMsg}`;
        }
      } catch (err) {
        probeError = err instanceof Error ? err.message.slice(0, 160) : 'probe failed';
      }
    } else if (authIndex && !f.disabled && provider === 'codex') {
      const accountId = f.account_id || f.id_token?.chatgpt_account_id || undefined;
      try {
        const call = await management(c, 'POST', '/api-call', {
          auth_index: authIndex,
          method: 'GET',
          url: 'https://chatgpt.com/backend-api/wham/usage',
          header: {
            'Authorization': 'Bearer $TOKEN$',
            'User-Agent': 'codex_cli_agent/0.1.0',
            ...(accountId ? {'Chatgpt-Account-Id': accountId} : {}),
          },
        });
        const parsed = codexUsageSchema.safeParse(parseJsonUnknown(call.body));
        if (call.status_code === 200 && parsed.success) {
          if (parsed.data.plan_type) planType = parsed.data.plan_type;
          const primary = parsed.data.rate_limit?.primary_window;
          if (primary) {
            const used = primary.used_percent ?? 0;
            quotas.push({
              model: 'codex-primary',
              label: `Codex Primary Window${planType ? ` (${planType})` : ''}`,
              remainingPercent: Math.max(0, Math.round((100 - used) * 10) / 10),
              ...(typeof primary.reset_at === 'number' ? {resetTime: new Date(primary.reset_at * 1000).toISOString()} : {}),
            });
          }
        } else if (typeof call.status_code === 'number' && call.status_code >= 400) {
          probeError = `HTTP ${call.status_code}`;
        }
      } catch (err) {
        probeError = err instanceof Error ? err.message.slice(0, 160) : 'probe failed';
      }
    }
    results.push({
      ...base,
      ...(planType ? {planType} : {}),
      ...(validationUrl ? {validationUrl} : {}),
      ...(probeError ? {error: probeError} : {}),
      quotas,
    });
  }
  return results;
}
const PROVIDERS: Record<string, string> = {codex: 'codex', antigravity: 'antigravity', claude: 'anthropic', xai: 'xai', kimi: 'kimi'};
function accountName(value: string | undefined): string {
  if (!value || value.length > 200 || /[/\\\x00-\x1f\x7f]/.test(value) || !value.endsWith('.json')) throw new Error('Name an account as listed by accounts (a .json file name)');
  return value;
}
function only(args: string[], allowed: number, usage: string) {
  const rest = args.filter(a => a !== '--apply');
  if (rest.length !== allowed || args.filter(a => a === '--apply').length > 1 || rest.some(a => a.startsWith('-'))) throw new Error(`Use ${usage}`);
  return rest;
}

// The provider redirects the browser to http://localhost:PORT/...; listen
// there on this machine and forward the redirect to the runtime. If the port
// is taken, or the browser runs elsewhere, paste the address bar instead.
async function captureRedirect(authUrl: string): Promise<string> {
  const redirect = new URL(authUrl).searchParams.get('redirect_uri');
  const target = redirect ? new URL(redirect) : undefined;
  const servers: Array<{stop(force?: boolean): void}> = [];
  let input: ReturnType<typeof createInterface> | undefined;
  try {
    return await new Promise<string>((done, fail) => {
      if (target && ['localhost', '127.0.0.1'].includes(target.hostname) && target.port) {
        for (const hostname of ['127.0.0.1', '::1']) {
          try {
            servers.push(Bun.serve({hostname, port: Number(target.port), fetch(request) {
              const url = new URL(request.url);
              if (url.pathname !== target.pathname || !url.searchParams.get('state')) return new Response('Not found', {status: 404, headers: {connection: 'close'}});
              // Resolve after this response is flushed, so the tab shows it.
              setTimeout(() => done(`${target.origin}${url.pathname}${url.search}`), 50);
              return new Response('Signed in to 2server cliproxy. You can close this tab.', {headers: {connection: 'close'}});
            }}));
          } catch { /* port busy or no IPv6: paste below */ }
        }
      }
      console.error(servers.length
        ? `Waiting for the browser to return to ${target!.origin}. If it opens elsewhere, paste the final address here.`
        : 'After signing in, paste the address the browser ends on (it may show a connection error).');
      if (process.stdin.isTTY || !servers.length) {
        input = createInterface({input: process.stdin});
        input.on('line', line => { const value = line.trim(); if (/^https?:\/\//.test(value)) done(value); });
        input.on('close', () => { if (!servers.length) fail(new Error('No redirect address was provided')); });
      }
      setTimeout(() => fail(new Error('Sign-in timed out after 5 minutes')), 5 * 60_000).unref?.();
    });
  } finally {
    input?.close();
    for (const s of servers) void s.stop();
  }
}
async function waitForLogin(c: Config, state: string) {
  for (let i = 0; i < 165; i++) {
    const status = await management(c, 'GET', `/get-auth-status?state=${encodeURIComponent(state)}`);
    if (status?.status === 'ok') return;
    if (status?.status === 'error') throw new Error(`Sign-in failed: ${String(status.error ?? 'unknown').slice(0, 200)}`);
    await transport.sleep(2000);
  }
  throw new Error('Sign-in did not finish within 5 minutes');
}

async function resetQuotaTargets(c: Config, target: string, apply: boolean) {
  const app = c.instance?.name ?? 'cliproxy';
  const files = await rawAuthFiles(c);
  let matched: AuthFileRecord[];
  if (target === '--all') {
    matched = files.filter(f => account(f).unavailable || (account(f).cooldowns?.length ?? 0) > 0);
  } else {
    const name = accountName(target);
    matched = files.filter(f => f.name === name);
    if (!matched.length) throw new Error(`Account ${name} not found; see app ${app} accounts`);
  }
  const names = matched.map(f => String(f.name)).filter(Boolean);
  if (!apply) {
    console.log(`Reset quota cooldown on ${names.join(', ') || 'none'} on ${app}. Pass --apply.`);
    return null;
  }
  const reset: string[] = [];
  for (const f of matched) {
    if (!f.auth_index || !f.name) continue;
    await management(c, 'POST', '/reset-quota', {auth_index: f.auth_index}, true);
    reset.push(f.name);
  }
  return {status: 'reset', accounts: reset};
}

export async function run(c: Config, command: string, args: string[]) {
  const apply = args.includes('--apply'), app = c.instance?.name ?? 'cliproxy';
  const emit = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  if (command === 'accounts') { only(args, 0, `app ${app} accounts`); emit(await accounts(c)); return; }
  if (command === 'models') {
    only(args, 0, `app ${app} models`);
    const reply = await transport.request(c, clientKey(c, c.extensions.cliproxy!.clientKeyEnv[0]), 'GET', '/v1/models');
    if (reply.status !== 200) failure(reply, c);
    const parsedModels = modelsListSchema.safeParse(reply.body);
    emit((parsedModels.success && parsedModels.data.data ? parsedModels.data.data : []).map(m => m.id).filter((id): id is string => typeof id === 'string').sort());
    return;
  }
  if (command === 'quota') {
    if (args.length > 1 || args.some(a => a.startsWith('-'))) throw new Error(`Use app ${app} quota [ACCOUNT]`);
    emit(await fetchQuotas(c, args[0]));
    return;
  }
  if (command === 'reset-quota') {
    const rest = args.filter(a => a !== '--apply');
    if (rest.length !== 1 || args.length - rest.length > 1 || (rest[0] !== '--all' && rest[0].startsWith('-')))
      throw new Error(`Use app ${app} reset-quota ACCOUNT|--all [--apply]`);
    const out = await resetQuotaTargets(c, rest[0], apply);
    if (out) emit(out);
    return;
  }
  if (command === 'login') {
    const [provider] = only(args, 1, `app ${app} login ${Object.keys(PROVIDERS).join('|')} [--apply]`);
    if (!Object.hasOwn(PROVIDERS, provider)) throw new Error(`Unsupported provider; use ${Object.keys(PROVIDERS).join(', ')}`);
    if (!apply) { console.log(`Sign in a ${provider} account on ${app}: opens a browser flow and stores its tokens on the VM. Pass --apply.`); return; }
    const start = await management(c, 'GET', `/${PROVIDERS[provider]}-auth-url`, undefined, true);
    if (typeof start?.url !== 'string' || typeof start?.state !== 'string') throw new Error('cliproxy did not return a sign-in address');
    console.error(`Open this address in a browser and sign in:\n${start.url}`);
    if (typeof start.user_code === 'string') console.error(`Code: ${start.user_code}`);
    else await management(c, 'POST', '/oauth-callback', {redirect_url: await captureRedirect(start.url)}, true);
    await waitForLogin(c, start.state);
    emit({status: 'signed-in', provider, accounts: (await accounts(c)).filter((a: {provider?: unknown}) => a.provider === PROVIDERS[provider] || a.provider === provider)});
    return;
  }
  if (command === 'import') {
    if (args.filter(a => a !== '--apply').length !== 2 || args[0] !== '--file' || !args[1] || args[1].startsWith('-') || args.filter(a => a === '--apply').length > 1)
      throw new Error(`Use app ${app} import --file PRIVATE_FILE [--apply]`);
    const file = resolve(args[1]), info = await lstat(file);
    if (!info.isFile() || info.size > MAX_FILE) throw new Error('Auth file must be a regular file under 1 MiB');
    if (info.mode & 0o077) throw new Error('Auth file must have private permissions (chmod 600)');
    const name = accountName(basename(file)), text = await readFile(file, 'utf8');
    let rawJson: unknown;
    try { rawJson = JSON.parse(text); } catch { throw new Error('Auth file must be JSON'); }
    const parsed = importedAuthSchema.safeParse(rawJson);
    if (!parsed.success)
      throw new Error('Auth file must be a JSON object with a provider "type"');
    if (!apply) { console.log(`Upload ${name} (${parsed.data.type}) to ${app}; an account with the same name is replaced. Pass --apply.`); return; }
    await management(c, 'POST', `/auth-files?name=${encodeURIComponent(name)}`, text, true);
    emit({status: 'imported', account: name});
    return;
  }
  // Requests go to the highest priority that has a ready account, across
  // channels; lower priorities serve only while every higher one is cooling
  // down or failing. That is how an alias falls back from one model to another.
  if (command === 'priority') {
    // Not only(): a negative priority starts with '-'.
    const rest = args.filter(a => a !== '--apply');
    if (rest.length !== 2 || args.length - rest.length > 1 || rest[0].startsWith('-') || !/^-?\d{1,4}$/.test(rest[1]))
      throw new Error(`Use app ${app} priority ACCOUNT PRIORITY [--apply], PRIORITY an integer from -9999 to 9999 (default 0)`);
    const name = accountName(rest[0]), priority = Number(rest[1]);
    if (!(await accounts(c)).some((a: {name?: unknown}) => a.name === name)) throw new Error(`Account ${name} not found; see app ${app} accounts`);
    if (!apply) { console.log(`Set priority ${priority} on account ${name} on ${app}. Pass --apply.`); return; }
    await management(c, 'PATCH', '/auth-files/fields', {name, priority}, true);
    emit({status: 'updated', account: name, priority});
    return;
  }
  if (command === 'disable' || command === 'enable' || command === 'remove') {
    const name = accountName(only(args, 1, `app ${app} ${command} ACCOUNT [--apply]`)[0]);
    if (!(await accounts(c)).some((a: {name?: unknown}) => a.name === name)) throw new Error(`Account ${name} not found; see app ${app} accounts`);
    if (!apply) { console.log(`${command} account ${name} on ${app}${command === 'remove' ? ' (deletes its tokens)' : ''}. Pass --apply.`); return; }
    if (command === 'remove') await management(c, 'DELETE', '/auth-files', {name}, true);
    else await management(c, 'PATCH', '/auth-files/status', {name, disabled: command === 'disable'}, true);
    emit({status: command === 'remove' ? 'removed' : `${command}d`, account: name});
    return;
  }
  throw new Error('Unknown cliproxy app command');
}
