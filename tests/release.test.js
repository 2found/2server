import {expect, test} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {releaseVersion} from '../scripts/npm-version.mjs';

test('release version respects source bumps, advances registry patches and skips a published commit', () => {
  expect(releaseVersion('0.2.0', null, 'new')).toBe('0.2.0');
  expect(releaseVersion('0.2.0', {version:'0.2.9'}, 'new')).toBe('0.2.10');
  expect(releaseVersion('0.3.0', {version:'0.2.9'}, 'new')).toBe('0.3.0');
  expect(releaseVersion('1.0.0', {version:'0.9.9'}, 'new')).toBe('1.0.0');
  expect(releaseVersion('0.2.9', {version:'0.2.9'}, 'new')).toBe('0.2.10');
  expect(releaseVersion('0.2.0', {version:'0.2.9',gitHead:'same'}, 'same')).toBeNull();
  expect(() => releaseVersion('0.2.0', {version:'invalid'}, 'new')).toThrow('stable semver');
  expect(() => releaseVersion('0.2.0-beta.1', null, 'new')).toThrow('stable semver');
});

test('package gate rejects sensitive artifacts and missing runtime assets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'two-pack-gate-'));
  const script = fileURLToPath(new URL('../scripts/check-package.mjs', import.meta.url));
  const file = join(dir, 'pack.json');
  try {
    for (const path of ['.env', 'docs/secrets.env', 'docs/key.pem', 'docs/control.age', '.release/candidate.tgz', 'terraform/gcp/terraform.tfstate']) {
      writeFileSync(file, JSON.stringify([{files:[{path}]}]));
      const result = spawnSync('node', [script, file], {encoding:'utf8'});
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Private file in package');
    }
    writeFileSync(file, JSON.stringify([{files:[]}]));
    let result = spawnSync('node', [script, file], {encoding:'utf8'});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing AGENTS.md');
    writeFileSync(file, JSON.stringify([{files:[{path:'AGENTS.md'}]}]));
    result = spawnSync('node', [script, file], {encoding:'utf8'});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing BRANDING.md');
    writeFileSync(file, JSON.stringify([{files:[{path:'AGENTS.md'}, {path:'BRANDING.md'}]}]));
    result = spawnSync('node', [script, file], {encoding:'utf8'});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing README.md');
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
