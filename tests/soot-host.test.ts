import { expect,test } from 'bun:test';
import { run } from '../src/shared/infrastructure/process';
import { fileURLToPath } from 'node:url';

test('trusted supervisor joins old owner before start, refuses timeout/foreign mounts and never copies a live database',async()=>{
  const host=fileURLToPath(new URL('../src/modules/extensions/infrastructure/templates/soot/host.py',import.meta.url));
  const program=String.raw`
import builtins, importlib.util, json, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location('soot_host', ${JSON.stringify(host)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
q = {'root': '/opt/2server/extensions/alpha', 'data': '/opt/2server/data/alpha', 'server': 'server', 'instance': 'alpha', 'container': 'two-server-alpha-soot', 'owner': 'server:alpha:soot', 'network': 'edge', 'action': 'handoff', 'release': '11111111-1111-4111-8111-111111111111'}
# Exercise foreign ownership using the real container validator before effects.
class Result:
    returncode = 0
    stdout = json.dumps([{'Config': {'Labels': {'io.2server.owner': 'foreign'}}}]).encode()
m.subprocess.run = lambda *a, **kw: Result()
try:
    m.container(q)
    raise AssertionError('foreign owner accepted')
except RuntimeError as e:
    assert str(e) == 'foreign_container'
with tempfile.TemporaryDirectory() as root:
    root = str(Path(root).resolve())
    release = Path(root) / 'release'
    release.mkdir()
    (release / 'release.json').write_text(json.dumps({'image': 'example/image@sha256:' + 'a'*64}))
    (release / 'compose.json').write_text(json.dumps({'services': {'two-server-alpha-soot': {'user': '65532:65532'}}}))
    calls = []
    m.own = lambda q, uid, gid: calls.append(['own', uid, gid])
    m.os.chown = lambda path, uid, gid, **kw: calls.append(['chown', Path(path).name, uid, gid])
    m.os.chmod = lambda path, mode, **kw: calls.append(['chmod', Path(path).name, oct(mode)])
    running = {'value': True}
    m.owner = lambda q: None
    m.container = lambda q: {'State': {'Running': running['value'], 'ExitCode': 0}}
    m.release_path = lambda q, identifier: release
    m.release_meta = lambda q, release: {}
    original_open = builtins.open
    def local_open(path, *a, **kw):
        return original_open(str(Path(root) / 'instance.lock') if str(path).startswith('/var/lock/') else path, *a, **kw)
    builtins.open = local_open
    def command(argv, timeout=180):
        calls.append(argv[:])
        if argv[:2] == ['docker', 'wait']:
            running['value'] = False
            return '0\n'
        return ''
    m.command = command
    assert m.mutate(q)['joined'] is True
    wait = next(i for i, argv in enumerate(calls) if argv[:2] == ['docker', 'wait'])
    start = next(i for i, argv in enumerate(calls) if argv[:2] == ['docker', 'compose'])
    assert wait < start
    # Ownership follows the release's runtime user, after the old owner joined.
    assert calls.index(['own', 65532, 65532]) in range(wait, start)
    # /release stays root's; the runtime group may only traverse it and read its receipt.
    for change in [['chown', 'release', 0, 65532], ['chmod', 'release', '0o750'], ['chown', 'receipt.json', 0, 65532], ['chmod', 'receipt.json', '0o640']]:
        assert calls.index(change) < start, change
    assert ['docker', 'update', '--restart=no', q['container']] in calls
    assert ['docker', 'kill', '--signal=TERM', q['container']] in calls
    calls.clear()
    running['value'] = True
    def failed_wait(argv, timeout=180):
        calls.append(argv[:])
        if argv[:2] == ['docker', 'wait']:
            raise TimeoutError('private failure')
        return ''
    m.command = failed_wait
    try:
        m.mutate(q)
        raise AssertionError('timeout accepted')
    except TimeoutError:
        pass
    assert not any(argv[:2] == ['docker', 'compose'] for argv in calls)
    assert not any(argv[:2] == ['docker', 'rm'] for argv in calls)
    builtins.open = original_open
print('supervisor guards verified')
`;
  expect((await run(['python3','-B','-c',program])).trim()).toBe('supervisor guards verified');
  const text=await Bun.file(host).text();expect(text).not.toContain('shutil.copy');expect(text).not.toContain('docker", "stop');
});

test('host bootstrap is separate from digest-bound source staging and refuses staged receipt/directory edits',async()=>{
  const host=fileURLToPath(new URL('../src/modules/extensions/infrastructure/templates/soot/host.py',import.meta.url));
  const program=String.raw`
import base64, builtins, hashlib, importlib.util, json, os, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location('soot_host', ${JSON.stringify(host)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as temp:
    temp = Path(temp).resolve()
    root = temp / 'alpha'
    data = temp / 'data'
    q = {'root': str(root), 'data': str(data), 'server': 'server', 'instance': 'alpha', 'container': 'two-server-alpha-soot', 'owner': 'server:alpha:soot', 'network': 'edge', 'release': '11111111-1111-4111-8111-111111111111', 'receipt': base64.b64encode(b'{}').decode(), 'receipt_digest': hashlib.sha256(b'{}').hexdigest(), 'compose': {}, 'image': 'example/image@sha256:'+'a'*64, 'package_digest': 'a'*64}
    original_open = builtins.open
    builtins.open = lambda path, *a, **kw: original_open(temp / 'instance.lock' if str(path).startswith('/var/lock/') else path, *a, **kw)
    absent = {'phase': 'absent'}
    m.inspect = lambda q: absent
    m.command = lambda *a, **kw: ''
    m.start = lambda *a, **kw: None
    m.running_user = lambda q: (os.getuid(), os.getgid())
    # Exercise actual initialization filesystem effects; no stage inventory exists yet.
    assert m.mutate({**q, 'action': 'initialize', 'expected': absent, 'token_env': 'TEST_TOKEN', 'token': 'fixture-only', 'bootstrap': {'soots': ['bootstrap/soot.json']}, 'bootstrap_files': {'bootstrap/soot.json': '{}', 'bootstrap/SOUL.md': 'Inert', 'bootstrap/mission.md': 'Wait'}}) == {'initialized': True}
    assert (root / 'config' / 'deployment.json').is_file()
    assert not (root / 'releases' / q['release'] / 'source').exists()
    # Build an offline source tree, including receipt bytes and an empty install root.
    q['release'] = '22222222-2222-4222-8222-222222222222'
    files = [{'name': 'soot/deployment.json', 'bytes': base64.b64encode(b'{}').decode(), 'digest': hashlib.sha256(b'{}').hexdigest(), 'executable': False}, {'name': 'installed/pack/.soot-pack.json', 'bytes': base64.b64encode(b'{"installed_at":"reviewed"}').decode(), 'digest': hashlib.sha256(b'{"installed_at":"reviewed"}').hexdigest(), 'executable': False}]
    dirs = ['soot', 'installed', 'installed/pack', 'empty-install']
    inventory = json.dumps({'directories': dirs, 'files': [{k: f[k] for k in ['name', 'digest', 'executable']} for f in files]}, separators=(',', ':'))
    digest = hashlib.sha256(inventory.encode()).hexdigest()
    q.update(action='stage', expected=absent, files=files, directories=dirs, inventory=inventory, inventory_digest=digest, staging_bytes='{}', staging_digest=hashlib.sha256(b'{}').hexdigest())
    assert m.mutate(q) == {'staged': True}
    assert m.mutate(q) == {'staged': True}
    release = root / 'releases' / q['release']
    stage = root / 'transactions' / 'inbox' / q['release']
    assert (release / 'source' / 'soot' / 'deployment.json').read_bytes() == b'{}'
    assert m.main({**q, 'action': 'verify-stage'}) == {'verified': True}
    def refused():
        try:
            m.main({**q, 'action': 'verify-stage'})
            raise AssertionError('stage edit accepted')
        except RuntimeError as e:
            assert str(e) == 'staged_files_changed'
    receipt = stage / 'installed' / 'pack' / '.soot-pack.json'
    receipt.write_text('{"installed_at":"changed"}')
    refused()
    receipt.write_text('{"installed_at":"reviewed"}')
    (stage / 'empty-install').rmdir()
    refused()
    (stage / 'empty-install').mkdir()
    (stage / 'foreign').symlink_to(stage / 'soot', target_is_directory=True)
    refused()
    (stage / 'foreign').unlink()
    (release / 'source' / 'soot' / 'deployment.json').write_text('edited immutable source')
    refused()
    # Applying source has never rewritten the writable active config.
    assert json.loads((root / 'config' / 'deployment.json').read_text()) == {'soots': ['bootstrap/soot.json']}
    assert list(data.iterdir()) == [data / '.2server-owner']
    builtins.open = original_open
print('source staging guards verified')
`;
  expect((await run(['python3','-B','-c',program])).trim()).toBe('source staging guards verified');
});

test('retirement inspects the explicitly owned edge release pointer and preserves published or foreign routes',async()=>{
  const host=fileURLToPath(new URL('../src/modules/extensions/infrastructure/templates/soot/host.py',import.meta.url));
  const program=String.raw`
import importlib.util, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location('soot_host', ${JSON.stringify(host)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as temp:
    edge = Path(temp).resolve()
    sites = edge / 'releases' / 'initial' / 'sites'
    sites.mkdir(parents=True)
    (edge / 'owner').write_text('server\n')
    (edge / 'current').symlink_to('releases/initial', target_is_directory=True)
    site = sites / 'unrelated.caddy'
    site.write_text('reverse_proxy unrelated:8080')
    q = {'server': 'server', 'container': 'two-server-alpha-soot'}
    m.retirement_routes(q, edge)
    def refused(code):
        try:
            m.retirement_routes(q, edge)
            raise AssertionError('unsafe retirement accepted')
        except RuntimeError as e:
            assert str(e) == code
    site.write_text('reverse_proxy two-server-alpha-soot:7788')
    refused('published_route_uses_instance')
    assert site.exists()
    (edge / 'owner').write_text('foreign')
    refused('foreign_server')
    (edge / 'owner').write_text('server')
    # A Domain retirement leaves current on its mktemp-named release.
    retired = edge / 'releases' / 'retire.Ab3xQ9' / 'sites'
    retired.mkdir(parents=True)
    (edge / 'current').unlink()
    (edge / 'current').symlink_to('releases/retire.Ab3xQ9', target_is_directory=True)
    m.retirement_routes(q, edge)
    (retired / 'chat.caddy').write_text('reverse_proxy two-server-alpha-soot:7790')
    refused('published_route_uses_instance')
    for bad in ['../foreign', 'releases/retire.Ab3xQ9/..', 'releases/retire.../x', 'releases/retire.toolong7']:
        (edge / 'current').unlink()
        (edge / 'current').symlink_to(bad, target_is_directory=True)
        refused('edge_release_identity_invalid')
print('retirement route guards verified')
`;
  expect((await run(['python3','-B','-c',program])).trim()).toBe('retirement route guards verified');
});

test('app env is validated, written 0600 atomically and removed when secretEnv is dropped',async()=>{
  const host=fileURLToPath(new URL('../src/modules/extensions/infrastructure/templates/soot/host.py',import.meta.url));
  const program=String.raw`
import importlib.util, os, stat, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location('soot_host', ${JSON.stringify(host)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as temp:
    root = Path(temp).resolve() / 'alpha'
    q = {'root': str(root)}
    m.write_app_env(q)
    assert not root.exists()
    (root / 'credentials').mkdir(parents=True)
    target = root / 'credentials' / 'app.env'
    m.write_app_env({**q, 'app_env': 'SOOT_TURNSTILE_SECRET=first\n'})
    assert target.read_text() == 'SOOT_TURNSTILE_SECRET=first\n'
    assert stat.S_IMODE(target.stat().st_mode) == 0o600
    m.write_app_env({**q, 'app_env': 'SOOT_TURNSTILE_SECRET=rotated\nOTHER_KEY=a/b+c=\n'})
    assert target.read_text() == 'SOOT_TURNSTILE_SECRET=rotated\nOTHER_KEY=a/b+c=\n'
    for bad in ['lower=x\n', 'KEY=$(id)\n', 'KEY=x', 'KEY=x\nKEY2=has space\n', '']:
        try:
            m.write_app_env({**q, 'app_env': bad})
            raise AssertionError('accepted ' + repr(bad))
        except RuntimeError as e:
            assert str(e) == 'app_env_invalid'
    assert target.read_text().startswith('SOOT_TURNSTILE_SECRET=rotated')
    assert not (root / 'credentials' / '.app.env.next').exists()
    m.write_app_env(q)
    assert not target.exists()
print('app env guards verified')
`;
  expect((await run(['python3','-B','-c',program])).trim()).toBe('app env guards verified');
});

test('rotate-token replaces the operator env atomically before the restart and is a no-op when unchanged',async()=>{
  const host=fileURLToPath(new URL('../src/modules/extensions/infrastructure/templates/soot/host.py',import.meta.url));
  const program=String.raw`
import builtins, importlib.util, stat, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location('soot_host', ${JSON.stringify(host)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as temp:
    temp = Path(temp).resolve()
    root = temp / 'alpha'
    (root / 'credentials').mkdir(parents=True)
    target = root / 'credentials' / 'operator.env'
    target.write_text('SOOT_OPERATOR_TOKEN=' + 'o' * 64 + '\n')
    target.chmod(0o600)
    q = {'root': str(root), 'instance': 'alpha', 'action': 'rotate-token', 'container': 'c', 'token_env': 'SOOT_OPERATOR_TOKEN', 'token': 'n' * 64, 'app_env': 'SOOT_AI_KEY=k\n'}
    calls = []
    m.inspect = lambda q: {'current': '11111111-1111-4111-8111-111111111111'}
    m.owner = lambda q: None
    m.stop_join = lambda q: calls.append(['stop', target.read_text()])
    m.start = lambda q, release: calls.append(['start', release.name])
    original_open = builtins.open
    builtins.open = lambda path, *a, **kw: original_open(str(temp / 'instance.lock') if str(path).startswith('/var/lock/') else path, *a, **kw)
    assert m.mutate(q) == {'rotated': True}
    # The new value is on disk before the old owner stops; app.env is rewritten too.
    assert calls == [['stop', 'SOOT_OPERATOR_TOKEN=' + 'n' * 64 + '\n'], ['start', '11111111-1111-4111-8111-111111111111']]
    assert stat.S_IMODE(target.stat().st_mode) == 0o600
    assert (root / 'credentials' / 'app.env').read_text() == 'SOOT_AI_KEY=k\n'
    assert not (root / 'credentials' / '.operator.env.next').exists()
    calls.clear()
    assert m.mutate(q) == {'rotated': False} and calls == []
    for bad in [{'token': 'short'}, {'token': 'n' * 40 + ' x'}, {'token_env': 'lower'}]:
        try:
            m.mutate({**q, **bad})
            raise AssertionError('accepted ' + repr(bad))
        except RuntimeError as e:
            assert str(e) == 'operator_token_invalid'
    assert target.read_text() == 'SOOT_OPERATOR_TOKEN=' + 'n' * 64 + '\n'
    builtins.open = original_open
print('rotate token verified')
`;
  expect((await run(['python3','-B','-c',program])).trim()).toBe('rotate token verified');
});

test('runtime ownership follows the release user, keeps host-owned files and never follows a planted link',async()=>{
  const host=fileURLToPath(new URL('../src/modules/extensions/infrastructure/templates/soot/host.py',import.meta.url));
  const program=String.raw`
import importlib.util, json, os, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location('soot_host', ${JSON.stringify(host)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
def refused(f, code):
    try:
        f()
        raise AssertionError('accepted')
    except RuntimeError as e:
        assert str(e) == code, str(e)
with tempfile.TemporaryDirectory() as temp:
    temp = Path(temp).resolve()
    release = temp / 'release'
    release.mkdir()
    def compose(service):
        (release / 'compose.json').unlink(missing_ok=True)
        (release / 'compose.json').write_text(json.dumps({'services': {'soot': service}}))
    compose({'user': '65532:65532'})
    assert m.compose_user(release) == (65532, 65532)
    compose({})
    assert m.compose_user(release) == (0, 0)
    compose({'user': 'root'})
    refused(lambda: m.compose_user(release), 'release_supervisor_changed')
    root, data, outside = temp / 'alpha', temp / 'data', temp / 'outside'
    for p in [root / 'config' / 'packs.d', root / 'transactions' / 'inbox' / 'r', root / 'credentials' / 'home', data, outside]:
        p.mkdir(parents=True)
    for p in [root / 'config' / 'deployment.json', root / 'transactions' / 'inbox' / 'r' / 'a.json', root / 'credentials' / 'operator.env',
              root / 'credentials' / 'app.env', data / '.2server-owner', data / 'conversations.db', outside / 'secret']:
        p.write_text('x')
    (data / 'planted').symlink_to(outside, target_is_directory=True)
    (data / 'planted-file').symlink_to(outside / 'secret')
    changed = []
    os.fchown = lambda fd, uid, gid: changed.append((os.readlink('/dev/fd/%d' % fd) if Path('/dev/fd/%d' % fd).is_symlink() else 'dir', uid, gid))
    def chown(name, uid, gid, dir_fd=None, follow_symlinks=True):
        assert dir_fd is not None and follow_symlinks is False
        changed.append((name, uid, gid))
    os.chown = chown
    m.own({'root': str(root), 'data': str(data)}, 65532, 65532)
    names = [c[0] for c in changed]
    assert all(c[1:] == (65532, 65532) for c in changed)
    for kept in ['operator.env', 'app.env', '.2server-owner', 'secret']:
        assert kept not in names, kept
    for moved in ['deployment.json', 'a.json', 'conversations.db', 'planted', 'planted-file']:
        assert moved in names, moved
    # Four roots plus their subdirectories, never the planted link's target.
    assert len([c for c in changed if c[0] not in {'deployment.json', 'a.json', 'conversations.db', 'planted', 'planted-file'}]) == 8
print('runtime ownership verified')
`;
  expect((await run(['python3','-B','-c',program])).trim()).toBe('runtime ownership verified');
});
