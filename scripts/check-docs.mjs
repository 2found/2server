import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
function markdown(dir) {
  return readdirSync(dir, {withFileTypes: true}).flatMap(e =>
    e.isDirectory() ? markdown(join(dir, e.name)) : e.name.endsWith('.md') ? [join(dir, e.name)] : []);
}
const files = [join(root, 'README.md'), join(root, 'CHANGELOG.md'), ...markdown(join(root, 'docs')), ...markdown(join(root, 'skills'))];
const errors = [];
for (const file of files) {
  const content = readFileSync(file, 'utf8').replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
  for (const match of content.matchAll(/\]\(([^\s)]+)\)/g)) {
    const link = match[1];
    if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(link)) continue;
    const path = decodeURIComponent(link.split('#')[0]);
    if (!existsSync(resolve(dirname(file), path))) errors.push(`${file}: ${link}`);
  }
}
if (errors.length) throw new Error(`Broken local documentation links:\n${errors.join('\n')}`);
console.log(`Verified local file links in ${files.length} Markdown files (external URLs/anchors not checked)`);
