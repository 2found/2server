import type { Snapshot } from "./snapshot";
import { chmod,mkdir,mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectionOptions,options } from "../../../shared/cli/control-options";
import { resourceOperation } from '../../../shared/cli/resource-request';
import { setSessionState } from '../../../shared/infrastructure/operator-state';
import { setSshTransport } from '../../../shared/infrastructure/process';
import { setVmSecrets } from "../../../shared/infrastructure/vm-secrets";
import { type Config } from '../../config/application/config';
import { readConfig } from '../../config/infrastructure/file';
import { extensionFor } from '../../extensions/application/registry';
import { envSchema,secretKeys,selectSecrets } from "../domain/secrets";
import { connection } from "../infrastructure/connection";
import { findConnection,privateWrite } from "../infrastructure/files";
import { captureState,envFile } from "../infrastructure/portable-state";
import { controlOperations } from "./operations";
import { appResources,controlResources } from './scope';
import { acquire,commitSnapshot,fetchSnapshot,release } from "./snapshot";
// Classify the operation, not just --apply: read commands may accept that flag
// for compatibility, but must never create revisions or operation history.
export function mutatesControl(args: string[], config?: Config): boolean {
  if (!args.includes('--apply')) return false;
  const resource = resourceOperation(args);
  if (resource) return !['get', 'describe', 'logs'].includes(resource.verb);
  if (args[0] === 'server') return args[1] === 'env';
  if (args[0] === 'app-action' && (args[2] === 'help' || (config && extensionFor(config,args[1])?.commands?.[args[2]]?.readOnly))) return false;
  if (args[0] === 'secret') return ['set', 'delete'].includes(args[1]);
  return ['app-action', 'file-action', 'setup', 'domains', 'deploy', 'rollback', 'extensions'].includes(args[0]);
}

export async function connectedCommand(args: string[], execute: (args: string[], session?: {prepareDomains: () => Promise<void>}) => Promise<void>, sessionOptions: {resources?: string[]} = {}): Promise<boolean> {
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
  const mutate = mutatesControl(rest,initial.config);
  const operation = resourceOperation(rest);
  // Record only command identity, never arbitrary arguments or secret values.
  const label = operation ? `${operation.verb} ${operation.resource}` : rest[0] === 'server' || rest[0] === 'secret' ? `${rest[0]} ${rest[1]}` : rest[0];
  const scopeFor = (c:Config) => {
    if (!sessionOptions.resources) return controlResources(rest,c);
    const names = sessionOptions.resources.filter(r=>r.startsWith('app:')).map(r=>r.slice(4));
    // A source file cannot narrow an existing template app's infrastructure lock.
    if (names.some(name=>c.extensionApps[name] || c.extensions.services[name])) return ['server'];
    return [...new Set([...sessionOptions.resources,...c.apps.filter(a=>names.includes(a.name)).flatMap(appResources)])].sort();
  };
  const resources = scopeFor(initial.config);
  const scoped = !resources.includes('server');
  const token = mutate ? await acquire(transport, label, resources) : undefined;
  let domainToken: string | undefined;
  let temp: string | undefined;
  let preserve = false;
  const previousEnv = new Map<string, string | undefined>();
  try {
    let snapshot = await fetchSnapshot(transport);
    if(rest[0]==='file-action')console.log(`VM revision: ${snapshot.revision}`);
    if (token && !scoped && snapshot.revision !== initial.revision) throw new Error('Server changed while acquiring lock; rerun to review the new revision');
    if (token && scoped && JSON.stringify(scopeFor(snapshot.config)) !== JSON.stringify(resources)) throw new Error('Resource changed while acquiring lock; rerun');
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
    let appSecrets=structuredClone(snapshot.appSecrets ?? {});
    // One-time migration from adopted private templates; never export these values.
    for(const app of snapshot.config.apps) {
      if(!app.compose || appSecrets[app.name] || (scoped && !resources.includes(`app:${app.name}`))) continue;
      const raw=snapshot.state[`compose/${app.name}/template.json`];
      if(raw) {const t=JSON.parse(raw); const color=t['x-2server'].current as 'blue'|'green';
        appSecrets[app.name]={...t.services[app.compose.services[color]].environment};}
    }
    let importedAppSecrets=structuredClone(appSecrets);
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
        const deployedApp=snapshot.config.apps.find(a=>a.name===app);
        const inUse=app ? [deployedApp?.secrets,deployedApp?.preDeploy?.secrets,snapshot.config.extensions.services?.[app]?.secrets,snapshot.config.extensionApps?.[app]?.secrets].flatMap(refs=>Object.values(refs??{})) : [];
        if(app ? inUse.some(s=>s.provider==='vm'&&s.key===o['--key']) : secretKeys(snapshot.config).includes(o['--key']))
          throw new Error('Secret is referenced by deployed configuration; remove the reference first');
        delete values[o['--key']];
      }
      if(mutate && token) {
        if(app) appSecrets[app]=values;
        await commitSnapshot(transport,snapshot,{...snapshot,revision:crypto.randomUUID(),env:app?snapshot.env:values,appSecrets},token,scoped);
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
        await execute(legacy ? [rest[0], manifest, ...rest.slice(1)] : [...rest, '-f', manifest], {
          prepareDomains: async () => {
            if (!token || !scoped || domainToken) return;
            // Publish the healthy rollout before waiting for domain work. Keep
            // the app reservation through the domain phase and final commit.
            await commitSnapshot(transport,snapshot,{...snapshot,config:await readConfig(manifest),appSecrets,state:await captureState(state)},token,true);
            domainToken = await acquire(transport,'source domains',['domains'],120_000);
            snapshot = await fetchSnapshot(transport);
            appSecrets = structuredClone(snapshot.appSecrets??{});
            importedAppSecrets = structuredClone(appSecrets);
            setVmSecrets(appSecrets);
            await rm(state,{recursive:true,force:true});
            await mkdir(state,{mode:0o700});
            for (const [path,value] of Object.entries(snapshot.state)) await privateWrite(join(state,path),value);
            await privateWrite(manifest,JSON.stringify(snapshot.config));
          },
        });
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
      try { await commitSnapshot(transport, snapshot, next, token, scoped, domainToken?[domainToken]:[]); }
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
    let releaseFailed = false;
    for (const held of [domainToken,token]) {
      if (held) try { await release(transport,held); } catch { releaseFailed = true; }
    }
    if (releaseFailed) throw new Error(`VM lock release failed; inspect /opt/2server/control/lock before retrying.${preserve ? ` Private recovery retained at ${temp}.` : ''}`);
  }
}
