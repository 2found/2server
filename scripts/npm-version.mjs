import {appendFileSync, readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {compareVersions} from './release-plan.mjs';

// Source version, git tag and npm version are identical; never patch only the
// CI checkout. npm versions cannot be overwritten, even after a partial run.
export function releaseVersion(baseVersion, latest, sha) {
  compareVersions(baseVersion, baseVersion);
  if (!latest) return baseVersion;
  const order = compareVersions(baseVersion, latest.version);
  if (order === 0 && latest.gitHead === sha) return null;
  if (order <= 0) throw new Error('Bump package.json above the published npm version; version already belongs to another release');
  return baseVersion;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.env.GITHUB_OUTPUT) throw new Error('CI only; run release:check for a local candidate');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
  const read = async suffix => {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${suffix}`, {signal: AbortSignal.timeout(30_000)});
    if (!response.ok && response.status !== 404) throw new Error(`Registry returned ${response.status}`);
    return response.ok ? response.json() : null;
  };
  const exact = await read(pkg.version);
  // On a retry, latest may already point to a newer version. Inspect the exact
  // version first; skip only if npm confirms it came from this source commit.
  if (exact) {
    if (releaseVersion(pkg.version, exact, sha) !== null) throw new Error('Unexpected registry version');
    appendFileSync(process.env.GITHUB_OUTPUT, 'skip=true\n');
  } else {
    releaseVersion(pkg.version, await read('latest'), sha);
    console.log(`Publishing ${pkg.name}@${pkg.version} from ${sha}`);
  }
}
