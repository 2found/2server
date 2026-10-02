#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');
const result = spawnSync('bun', [resolve(__dirname, '../src/cli.ts'), ...process.argv.slice(2)], { stdio: 'inherit' });
if (result.error) {
  console.error('2server requires Bun >= 1.3 on PATH. Install Bun, then rerun 2server.');
  process.exit(1);
}
process.exit(result.status ?? 1);
