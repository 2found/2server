import {readFileSync, writeFileSync, appendFileSync} from 'node:fs';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/latest`);
if (!response.ok && response.status !== 404) throw new Error(`Registry returned ${response.status}`);
const latest = response.ok ? await response.json() : null;
if (latest?.gitHead && latest.gitHead === process.env.GITHUB_SHA) {
  appendFileSync(process.env.GITHUB_OUTPUT, 'skip=true\n');
} else {
  const parse = v => {
    if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`Expected stable semver: ${v}`);
    return v.split('.').map(Number);
  };
  const base = parse(pkg.version);
  if (latest) {
    const old = parse(latest.version);
    const newer = base[0] > old[0] || base[0] === old[0] && (base[1] > old[1] || base[1] === old[1] && base[2] > old[2]);
    if (!newer) pkg.version = `${old[0]}.${old[1]}.${old[2] + 1}`;
  }
  writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  console.log(`Publishing ${pkg.name}@${pkg.version}`);
}
