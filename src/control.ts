import { chmod, mkdir, mkdtemp, readdir, lstat, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';
import { configSchema, sshSchema, readConfig, type Config } from './config';
import { remote, quote, run, setSshTransport } from './process';
import { upload } from './edge';
import { operatorState, setSessionState } from './operator-state';

// One control record per VM, matching the existing single edge owner contract.
export const controlRoot = '/opt/2server/control';
const id = z.string().uuid();
const statePath = z.string().regex(/^(monitoring-credentials\.json|certificates\/[a-z][a-z0-9-]{0,47}\/pair\.json|compose\/[a-z][a-z0-9-]{0,47}\/template\.json)$/);
const secretValue = z.string().max(65536).refine(v => !/[\r\n\0]/.test(v));
const envSchema = z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), secretValue);
const snapshotSchema = z.object({
  version: z.literal(1), revision: id, config: configSchema,
  env: envSchema, state: z.record(statePath, z.string().max(1024 * 1024)),
}).strict();
type Snapshot = z.infer<typeof snapshotSchema>;
export const controlOperations = { remote, upload, run };
export const controlHelp = `Stateless VM configuration:
  2server server publish -f server.json [--env-file .env] [--apply]
  2server connect --ssh user@host [--port 22] [--identity /private/key]
  2server connect --connection connection.json  # SSH object (plain SSH or GCP IAP)
  2server get app --ssh user@host
  2server deploy app APP --ssh user@host [--image repository@sha256:...] [--apply]
  2server server env --ssh user@host --env-file secrets.env [--apply]
  2server server config --output .2server/server.json [--ssh user@host]
  2server server backup --ssh user@host --output .2server/server.age --recipient-file /private/recipients.txt
  2server server restore -f replacement.json --backup .2server/server.age --backup-identity /private/age-key [--apply]
  Use --connection connection.json instead of --ssh for GCP IAP or structured SSH.
  connect saves only SSH to .2server/connection.json with .gitignore. Other commands auto-discover it.
  Config, referenced secrets and cert state are VM-owned.
  Provider provisioning/power/disk/storage changes use the original Terraform/provider workflow.`;

async function privateWrite(file: string, text: string) {
  // A stateless backup/export can create .2server without a prior connect.
  for (let dir = dirname(resolve(file)); dir !== dirname(dir); dir = dirname(dir)) {
    if (basename(dir) !== '.2server') continue;
    await mkdir(dir, {recursive: true, mode: 0o700});
    await chmod(dir, 0o700);
    const ignore = join(dir, '.gitignore');
    if (resolve(file) !== ignore) {
      const prior = await Bun.file(ignore).exists() ? await Bun.file(ignore).text() : '';
      if (prior.trimEnd().split('\n').at(-1) !== '*') await Bun.write(ignore, prior + '\n*\n', {mode: 0o600});
    }
    break;
  }
  await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await Bun.write(temp, text, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, file);
  } finally { await rm(temp, {force: true}); }
}
function validateSnapshot(raw: string): Snapshot {
  if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new Error('Server configuration exceeds 8 MiB');
  try {
    const s = snapshotSchema.parse(JSON.parse(raw));
    const allowed = new Set(secretKeys(s.config));
    if (Object.keys(s.env).some(k => !allowed.has(k))) throw new Error();
    return s;
  } catch { throw new Error('Invalid server control snapshot; no values logged'); }
}
// Only manifest secret references are portable. Never ship PATH, cloud login
// sessions, SSH private keys, or arbitrary variables from the operator shell.
export function secretKeys(c: Config): string[] {
  const keys = new Set<string>();
  function visit(v: unknown) {
    if (!v || typeof v !== 'object') return;
    for (const [key, value] of Object.entries(v)) {
      if (key.endsWith('Env') && typeof value === 'string') keys.add(value);
      if (key === 'provider' && value === 'env') keys.add((v as {key: string}).key);
      if (typeof value === 'object') visit(value);
    }
  }
  visit(c);
  for (const key of keys) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) ||
        /^(PATH|HOME|SHELL|ENV|BASH_ENV|IFS|CDPATH|TMPDIR|NODE_OPTIONS|NODE_PATH|BUN_OPTIONS|BUN_INSPECT|LD_.*|DYLD_.*|GIT_.*|SSH_.*|GCLOUD_.*|CLOUDSDK_.*|AWS_.*|GOOGLE_.*)$/.test(key))
      throw new Error('Secret references cannot override process or cloud credential configuration');
  }
  return [...keys].sort();
}
export function selectSecrets(c: Config, source: Record<string, string | undefined>) {
  const result: Record<string, string> = {};
  for (const key of secretKeys(c)) {
    const value = source[key];
    if (value !== undefined) {
      if (!secretValue.safeParse(value).success) throw new Error(`Invalid single-line secret: ${key}`);
      result[key] = value;
    }
  }
  return result;
}
async function envFile(path?: string) {
  if (!path) return {};
  return Object.fromEntries(Object.entries(parseEnv(await Bun.file(path).text())).filter((entry): entry is [string, string] => entry[1] !== undefined)); // Never execute or interpolate dotenv input.
}
async function captureState(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(prefix: string) {
    const full = join(dir, prefix);
    let info;
    try { info = await lstat(full); } catch (e: any) { if (e.code === 'ENOENT') return; throw e; }
    if (info.isSymbolicLink()) throw new Error('Symlinks are not supported in portable operator state');
    if (info.isDirectory()) {
      for (const entry of await readdir(full)) await walk(prefix ? `${prefix}/${entry}` : entry);
    } else if (statePath.safeParse(prefix).success) {
      if (info.size > 1024 * 1024) throw new Error('Operator state file exceeds 1 MiB');
      result[prefix] = await Bun.file(full).text();
    }
  }
  await walk('certificates');
  await walk('compose');
  await walk('monitoring-credentials.json');
  return result;
}
// remote() always enters through sudo. Refuse a redirected or writable control
// path instead of silently repairing a directory another user could have seeded.
export const controlGuard = `set -euo pipefail
test "$(id -u)" = 0
for directory in /opt/2server ${controlRoot} ${controlRoot}/revisions; do
  test ! -L "$directory"
  if test -e "$directory"; then
    test -d "$directory"
    test -O "$directory"
    unsafe=$(find "$directory" -maxdepth 0 '(' -perm -002 -o -perm -020 ')' -print)
    test -z "$unsafe"
  fi
done`;
// The lock is intentionally persistent if the operator dies or SSH is lost.
// Never time-expire it while a Cloudflare/deployment request may still be active.
async function acquire(c: Config) {
  const token = crypto.randomUUID();
  try {
    await controlOperations.remote(c, `${controlGuard}
umask 077
mkdir -p ${controlRoot}
chmod 700 ${controlRoot}
if test -f /opt/2server/edge/owner; then test "$(cat /opt/2server/edge/owner)" = ${quote(c.name)}; fi
mkdir ${controlRoot}/lock
printf '%s' ${quote(token)} > ${controlRoot}/lock/token`);
  } catch { throw new Error('Cannot acquire VM control lock: check SSH, edge ownership and /opt/2server/control/lock; do not delete a lock held by another operator'); }
  return token;
}
async function release(c: Config, token: string) {
  await controlOperations.remote(c, `set -euo pipefail
test "$(cat ${controlRoot}/lock/token)" = ${quote(token)}
rm -r ${controlRoot}/lock`);
}
async function fetchSnapshot(c: Config) {
  let raw: string;
  try { raw = await controlOperations.remote(c, `${controlGuard}
test -O ${controlRoot}/current/snapshot.json
test ! -L ${controlRoot}/current/snapshot.json
cat ${controlRoot}/current/snapshot.json`); }
  catch { throw new Error('Cannot read VM control config; check sudo/SSH, root ownership and permissions, or run server publish once from the original machine'); }
  return validateSnapshot(raw);
}
async function storeSnapshot(c: Config, s: Snapshot, token: string, previous?: string) {
  // Validate before uploading anything; errors must not print secret values.
  validateSnapshot(JSON.stringify(s));
  const target = `${controlRoot}/revisions/${s.revision}`;
  const portable = structuredClone(s);
  if (portable.config.ssh.kind === 'ssh') delete portable.config.ssh.identityFile;
  await controlOperations.upload(c, {
    'snapshot.json': JSON.stringify(portable),
    'server.json': JSON.stringify(portable.config, null, 2) + '\n',
    '.env': '# Managed by 2server; update with server env, never source in a shell.\n' +
      Object.entries(s.env).map(([k,v]) => `${k}=${JSON.stringify(v)}`).join('\n') + '\n',
  }, target);
  await controlOperations.remote(c, `set -euo pipefail
umask 077
test "$(cat ${controlRoot}/lock/token)" = ${quote(token)}
${previous ? `test "$(readlink ${controlRoot}/current)" = revisions/${id.parse(previous)}` : `test ! -e ${controlRoot}/current`}
chmod 700 ${target}
chmod 600 ${target}/snapshot.json ${target}/server.json ${target}/.env
ln -s revisions/${s.revision} ${controlRoot}/next-${s.revision}
mv -Tf ${controlRoot}/next-${s.revision} ${controlRoot}/current`);
}
function options(args: string[], allowed: string[]) {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!allowed.includes(flag) || flag in result) throw new Error('Unknown or duplicate connection option; use help');
    if (flag === '--apply') result[flag] = 'true';
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing ${flag}`);
      result[flag] = value;
    }
  }
  return result;
}
export async function findConnection(start = process.cwd()): Promise<string | undefined> {
  let dir = resolve(start);
  for (;;) {
    const file = join(dir, '.2server', 'connection.json');
    if (await Bun.file(file).exists()) return file;
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}
export async function saveConnection(ssh: Config['ssh'], dir = join(process.cwd(), '.2server')) {
  await mkdir(dir, {recursive: true, mode: 0o700});
  await chmod(dir, 0o700);
  // Ignore the whole operator directory, including encrypted backups and this file.
  await privateWrite(join(dir, '.gitignore'), '*\n');
  await privateWrite(join(dir, 'connection.json'), JSON.stringify(ssh, null, 2) + '\n');
}
function connectionOptions(args: string[]) {
  const flags = ['--ssh', '--port', '--identity', '--connection'];
  const rest: string[] = [], conn: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (flags.includes(args[i])) conn.push(args[i], args[++i]);
    else rest.push(args[i]);
  }
  return {opts: options(conn, flags), rest};
}
async function connection(opts: Record<string, string>) {
  if (!!opts['--ssh'] === !!opts['--connection']) throw new Error('Use --ssh user@host OR --connection connection.json');
  if (opts['--connection'] && (opts['--port'] || opts['--identity'])) throw new Error('Put port/identityFile in the connection object');
  const [user, host, extra] = (opts['--ssh'] ?? '').split('@');
  if (opts['--ssh'] && (!user || !host || extra)) throw new Error('Expected --ssh user@host');
  return sshSchema.parse(opts['--connection'] ? await Bun.file(opts['--connection']).json() : {
    kind: 'ssh', user, host, port: Number(opts['--port'] ?? 22), identityFile: opts['--identity'],
  });
}
export async function controlCommand(args: string[]): Promise<boolean> {
  if (args[0] === 'connect') {
    const {opts, rest} = connectionOptions(args.slice(1));
    if (rest.length) throw new Error('Unexpected connect argument');
    const ssh = await connection(opts);
    const snapshot = await fetchSnapshot({ssh} as Config);
    await saveConnection(ssh);
    console.log(`Connected ${snapshot.config.name}; SSH saved in .2server/connection.json (gitignored). Configuration and secrets remain on the VM.`);
    return true;
  }
  if (args[0] === 'server' && args[1] === 'restore') {
    const opts = options(args.slice(2), ['-f', '--backup', '--backup-identity', '--apply']);
    if (!opts['-f'] || !opts['--backup'] || !opts['--backup-identity']) throw new Error('Restore requires -f replacement.json, --backup and --backup-identity');
    const c = await readConfig(opts['-f']);
    const snapshot = validateSnapshot(await controlOperations.run(['age', '--decrypt', '--identity', opts['--backup-identity'], opts['--backup']]));
    if (c.name !== snapshot.config.name) throw new Error('Replacement manifest must keep the original server name');
    if (!opts['--apply']) { console.log(`Restore ${c.name} control state onto the replacement manifest target; pass --apply.`); return true; }
    const token = await acquire(c);
    try {
      await storeSnapshot(c, {...snapshot, revision: crypto.randomUUID(), config: c, env: selectSecrets(c, snapshot.env)}, token);
      console.log(`Restored control state for ${c.name}. Review/setup apps and restore database/volume backups separately.`);
    } finally { await release(c, token); }
    return true;
  }
  if (args[0] !== 'server' || args[1] !== 'publish') return false;
  const opts = options(args.slice(2), ['-f', '--env-file', '--apply']);
  if (!opts['-f']) throw new Error('server publish requires -f manifest.json');
  const c = await readConfig(opts['-f']);
  const env = selectSecrets(c, {...process.env, ...await envFile(opts['--env-file'])});
  const state = await captureState(operatorState(c.name));
  if (!opts['--apply']) {
    console.log(`Publish ${c.name} configuration, ${Object.keys(env).length} referenced secrets and ${Object.keys(state).length} state files to the VM; pass --apply.`);
    return true;
  }
  const token = await acquire(c);
  try {
    // Initial publication never overwrites a server already managed by another machine.
    await storeSnapshot(c, {version: 1, revision: crypto.randomUUID(), config: c, env, state}, token);
    console.log(`Published ${c.name} to ${controlRoot}/current. Pass the SSH connection from any machine.`);
  } finally { await release(c, token); }
  return true;
}

export async function connectedCommand(args: string[], execute: (args: string[]) => Promise<void>): Promise<boolean> {
  if (!args.includes('--ssh') && !args.includes('--connection')) {
    // Explicit legacy manifests and provider workflows retain their existing meaning.
    if (args.includes('-f') || args.includes('--file') || args[0] === 'provision' || args[1]?.endsWith('.json')) return false;
    const saved = await findConnection();
    if (!saved) return false;
    args = [...args, '--connection', saved];
  }
  const {opts, rest} = connectionOptions(args);
  const ssh = await connection(opts);
  if (rest.includes('-f') || rest.includes('--file')) throw new Error('Use an SSH connection OR a local manifest');
  // A stopped/destroyed VM cannot synchronize its own state. Terraform belongs
  // in a separate durable backend, never a temporary session directory.
  if (rest.slice(0,2).some(v => ['vm', 'vms', 'disk', 'disks', 'backup-storage', 'provision'].includes(v)))
    throw new Error('Provider/VM/disk lifecycle uses the original provider manifest and Terraform state');
  const initial = await fetchSnapshot({ssh} as Config);
  const name = initial.config.name;
  const transport = {name, ssh} as Config;
  const token = await acquire(transport);
  let temp: string | undefined;
  let preserve = false;
  const previousEnv = new Map<string, string | undefined>();
  try {
    const snapshot = await fetchSnapshot(transport);
    if (snapshot.config.name !== name) throw new Error('Server identity changed; reconnect explicitly');
    if (rest[0] === 'server' && rest[1] === 'backup') {
      const backup = options(rest.slice(2), ['--output', '--recipient-file']);
      if (!backup['--output'] || !backup['--recipient-file']) throw new Error('Backup requires --output and --recipient-file');
      const encrypted = await controlOperations.run(['age', '--encrypt', '--armor', '--recipients-file', backup['--recipient-file']], JSON.stringify(snapshot));
      await privateWrite(backup['--output'], encrypted);
      console.log('Encrypted server config/secrets/certificate backup saved. Copy it off this VM; database/volume and Terraform backups are separate.');
      return true;
    }
    if (rest[0] === 'server' && rest[1] === 'config') {
      const exportOptions = options(rest.slice(2), ['--output']);
      if (!exportOptions['--output']) throw new Error('server config requires --output path');
      await privateWrite(exportOptions['--output'], JSON.stringify(snapshot.config, null, 2) + '\n');
      console.log('Server manifest exported privately; secret references are retained, secret values are excluded.');
      return true;
    }
    const envPos = rest.indexOf('--env-file');
    let overrides: Record<string, string> = {};
    if (envPos >= 0) {
      if (!rest[envPos + 1]) throw new Error('Missing --env-file path');
      overrides = await envFile(rest[envPos + 1]);
      rest.splice(envPos, 2);
    }
    const c = snapshot.config;
    let secretConfig = c;
    const specPos = rest.indexOf('--spec');
    // Permit secrets introduced by an app/extension spec in this same operation.
    if (specPos >= 0) {
      const spec = await Bun.file(rest[specPos + 1]).json();
      // secretKeys scans references only; validation of the full resource stays in dispatch.
      secretConfig = {...c, pendingSpec: spec} as Config;
    }
    const keys = secretKeys(secretConfig);
    if (Object.keys(overrides).some(k => !keys.includes(k))) throw new Error('--env-file contains keys not referenced by this manifest/spec');
    const env = selectSecrets(secretConfig, {...snapshot.env, ...overrides});
    for (const key of keys) {
      previousEnv.set(key, process.env[key]);
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key]; // Server values win over stale machine-local .env.
    }
    temp = await mkdtemp(join(tmpdir(), '2server-session-'));
    await chmod(temp, 0o700);
    const state = join(temp, 'state');
    await mkdir(state, {mode: 0o700});
    for (const [path, value] of Object.entries(snapshot.state)) await privateWrite(join(state, path), value);
    const manifest = join(temp, 'server.json');
    await privateWrite(manifest, JSON.stringify(c));
    setSessionState(state);
    setSshTransport(ssh);
    let failure: unknown;
    try {
      if (rest[0] === 'server' && rest[1] === 'env') {
        if (envPos < 0 || rest.slice(2).some(v => v !== '--apply')) throw new Error('server env requires --env-file and optional --apply');
        console.log(rest.includes('--apply') ? 'Referenced server secrets updated.' : 'Secret update validated; pass --apply to save.');
      } else {
        const legacy = ['validate','plan','setup','domains','deploy','rollback','extensions','verify','status'].includes(rest[0]) && (rest.length === 1 || rest[1]?.startsWith('--'));
        await execute(legacy ? [rest[0], manifest, ...rest.slice(1)] : [...rest, '-f', manifest]);
      }
    } catch (e) { failure = e; }
    if (rest.includes('--apply')) {
      const updated = await readConfig(manifest);
      // A failed apply can still have issued certificates. Preserve those while
      // retaining the last successful desired config and secret set.
      const next: Snapshot = {
        version: 1, revision: crypto.randomUUID(),
        config: {...updated, ssh: snapshot.config.ssh},
        env: failure ? snapshot.env : selectSecrets(updated, env),
        state: await captureState(state),
      };
      try { await storeSnapshot(transport, next, token, snapshot.revision); }
      catch {
        preserve = true;
        await privateWrite(join(temp, 'recovery-snapshot.json'), JSON.stringify(next));
        throw new Error(`VM state save failed; operation may have applied. Private recovery retained at ${temp}; inspect before retrying.`);
      }
    }
    if (failure) throw failure;
    return true;
  } finally {
    setSessionState();
    setSshTransport();
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (temp && !preserve) await rm(temp, {recursive: true, force: true});
    try { await release(transport, token); }
    catch { throw new Error(`VM lock release failed; inspect /opt/2server/control/lock before retrying.${preserve ? ` Private recovery retained at ${temp}.` : ''}`); }
  }
}
