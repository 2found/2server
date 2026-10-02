import {parseData} from "./documents";
import {setVmSecrets} from "./vm-secrets";
import {setup} from './setup';
import { chmod, mkdir, mkdtemp, readdir, lstat, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';
import { configSchema, sshSchema, readConfig, type Config } from './config';
import { remote, quote, run, setSshTransport } from './process';
import { upload } from './edge';
import { operatorState, setSessionState } from './operator-state';
import { resourceOperation } from './resources';
import { controlRoot, controlGuard, controlMutex, controlLockScript, lockOperator } from './control-lock';
export { controlRoot, controlGuard } from './control-lock';

// One control record per VM, matching the existing single edge owner contract.
const id = z.string().uuid();
const statePath = z.string().regex(/^(monitoring-credentials\.json|monitoring\/[a-z][a-z0-9-]{0,47}\/credentials\.json|certificates\/[a-z][a-z0-9-]{0,47}\/pair\.json|compose\/[a-z][a-z0-9-]{0,47}\/template\.json|deployments\/[a-f0-9-]{36}\.json)$/);
const secretValue = z.string().max(65536).refine(v => !/[\r\n\0]/.test(v));
const envSchema = z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), secretValue);
const snapshotSchema = z.object({
  version: z.literal(1), revision: id, config: configSchema,
  env: envSchema, appSecrets: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),envSchema).optional(), state: z.record(statePath, z.string().max(1024 * 1024)),
}).strict();
type Snapshot = z.infer<typeof snapshotSchema>;
export const controlOperations = { remote, upload, run, setup, saveConnection };
export const controlHelp = `Stateless VM configuration:
  2server server bootstrap -f server.json [--env-file .env] [--apply]  # setup + publish + connect
  2server server publish -f server.json [--env-file .env] [--apply]
  2server connect --ssh user@host [--port 22] [--identity /private/key]
  2server connect --connection connection.yaml  # SSH object (plain SSH or GCP IAP)
  2server get app --ssh user@host
  2server deploy app APP --ssh user@host [--image repository@sha256:...] [--apply]
  2server server env --ssh user@host --env-file secrets.env [--apply]
  2server server config --output .2server/server.json [--ssh user@host]
  2server server backup --ssh user@host --output .2server/server.age --recipient-file /private/recipients.txt
  2server server restore -f replacement.json --backup .2server/server.age --backup-identity /private/age-key [--apply]
  2server server lock [--ssh user@host | --connection FILE | -f server.json]
  2server server unlock --lock-id ID [--apply]  # break exactly the inspected lock
  Use --connection connection.yaml instead of --ssh for GCP IAP or structured SSH.
  connect saves only SSH to .2server/connection.yaml with .gitignore. Other commands auto-discover it.
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
    secretKeys(s.config); // Stored secrets may outlive the checkout that references them.
    return s;
  } catch { throw new Error('Invalid server control snapshot; no values logged'); }
}
// Only manifest secret references are portable. Never ship PATH, cloud login
// sessions, SSH private keys, or arbitrary variables from the operator shell.
export function secretKeys(c: unknown): string[] {
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
  const parsed = envSchema.safeParse(parseEnv(await Bun.file(path).text()));
  if (!parsed.success) throw new Error('Invalid secret file; use uppercase environment keys and single-line values (maximum 65536 characters). Values hidden.');
  return parsed.data; // Never execute or interpolate dotenv input.
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
  await walk('deployments');
  await walk('monitoring-credentials.json');
  await walk('monitoring');
  return result;
}
// The lock is intentionally persistent if the operator dies or SSH is lost.
// Never time-expire it while a Cloudflare/deployment request may still be active.
async function acquire(c: Config, operation: string) {
  const token = crypto.randomUUID();
  try {
    await controlOperations.remote(c, controlLockScript(c, 'acquire', {token, operator: lockOperator(operation)}));
  } catch { throw new Error('Cannot acquire VM control lock: check SSH/ownership, then run server lock; use server unlock --lock-id ID --apply only after confirming the prior operation stopped'); }
  return token;
}
async function release(c: Config, token: string) {
  await controlOperations.remote(c, controlLockScript(c, 'release', {token}));
}
async function fetchSnapshot(c: Config) {
  let raw: string;
  try { raw = await controlOperations.remote(c, `${controlGuard}
${c.name ? `if test -f /opt/2server/edge/owner; then test "$(cat /opt/2server/edge/owner)" = ${quote(c.name)}; fi` : ''}
python3 - <<'PY_PRIVATE_SNAPSHOT'
import os, stat, re
from pathlib import Path
root = Path('${controlRoot}')
target = os.readlink(root / 'current')
if not re.fullmatch(r'revisions/[a-f0-9-]{36}', target):
    raise RuntimeError('Invalid control revision')
for path in [root, root / 'revisions', root / target, root / target / 'snapshot.json']:
    s = path.lstat()
    expected = stat.S_ISREG if path.name == 'snapshot.json' else stat.S_ISDIR
    if not expected(s.st_mode) or s.st_uid != os.geteuid() or s.st_mode & 0o077:
        raise RuntimeError('Control state must be root-only')
print((root / target / 'snapshot.json').read_text())
PY_PRIVATE_SNAPSHOT`); }
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
  await controlOperations.remote(c, controlMutex(`set -euo pipefail
umask 077
test "$(cat ${controlRoot}/lock/token)" = ${quote(token)}
${previous ? `test "$(readlink ${controlRoot}/current)" = revisions/${id.parse(previous)}` : `test ! -e ${controlRoot}/current`}
chmod 700 ${target}
chmod 600 ${target}/snapshot.json ${target}/server.json ${target}/.env
ln -s revisions/${s.revision} ${controlRoot}/next-${s.revision}
mv -Tf ${controlRoot}/next-${s.revision} ${controlRoot}/current`));
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
    for (const name of ['connection.yaml','connection.json']) {
      const file=join(dir,'.2server',name);
      if(await Bun.file(file).exists()) return file;
    }
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
  await privateWrite(join(dir, 'connection.yaml'), Bun.YAML.stringify(ssh,null,2) + '\n');
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
  const value=sshSchema.parse(opts['--connection'] ? parseData(await Bun.file(opts['--connection']).text()) : {
    kind: 'ssh', user, host, port: Number(opts['--port'] ?? 22), identityFile: opts['--identity'],
  });
  if(value.kind==='ssh'&&value.identityFile&&opts['--connection'])value.identityFile=resolve(dirname(resolve(opts['--connection'])),value.identityFile);
  return value;
}
export async function controlCommand(args: string[]): Promise<boolean> {
  if (args[0] === 'server' && ['lock', 'unlock'].includes(args[1])) {
    const {opts, rest} = connectionOptions(args.slice(2));
    const o = options(rest, args[1] === 'lock' ? ['-f'] : ['-f', '--lock-id', '--apply']);
    if (o['--lock-id'] && !/^[a-f0-9]{64}$/.test(o['--lock-id'])) throw new Error('Invalid --lock-id; copy it from server lock');
    if (o['--apply'] && !o['--lock-id']) throw new Error('server unlock --apply requires --lock-id from server lock');
    let c: Config;
    if (o['-f']) {
      if (Object.keys(opts).length) throw new Error('Use an SSH connection OR -f server.json');
      c = await readConfig(o['-f']);
    } else {
      if (!Object.keys(opts).length) {
        const saved = await findConnection();
        if (!saved) throw new Error('No VM connection; use --ssh, --connection or -f server.json');
        opts['--connection'] = saved;
      }
      c = {ssh: await connection(opts)} as Config;
    }
    const action = o['--apply'] ? 'break' : 'inspect';
    let result;
    try {
      result = JSON.parse(await controlOperations.remote(c, controlLockScript(c, action,
        {lockId: o['--lock-id'], operator: lockOperator('server unlock')})));
    } catch { throw new Error('Cannot inspect/break VM control lock; check SSH, ownership and control directory permissions'); }
    if (result.error) throw new Error(result.error);
    console.log(JSON.stringify(result, null, 2));
    if (args[1] === 'unlock' && !o['--apply']) console.log('Dry run. After confirming the prior operator/CI operation stopped, use server unlock --lock-id ID --apply.');
    if (result.unlocked) console.log('Lock archived and released. This does not cancel an in-flight deployment or provider request.');
    return true;
  }
  if (args[0] === 'connect') {
    const {opts, rest} = connectionOptions(args.slice(1));
    if (rest.length) throw new Error('Unexpected connect argument');
    const ssh = await connection(opts);
    const snapshot = await fetchSnapshot({ssh} as Config);
    await saveConnection(ssh);
    console.log(`Connected ${snapshot.config.name}; SSH saved in .2server/connection.yaml (gitignored). Configuration and secrets remain on the VM.`);
    return true;
  }
  if (args[0] === 'server' && args[1] === 'restore') {
    const opts = options(args.slice(2), ['-f', '--backup', '--backup-identity', '--apply']);
    if (!opts['-f'] || !opts['--backup'] || !opts['--backup-identity']) throw new Error('Restore requires -f replacement.json, --backup and --backup-identity');
    const c = await readConfig(opts['-f']);
    const snapshot = validateSnapshot(await controlOperations.run(['age', '--decrypt', '--identity', opts['--backup-identity'], opts['--backup']]));
    if (c.name !== snapshot.config.name) throw new Error('Replacement manifest must keep the original server name');
    if (!opts['--apply']) { console.log(`Restore ${c.name} control state onto the replacement manifest target; pass --apply.`); return true; }
    const token = await acquire(c, 'server restore');
    try {
      await storeSnapshot(c, {...snapshot, revision: crypto.randomUUID(), config: c, env: snapshot.env}, token);
      console.log(`Restored control state for ${c.name}. Review/setup apps and restore database/volume backups separately.`);
    } finally { await release(c, token); }
    return true;
  }
  if (args[0] !== 'server' || !['publish', 'bootstrap'].includes(args[1])) return false;
  const bootstrap = args[1] === 'bootstrap';
  const opts = options(args.slice(2), ['-f', '--env-file', '--apply']);
  if (!opts['-f']) throw new Error(`server ${args[1]} requires -f manifest.json`);
  const c = await readConfig(opts['-f']);
  const env = selectSecrets(c, {...process.env, ...await envFile(opts['--env-file'])});
  const state = await captureState(operatorState(c.name));
  if (bootstrap && (c.apps.length || Object.keys(c.extensionApps).length || c.domains.length || Object.values(c.extensions).some(v => Array.isArray(v) ? v.length : v && (typeof v !== 'object' || Object.keys(v).length))))
    throw new Error('Bootstrap requires an empty server manifest; deploy App/Extension/Domain files after bootstrap. Use server publish for an existing setup.');
  if (!opts['--apply']) {
    console.log(`${bootstrap ? 'Setup Docker/Caddy, publish' : 'Publish'} ${c.name} configuration, ${Object.keys(env).length} referenced secrets and ${Object.keys(state).length} state files to the VM${bootstrap ? ', then save .2server/connection.yaml' : ''}; pass --apply. Offline intent only; SSH/provider access is not checked.`);
    return true;
  }
  const token = await acquire(c, `server ${args[1]}`);
  try {
    if (bootstrap) {
      // Refuse an already published target before changing Docker or Caddy.
      const status = await controlOperations.remote(c, `${controlGuard}\nif test -e ${controlRoot}/current || test -L ${controlRoot}/current; then printf published; else printf new; fi`);
      if (status.trim() !== 'new') throw new Error('VM already has control state; use connect for this server, not bootstrap. No setup performed.');
      await controlOperations.setup(c);
    }
    // Initial publication never overwrites a server already managed by another machine.
    await storeSnapshot(c, {version: 1, revision: crypto.randomUUID(), config: c, env, state}, token);
    console.log(`Published ${c.name} to ${controlRoot}/current. Pass the SSH connection from any machine.`);
  } finally { await release(c, token); }
  if (bootstrap) {
    try { await controlOperations.saveConnection(c.ssh); }
    catch { throw new Error('VM bootstrap succeeded, but saving the local connection failed; use connect --connection FILE with the manifest SSH object. Do not bootstrap again.'); }
    console.log('Server ready; SSH saved in .2server/connection.yaml. Deploy source files with deploy -f FILE --apply.');
  }
  return true;
}

// Classify the operation, not just --apply: read commands may accept that flag
// for compatibility, but must never create revisions or operation history.
export function mutatesControl(args: string[]): boolean {
  if (!args.includes('--apply')) return false;
  const resource = resourceOperation(args);
  if (resource) return !['get', 'describe', 'logs'].includes(resource.verb);
  if (args[0] === 'server') return args[1] === 'env';
  if (args[0] === 'app-action' && args[2] === 'help') return false;
  if (args[0] === 'secret') return ['set', 'delete'].includes(args[1]);
  return ['app-action', 'file-action', 'setup', 'domains', 'deploy', 'rollback', 'extensions'].includes(args[0]);
}

export async function connectedCommand(args: string[], execute: (args: string[]) => Promise<void>, sessionOptions: {lockForImagePull?: boolean} = {}): Promise<boolean> {
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
  const mutate = mutatesControl(rest);
  const operation = resourceOperation(rest);
  // Record only command identity, never arbitrary arguments or secret values.
  const label = operation ? `${operation.verb} ${operation.resource}` : rest[0] === 'server' || rest[0] === 'secret' ? `${rest[0]} ${rest[1]}` : rest[0];
  const token = mutate || sessionOptions.lockForImagePull ? await acquire(transport, label) : undefined;
  let temp: string | undefined;
  let preserve = false;
  const previousEnv = new Map<string, string | undefined>();
  try {
    const snapshot = await fetchSnapshot(transport);
    if(rest[0]==='file-action')console.log(`VM revision: ${snapshot.revision}`);
    if (token && snapshot.revision !== initial.revision) throw new Error('Server changed while acquiring lock; rerun to review the new revision');
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
    const appSecrets=structuredClone(snapshot.appSecrets ?? {});
    // One-time migration from adopted private templates; never export these values.
    for(const app of snapshot.config.apps) {
      if(!app.compose || appSecrets[app.name]) continue;
      const raw=snapshot.state[`compose/${app.name}/template.json`];
      if(raw) {const t=JSON.parse(raw); const color=t['x-2server'].current as 'blue'|'green';
        appSecrets[app.name]={...t.services[app.compose.services[color]].environment};}
    }
    const importedAppSecrets=structuredClone(appSecrets);
    setVmSecrets(appSecrets);
    if(rest[0]==='secret') {
      const action=rest[1];
      if(!['list','set','delete'].includes(action)) throw new Error('Use secret list|set|delete [--app NAME] [--env-file FILE|--key KEY] [--apply]');
      const o=options(rest.slice(2),['--app','--env-file','--key','--apply']);
      const app=o['--app'];
      if(app && !/^[a-z][a-z0-9-]{0,47}$/.test(app)) throw new Error('Invalid app name');
      const values=app ? {...appSecrets[app]} : {...snapshot.env};
      if(action==='list') {
        if(o['--env-file']||o['--key']||o['--apply']) throw new Error('secret list only accepts --app');
        console.log(JSON.stringify({scope:app??'server',keys:Object.keys(values).sort()})); return true;
      }
      if(action==='set') {
        if(!o['--env-file']||o['--key']) throw new Error('secret set requires --env-file; never pass secret values as arguments');
        Object.assign(values,envSchema.parse(await envFile(o['--env-file'])));
      } else {
        if(!o['--key']||o['--env-file']) throw new Error('secret delete requires --key KEY');
        if(!Object.hasOwn(values,o['--key'])) throw new Error('Secret not found');
        const inUse=app ? {...snapshot.config.apps.find(a=>a.name===app)?.secrets,...snapshot.config.extensions.services?.[app]?.secrets,...snapshot.config.extensionApps?.[app]?.secrets} : undefined;
        if(app ? Object.values(inUse??{}).some(s=>s.provider==='vm'&&s.key===o['--key']) : secretKeys(snapshot.config).includes(o['--key']))
          throw new Error('Secret is referenced by deployed configuration; remove the reference first');
        delete values[o['--key']];
      }
      if(mutate && token) {
        if(app) appSecrets[app]=values;
        await storeSnapshot(transport,{...snapshot,revision:crypto.randomUUID(),env:app?snapshot.env:values,appSecrets},token,snapshot.revision);
      }
      console.log(`${action}: ${app??'server'} secrets; values hidden${o['--apply']?' saved.':'; pass --apply to save.'}`);
      return true;
    }

    const appPos=rest.indexOf('--app');
    let secretApp:string|undefined;
    if(appPos>=0 && rest[0]==='server' && rest[1]==='env') {
      secretApp=rest[appPos+1];
      if(!secretApp || !/^[a-z][a-z0-9-]{0,47}$/.test(secretApp)) throw new Error('Invalid secret app name');
      rest.splice(appPos,2);
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
    if(secretApp) {appSecrets[secretApp]={...appSecrets[secretApp],...overrides};overrides={};}
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
    if (mutate && token) {
      const updated = await readConfig(manifest);
      // A failed apply can still have issued certificates. Preserve those while
      // retaining the last successful desired config and secret set.
      const next: Snapshot = {
        version: 1, revision: crypto.randomUUID(),
        config: {...updated, ssh: snapshot.config.ssh},
        env: failure ? snapshot.env : {...snapshot.env,...env},
        appSecrets: failure ? importedAppSecrets : appSecrets,
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
    setVmSecrets();
    setSessionState();
    setSshTransport();
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (temp && !preserve) await rm(temp, {recursive: true, force: true});
    try { if (token) await release(transport, token); }
    catch { throw new Error(`VM lock release failed; inspect /opt/2server/control/lock before retrying.${preserve ? ` Private recovery retained at ${temp}.` : ''}`); }
  }
}
