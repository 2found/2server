import {readFileSync, readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join, relative} from 'node:path';
const [pack] = JSON.parse(readFileSync(process.argv[2], 'utf8'));
for (const {path} of pack.files) {
  if (/(^|\/)(deployments|node_modules|tests|\.2server|\.git|\.release)(\/|$)|\.local\.|\.tfstate|\.(pem|key|p12|pfx|age|tfplan|tgz)$|(^|\/)\.env(?!\.example$)|(^|\/)secrets\.(env|json|ya?ml)$/.test(path)) throw new Error(`Private file in package: ${path}`);
}
for (const file of ['AGENTS.md', 'BRANDING.md', 'README.md', 'CHANGELOG.md', 'docs/release.md', 'bin/2server.cjs', 'src/cli.ts', 'scripts/bootstrap.sh', 'scripts/metadata-firewall.py', 'skills/2server/SKILL.md', 'terraform/gcp/access.tf', 'terraform/gcp/access/main.tf']) {
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
