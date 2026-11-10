import { expect,test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { cleanRuntimeMessage,describeRuntimeError,RuntimeError } from '../src/modules/extensions/infrastructure/templates/soot/protocol';
import { run } from '../src/shared/infrastructure/process';

// The runtime says why it refused (its canned `error` copy); 2srv prints it
// next to the stable reason code instead of only `request_rejected`.

test('a runtime refusal prints its message beside the reason code, cleaned and capped', () => {
  const e = new RuntimeError('validation_failed', 'pack_source_conflict', 'Pack soot-brand đã được cài bởi source 2agent.\u0007\u001b[31m\n  Ngừng source cũ trước.');
  expect(describeRuntimeError(e)).toBe('validation_failed: pack_source_conflict - Pack soot-brand đã được cài bởi source 2agent. [31m Ngừng source cũ trước.');
  expect(cleanRuntimeMessage('x'.repeat(900))).toHaveLength(400);
  // Capping counts characters, never splits one.
  expect([...cleanRuntimeMessage('😀'.repeat(500))]).toHaveLength(400);
  // No message, or a non-string: the old output, unchanged.
  expect(describeRuntimeError(new RuntimeError('validation_failed', 'request_rejected'))).toBe('validation_failed: request_rejected');
  expect(describeRuntimeError(new RuntimeError('validation_failed', 'request_rejected', { not: 'text' }))).toBe('validation_failed: request_rejected');
});

test('the host adapter forwards a cleaned message and keeps code and reason to [a-z_]', async () => {
  const host = fileURLToPath(new URL('../src/modules/extensions/infrastructure/templates/soot/host.py', import.meta.url));
  const program = String.raw`
import importlib.util, io, json, urllib.error, urllib.request
spec = importlib.util.spec_from_file_location('soot_host', ${JSON.stringify(host)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.owner = lambda q: None
m.container = lambda q: {'State': {'Running': True}, 'NetworkSettings': {'Networks': {'edge': {'IPAddress': '10.0.0.2'}}}}
q = {'instance': 'alpha', 'network': 'edge', 'path': '/v1/settings/deploy/commit', 'token': 't', 'body': {}}
def answer(body):
    def opener(req, timeout=0):
        raise urllib.error.HTTPError(req.full_url, 422, 'x', {}, io.BytesIO(json.dumps(body).encode()))
    return opener
def call(body):
    urllib.request.urlopen = answer(body)
    return m.api(q)
r = call({'code': 'validation_failed', 'reason_code': 'pack_source_conflict', 'error': 'Pack soot-brand da duoc cai.\x07\x1b[31m\n  Ngung source cu.'})
assert r['status'] == 422 and r['error']['code'] == 'validation_failed' and r['error']['reason'] == 'pack_source_conflict', r
assert r['error']['message'] == 'Pack soot-brand da duoc cai. [31m Ngung source cu.', r
assert len(call({'code': 'validation_failed', 'reason_code': 'x', 'error': 'y' * 5000})['error']['message']) == 400
# Hostile code/reason never get through; a message that only repeats the code is dropped.
r = call({'code': 'A/../b', 'reason_code': '../../etc', 'error': 'request_rejected'})
assert r['error'] == {'code': 'request_rejected', 'reason': 'request_rejected'}, r
assert 'message' not in call({'code': 'validation_failed', 'reason_code': 'request_rejected', 'error': 'validation_failed'})['error']
assert 'message' not in call({'code': 'validation_failed', 'reason_code': 'request_rejected', 'error': {'nested': 1}})['error']
print('reject reasons verified')
`;
  expect((await run(['python3', '-B', '-c', program])).trim()).toBe('reject reasons verified');
});
