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
    calls = []
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
import base64, builtins, hashlib, importlib.util, json, tempfile
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
    (edge / 'current').unlink()
    (edge / 'current').symlink_to('../foreign', target_is_directory=True)
    refused('edge_release_identity_invalid')
print('retirement route guards verified')
`;
  expect((await run(['python3','-B','-c',program])).trim()).toBe('retirement route guards verified');
});
