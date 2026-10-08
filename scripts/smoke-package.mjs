import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cpSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const artifact = resolve(process.argv[2] ?? '');
assert(process.argv[2]?.endsWith('.tgz'), 'Usage: node scripts/smoke-package.mjs PACKAGE.tgz');
const work = mkdtempSync(join(tmpdir(), '2server-package-'));
function run(command, args, expected = 0) {
  const result = spawnSync(command, args, {cwd: work, encoding: 'utf8', timeout: 120_000,
    env: {...process.env, NODE_ENV: 'production', PATH: join(work, 'node_modules/.bin') + ':' + process.env.PATH}});
  if (result.error) throw result.error;
  assert.equal(result.status, expected, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout + result.stderr;
}
try {
  writeFileSync(join(work, 'package.json'), '{"private":true}');
  run('npm', ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', artifact]);
  const cli = join(work, 'node_modules/.bin/2srv');
  const help = run(cli, ['help']);
  assert.match(help, /init app NAME/);
  assert.equal(run(join(work, 'node_modules/.bin/2server'), ['help']), help);
  assert.match(help, /Use 2srv/);
  assert.doesNotMatch(help, /remove-recovery|check-backup/);
  mkdirSync(join(work, 'project'));
  run(cli, ['init', 'server', 'smoke', '-o', 'project/server.local.json']);
  run(cli, ['server', 'bootstrap', '-f', 'project/server.local.json']); // offline; no SSH
  run(cli, ['init', 'app', 'api', '-o', 'project/api.yaml']);
  run(cli, ['validate', '-f', 'project/api.yaml']);
  const root = join(work, 'node_modules/@2server/cli');
  for (const template of ['postgres', 'redis', 'nats', 'monitoring', 'image-proxy', 'url-shortener', 'email-routing']) {
    const file = `project/${template}.yaml`;
    run(cli, ['init', 'app', `smoke-${template}`, '--template', template, '-o', file]);
    run(cli, ['validate', '-f', file]);
  }
  cpSync(join(root, 'examples/soot/bundle'), join(work, 'project/bundle'), {recursive: true});
  cpSync(join(root, 'examples/soot/runtime-receipt.json'), join(work, 'project/runtime-receipt.json'));
  run(cli, ['init', 'app', 'smoke-soot', '--template', 'soot', '-o', 'project/soot.yaml']);
  run(cli, ['validate', '-f', 'project/soot.yaml']);
  run(cli, ['deploy', '-f', 'project/soot.yaml', '--apply'], 1); // reviewed artifact required before connection
  assert.ok(readFileSync(join(root, 'skills/2server/references/soot.md'), 'utf8').includes('reviewed_replacement'));
  // Init must not overwrite operator files; bad schema/unknown templates must fail.
  const before = readFileSync(join(work, 'project/api.yaml'), 'utf8');
  run(cli, ['init', 'app', 'api', '-o', 'project/api.yaml'], 1);
  assert.equal(readFileSync(join(work, 'project/api.yaml'), 'utf8'), before);
  run(cli, ['init', 'app', 'bad', '--template', 'not-installed', '-o', 'project/bad.yaml'], 1);
  writeFileSync(join(work, 'project/invalid.yaml'), 'apiVersion: unsupported\nkind: App\n');
  run(cli, ['validate', '-f', 'project/invalid.yaml'], 1);
  run(join(work, 'node_modules/.bin/2server'), ['validate', '-f', 'project/invalid.yaml'], 1);
  // A copied skill must work without sibling src/ or docs/ directories.
  const skill = join(work, 'copied-skill');
  cpSync(join(root, 'skills/2server'), skill, {recursive: true});
  assert.equal(run('bun', [join(skill, 'scripts/product-root.ts')]).trim(), realpathSync(root));
  const ssh = run('bun', [join(skill, 'scripts/ssh-command.ts'), 'project/server.local.json']);
  assert.match(ssh, /StrictHostKeyChecking=yes/);
  run('bun', [join(skill, 'scripts/ssh-command.ts'), 'project/invalid.yaml'], 1);
  assert.ok(readFileSync(join(root, 'AGENTS.md'), 'utf8').includes('Extension behavior belongs to the extension'));
  console.log('Installed tarball passed CLI, copied-skill helpers, bootstrap dry-run, all template schemas and rejection checks; no VM/cloud mutation');
} finally {
  rmSync(work, {recursive: true, force: true});
}
