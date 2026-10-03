import {spawnSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, '.release');
function run(command, args, capture = false) {
  const p = spawnSync(command, args, {cwd: root, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8'});
  if (p.error) throw p.error;
  if (p.status !== 0) process.exit(p.status ?? 1);
  return p.stdout;
}
run('bun', ['run', 'check']);
run('node', ['scripts/check-docs.mjs']);
mkdirSync(output, {recursive: true});
const metadata = run('npm', ['pack', '--json', '--pack-destination', output], true);
const manifest = join(output, 'pack.json');
writeFileSync(manifest, metadata);
run('node', ['scripts/check-package.mjs', manifest]);
const [{filename, integrity}] = JSON.parse(metadata);
const artifact = join(output, filename);
run('node', ['scripts/smoke-package.mjs', artifact]);
console.log(`Release candidate verified: ${artifact}\nIntegrity: ${integrity}\nNot published. See docs/release.md for live checks and publishing.`);
