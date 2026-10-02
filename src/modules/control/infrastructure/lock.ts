import { hostname,userInfo } from 'node:os';
import { quote } from '../../../shared/infrastructure/process';
import type { Config } from '../../config/application/config';

export const controlRoot = '/opt/2server/control';
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

export function lockOperator(operation: string) {
  return {operation, operator: userInfo().username, host: hostname(), pid: process.pid};
}

// A short OS lock serializes acquire/release/break and the snapshot commit.
// The kernel releases this mutex on disconnect/crash; the operation lock stays
// persistent because a deployment/provider request may still be running.
export function controlMutex(script: string): string {
  return `${controlGuard}
umask 077
mkdir -p ${controlRoot}
chmod 700 ${controlRoot}
python3 - <<'PY_CONTROL_MUTEX'
import os, stat, fcntl, subprocess
fd = os.open('${controlRoot}/mutex', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
s = os.fstat(fd)
if not stat.S_ISREG(s.st_mode) or s.st_uid != os.geteuid() or s.st_mode & 0o077:
    raise RuntimeError('Unsafe control mutex')
fcntl.flock(fd, fcntl.LOCK_EX)
raise SystemExit(subprocess.run(['bash', '-se'], input=${JSON.stringify(script)}, text=True, pass_fds=(fd,)).returncode)
PY_CONTROL_MUTEX`;
}

export function controlLockScript(c: Config, action: 'inspect' | 'acquire' | 'release' | 'break', input: Record<string, unknown> = {}): string {
  const payload = Buffer.from(JSON.stringify({action, ...input})).toString('base64');
  const script = `set -euo pipefail
${c.name ? `if test -f /opt/2server/edge/owner; then test "$(cat /opt/2server/edge/owner)" = ${quote(c.name)}; fi` : ''}
python3 - <<'PY_CONTROL_LOCK'
import os, stat, json, base64, hashlib, uuid, fcntl
from datetime import datetime, timezone
from pathlib import Path
request = json.loads(base64.b64decode('${payload}'))
root = Path('${controlRoot}')
gate = root / 'lock'
lock = gate
def checked(path, directory=False):
    s = path.lstat()
    if (not (stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode))
            or s.st_uid != os.geteuid() or s.st_mode & 0o022):
        raise RuntimeError('Unsafe lock path')
    return s
def read_file(path):
    try:
        s = checked(path)
    except FileNotFoundError:
        return b''
    if s.st_size > 4096:
        raise RuntimeError('Invalid lock file')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as f:
        return f.read(4097)
def inspect_one(lock):
    try:
        s = checked(lock, True)
    except FileNotFoundError:
        return {'locked': False}
    token = read_file(lock / 'token')
    raw = read_file(lock / 'metadata.json')
    try:
        metadata = json.loads(raw) if raw else None
    except (ValueError, UnicodeError):
        metadata = None
    if not isinstance(metadata, dict):
        metadata = None
    elif metadata:
        metadata = {k: v for k, v in metadata.items() if k in ['operation','operator','host','pid','createdAt'] and isinstance(v, (str,int))}
    fingerprint = f'{s.st_dev}:{s.st_ino}:{s.st_ctime_ns}:'.encode() + token
    latest = checked(lock, True)
    if (s.st_dev, s.st_ino, s.st_ctime_ns) != (latest.st_dev, latest.st_ino, latest.st_ctime_ns):
        raise RuntimeError('Lock changed; inspect again')
    return {'locked': True, 'lockId': hashlib.sha256(fingerprint).hexdigest(),
            'createdAt': datetime.fromtimestamp(s.st_mtime, timezone.utc).isoformat(), 'owner': metadata}
def write_json(path, value):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'w') as f:
        json.dump(value, f)
def holders():
    if not gate.exists() and not gate.is_symlink():
        return []
    checked(gate, True)
    if not (gate / 'scoped').exists():
        return [(gate, {**inspect_one(gate), 'resources': ['server']})]
    checked(gate / 'scoped')
    result = []
    for path in sorted(gate.iterdir()):
        if path.name == 'scoped': continue
        row = inspect_one(path)
        raw = read_file(path / 'resources.json')
        try:
            resources = json.loads(raw) if raw else ['server']
        except (ValueError, UnicodeError):
            resources = ['server']
        if not isinstance(resources, list) or not resources or any(not isinstance(r, str) for r in resources):
            resources = ['server']
        result.append((path, {**row, 'resources': resources}))
    # A crash while initializing the gate/holder remains inspectable and
    # explicitly recoverable, never an invisible permanent lock.
    return result or [(gate, {**inspect_one(gate), 'resources': ['server']})]

action = request['action']
if action == 'inspect' and (root / 'mutex').exists():
    checked(root / 'mutex')
    read_mutex = os.open(root / 'mutex', os.O_RDONLY | os.O_NOFOLLOW)
    fcntl.flock(read_mutex, fcntl.LOCK_SH)
rows = holders()
if action == 'acquire':
    resources = sorted(set(request.get('resources', ['server'])))
    if not resources or any(not isinstance(r, str) or len(r) > 512 for r in resources):
        raise RuntimeError('Invalid lock resources')
    for path, row in rows:
        if 'server' in resources or 'server' in row['resources'] or set(resources) & set(row['resources']):
            print(json.dumps({'error': 'Resource is locked', 'lock': row}))
            raise SystemExit(0)
    # Keep the legacy gate path occupied: old CLIs fail closed instead of
    # entering a VM-wide operation alongside scoped writers.
    if resources == ['server']:
        os.mkdir(gate, 0o700)
        lock = gate
    else:
        if not gate.exists():
            os.mkdir(gate, 0o700)
            write_json(gate / 'scoped', True)
        token = request['token']
        if str(uuid.UUID(token)) != token: raise RuntimeError('Invalid lock token')
        lock = gate / token
        os.mkdir(lock, 0o700)
        write_json(lock / 'resources.json', resources)
    with os.fdopen(os.open(lock / 'token', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as f:
        f.write(request['token'])
    write_json(lock / 'metadata.json', {**request['operator'], 'createdAt': datetime.now(timezone.utc).isoformat()})
elif action == 'release':
    matches = [path for path, row in rows if read_file(path / 'token').decode() == request['token']]
    if len(matches) != 1: raise RuntimeError('Lock ownership changed')
    lock = matches[0]
    (lock / 'token').unlink()
    (lock / 'metadata.json').unlink(missing_ok=True)
    (lock / 'resources.json').unlink(missing_ok=True)
    lock.rmdir()
else:
    current = ({'locked': False} if not rows else
               {k:v for k,v in rows[0][1].items() if k != 'resources'} if rows[0][0] == gate else
               {'locked': True, 'locks': [row for path,row in rows]})
    if action == 'break':
        matches = [(path,row) for path,row in rows if row['lockId'] == request['lockId']]
        if len(matches) != 1:
            print(json.dumps({'error': 'Lock changed or was released; run server lock again'}))
            raise SystemExit(0)
        lock, current = matches[0]
        archive = root / 'broken-locks'
        archive.mkdir(mode=0o700, exist_ok=True)
        checked(archive, True)
        archive.chmod(0o700)
        target = archive / str(uuid.uuid4())
        write_json(lock / ('break-' + str(uuid.uuid4()) + '.json'),
                   {**current, 'brokenAt': datetime.now(timezone.utc).isoformat(), 'by': request['operator']})
        lock.rename(target)
        current = {'unlocked': True, 'lockId': current['lockId'], 'archive': str(target)}
    print(json.dumps(current))
if action in ['release','break'] and gate.exists() and (gate / 'scoped').exists():
    if list(gate.iterdir()) == [gate / 'scoped']:
        (gate / 'scoped').unlink()
        gate.rmdir()
PY_CONTROL_LOCK`;
  return action === 'inspect' ? `${controlGuard}\n${script}` : controlMutex(script);
}
