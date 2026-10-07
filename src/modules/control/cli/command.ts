import { connectionOptions,options } from "../../../shared/cli/control-options";
import { operatorState } from '../../../shared/infrastructure/operator-state';
import { type Config } from '../../config/application/config';
import { readConfig } from '../../config/infrastructure/file';
import { controlOperations } from "../application/operations";
import { acquire,fetchSnapshot,release,storeSnapshot,validateSnapshot } from "../application/snapshot";
import { selectSecrets } from "../domain/secrets";
import { connection } from "../infrastructure/connection";
import { findConnection,saveConnection } from "../infrastructure/files";
import { controlGuard,controlLockScript,controlRoot,lockOperator } from '../infrastructure/lock';
import { captureState,envFile } from "../infrastructure/portable-state";
export const controlHelp = `Stateless VM configuration:
  2srv server bootstrap -f server.json [--env-file .env] [--apply]  # setup + publish + connect
  2srv server publish -f server.json [--env-file .env] [--apply]
  2srv connect --ssh user@host [--port 22] [--identity /private/key]
  2srv connect --connection connection.yaml  # SSH object (plain SSH or GCP IAP)
  2srv get app --ssh user@host
  2srv deploy app APP --ssh user@host [--image repository@sha256:...] [--apply]
  2srv server env --ssh user@host --env-file secrets.env [--apply]
  2srv server config --output .2server/server.json [--ssh user@host]
  2srv server backup --ssh user@host --output .2server/server.age --recipient-file /private/recipients.txt
  2srv server restore -f replacement.json --backup .2server/server.age --backup-identity /private/age-key [--apply]
  2srv server lock [--ssh user@host | --connection FILE | -f server.json]
  2srv server unlock --lock-id ID [--apply]  # break exactly the inspected lock
  Use --connection connection.yaml instead of --ssh for GCP IAP or structured SSH.
  connect saves only SSH to .2server/connection.yaml with .gitignore. Other commands auto-discover it.
  Config, referenced secrets and cert state are VM-owned.
  Provider provisioning/power/disk/storage changes use the original Terraform/provider workflow.`;

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
