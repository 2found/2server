import { portableStatePolicy } from "./state-policy";
import { z } from 'zod';
import { quote } from '../../../shared/infrastructure/process';
import { configSchema,type Config } from '../../config/application/config';
import { mergeControl } from '../domain/merge';
import { envSchema,secretKeys } from "../domain/secrets";
import { controlGuard,controlLockScript,controlMutex,controlRoot,lockOperator } from '../infrastructure/lock';
import { controlOperations } from "./operations";
// One control record per VM, matching the existing single edge owner contract.
const id = z.string().uuid();
const snapshotSchema = z.object({
  version: z.literal(1), revision: id, config: configSchema,
  env: envSchema, appSecrets: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),envSchema).optional(), state: z.record(portableStatePolicy().schema, z.string().max(1024 * 1024)),
}).strict();
export type Snapshot = z.infer<typeof snapshotSchema>;
export function validateSnapshot(raw: string): Snapshot {
  if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new Error('Server configuration exceeds 8 MiB');
  try {
    const s = snapshotSchema.parse(JSON.parse(raw));
    secretKeys(s.config); // Stored secrets may outlive the checkout that references them.
    return s;
  } catch { throw new Error('Invalid server control snapshot; no values logged'); }
}
// The lock is intentionally persistent if the operator dies or SSH is lost.
// Never time-expire it while a Cloudflare/deployment request may still be active.
// Process-local timing only; reservation ownership remains exclusively on the VM.
const heldLocks = new Map<string,{started:number;operation:string;resources:string[]}>();
const blockerSchema = z.object({
  lockId:z.string().regex(/^[a-f0-9]{64}$/),
  resources:z.array(z.string().max(512).regex(/^[^\x00-\x1f\x7f]+$/)).max(128),
  createdAt:z.string().datetime({offset:true}),
});
export async function acquire(c: Config, operation: string, resources = ['server'], waitMs = 0) {
  const token = crypto.randomUUID(), started = performance.now();
  let reported = false;
  for (;;) {
    let result: {error?:unknown;lock?:unknown};
    try {
      const output = await controlOperations.remote(c, controlLockScript(c, 'acquire', {token, resources, operator: lockOperator(operation)}));
      result = output.trim() ? JSON.parse(output) : {};
      if (output.trim() && (!result || result.error !== 'Resource is locked')) throw new Error('Invalid lock response');
    } catch {
      controlOperations.lockEvent({event:'acquire-failed',operation,resources,waitMs:Math.round(performance.now()-started)});
      throw new Error(`Cannot acquire VM control lock for ${resources.join(', ')}: SSH, ownership or control response failed; run server lock to inspect before retrying`);
    }
    const elapsed = performance.now()-started;
    if (!result.error) {
      heldLocks.set(token,{started:performance.now(),operation,resources:[...resources]});
      controlOperations.lockEvent({event:'acquired',operation,resources,waitMs:Math.round(elapsed)});
      return token;
    }
    // Strip every unrecognized field; never log reservation tokens or snapshot values.
    const parsed = blockerSchema.safeParse(result.lock);
    const blocker = parsed.success ? parsed.data : undefined;
    const exhausted = elapsed >= waitMs;
    if (!reported || exhausted) {
      controlOperations.lockEvent({event:exhausted?'blocked':'waiting',operation,resources,waitMs:Math.round(elapsed),blocker});
      reported = true;
    }
    if (exhausted) throw new Error(`VM control lock conflict for ${resources.join(', ')} after ${Math.round(elapsed)}ms${blocker ? `; blocking lockId=${blocker.lockId}` : ''}. Run server lock; use server unlock --lock-id ID --apply only after confirming the prior operation stopped`);
    await Bun.sleep(Math.min(250,waitMs-elapsed));
  }
}
export async function release(c: Config, token: string) {
  const held = heldLocks.get(token);
  try {
    await controlOperations.remote(c, controlLockScript(c, 'release', {token}));
  } catch {
    if(held)controlOperations.lockEvent({event:'release-failed',operation:held.operation,resources:held.resources,heldMs:Math.round(performance.now()-held.started)});
    throw new Error('VM control lock release failed; run server lock to inspect ownership');
  } finally {
    heldLocks.delete(token);
  }
  if(held)controlOperations.lockEvent({event:'released',operation:held.operation,resources:held.resources,heldMs:Math.round(performance.now()-held.started)});
}
export async function fetchSnapshot(c: Config) {
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
export async function storeSnapshot(c: Config, s: Snapshot, token: string, previous?: string, scoped = false, extraTokens: string[] = []): Promise<boolean> {
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
  const result = await controlOperations.remote(c, controlMutex(`set -euo pipefail
umask 077
test "$(cat ${controlRoot}/lock/${scoped ? `${id.parse(token)}/` : ''}token)" = ${quote(token)}
${extraTokens.map(t=>`test "$(cat ${controlRoot}/lock/${id.parse(t)}/token)" = ${quote(t)}`).join('\n')}
${previous ? `if test "$(readlink ${controlRoot}/current)" != revisions/${id.parse(previous)}; then echo conflict; exit 0; fi` : `test ! -e ${controlRoot}/current`}
chmod 700 ${target}
chmod 600 ${target}/snapshot.json ${target}/server.json ${target}/.env
ln -s revisions/${s.revision} ${controlRoot}/next-${s.revision}
mv -Tf ${controlRoot}/next-${s.revision} ${controlRoot}/current`));
  return result.trim() !== 'conflict';
}
export async function commitSnapshot(c:Config, base:Snapshot, next:Snapshot, token:string, scoped:boolean, extraTokens:string[] = []) {
  for (let attempt=0; attempt<20; attempt++) {
    const current = await fetchSnapshot(c);
    const merged = mergeControl(base,next,current);
    merged.revision = crypto.randomUUID();
    if (await storeSnapshot(c,merged,token,current.revision,scoped,extraTokens)) return;
  }
  throw new Error('Control snapshot remained busy; private recovery required');
}
