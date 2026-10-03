import {readFileSync, writeFileSync, appendFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

export function releaseVersion(baseVersion, latest, sha) {
  const parse = v => {
    if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`Expected stable semver: ${v}`);
    return v.split('.').map(Number);
  };
  const base = parse(baseVersion);
  if (latest?.gitHead && latest.gitHead === sha) return null;
  if (latest) {
    const old = parse(latest.version);
    const newer = base[0] > old[0] || base[0] === old[0] && (base[1] > old[1] || base[1] === old[1] && base[2] > old[2]);
    if (!newer) return `${old[0]}.${old[1]}.${old[2] + 1}`;
  }
  return baseVersion;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.GITHUB_SHA || !process.env.GITHUB_OUTPUT)
    throw new Error('Version selection writes CI metadata; run release:check for a local candidate');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/latest`, {signal: AbortSignal.timeout(30_000)});
  if (!response.ok && response.status !== 404) throw new Error(`Registry returned ${response.status}`);
  const latest = response.ok ? await response.json() : null;
  const version = releaseVersion(pkg.version, latest, process.env.GITHUB_SHA);
  if (version === null) appendFileSync(process.env.GITHUB_OUTPUT, 'skip=true\n');
  else {
    writeFileSync('package.json', JSON.stringify({...pkg, version}, null, 2) + '\n');
    console.log(`Publishing ${pkg.name}@${version}`);
  }
}
