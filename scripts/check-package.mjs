import {readFileSync, readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join, relative} from 'node:path';
const [pack] = JSON.parse(readFileSync(process.argv[2], 'utf8'));
for (const {path} of pack.files) {
  if (/(^|\/)(deployments|node_modules|tests|\.2server|\.git)(\/|$)|\.local\.|\.tfstate|\.pem$|\.key$|(^|\/)\.env(?!\.example$)/.test(path)) throw new Error(`Private file in package: ${path}`);
}
for (const file of ['bin/2server.cjs', 'src/cli.ts', 'scripts/bootstrap.sh', 'skills/2server/SKILL.md']) {
  if (!pack.files.some(f => f.path === file)) throw new Error(`Missing ${file}`);
}
// Runtime imports, dynamic extension commands and YAML definitions all ship.
const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
const packed = new Set(pack.files.map(file => file.path));
function checkSources(dir) {
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) checkSources(file);
    else if (!packed.has('src/' + relative(sourceRoot, file)))
      throw new Error(`Missing runtime source/asset: ${relative(sourceRoot, file)}`);
  }
}
checkSources(sourceRoot);
console.log(`Verified ${pack.files.length} public package files`);
