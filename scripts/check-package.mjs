import {readFileSync} from 'node:fs';
const [pack] = JSON.parse(readFileSync(process.argv[2], 'utf8'));
for (const {path} of pack.files) {
  if (/(^|\/)(deployments|node_modules|tests|\.2server|\.git)(\/|$)|\.local\.|\.tfstate|\.pem$|\.key$|(^|\/)\.env(?!\.example$)/.test(path)) throw new Error(`Private file in package: ${path}`);
}
for (const file of ['bin/2server.cjs', 'src/cli.ts', 'scripts/bootstrap.sh', 'skills/2server/SKILL.md']) {
  if (!pack.files.some(f => f.path === file)) throw new Error(`Missing ${file}`);
}
console.log(`Verified ${pack.files.length} public package files`);
