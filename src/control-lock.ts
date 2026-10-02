import { hostname, userInfo } from 'node:os';
import type { Config } from './config';
import { quote } from './process';

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
import os, stat, json, base64, hashlib, uuid
from datetime import datetime, timezone
from pathlib import Path
request = json.loads(base64.b64decode('${payload}'))
root = Path('${controlRoot}')
lock = root / 'lock'
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
def inspect():
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
action = request['action']
if action == 'acquire':
    os.mkdir(lock, 0o700)
    with os.fdopen(os.open(lock / 'token', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as f:
        f.write(request['token'])
    write_json(lock / 'metadata.json', {**request['operator'], 'createdAt': datetime.now(timezone.utc).isoformat()})
elif action == 'release':
    checked(lock, True)
    if read_file(lock / 'token').decode() != request['token']:
        raise RuntimeError('Lock ownership changed')
    (lock / 'token').unlink()
    (lock / 'metadata.json').unlink(missing_ok=True)
    lock.rmdir()
else:
    current = inspect()
    if action == 'break':
        if not current['locked'] or current['lockId'] != request['lockId']:
            print(json.dumps({'error': 'Lock changed or was released; run server lock again'}))
            raise SystemExit(0)
        archive = root / 'broken-locks'
        archive.mkdir(mode=0o700, exist_ok=True)
        checked(archive, True)
        archive.chmod(0o700)
        target = archive / str(uuid.uuid4())
        # Persist the audit before freeing the lock. No recursive deletion of a
        # path which a new operator could have acquired in the meantime.
        write_json(lock / ('break-' + str(uuid.uuid4()) + '.json'),
                   {**current, 'brokenAt': datetime.now(timezone.utc).isoformat(), 'by': request['operator']})
        lock.rename(target)
        current = {'unlocked': True, 'lockId': current['lockId'], 'archive': str(target)}
    print(json.dumps(current))
PY_CONTROL_LOCK`;
  return action === 'inspect' ? `${controlGuard}\n${script}` : controlMutex(script);
}
