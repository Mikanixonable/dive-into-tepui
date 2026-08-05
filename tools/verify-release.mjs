import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const conflictPattern = /^(<<<<<<<|=======|>>>>>>>)(?: .*)?$/m;
const sourceRoots = ['src', 'public'];
const sourceFiles = ['package.json', 'webpack.config.js', 'tsconfig.json'];
const sourceOnly = process.argv.includes('--source-only');

async function collectFiles(relativePath) {
  const absolutePath = path.join(root, relativePath);
  const entries = await readdir(absolutePath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.join(relativePath, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

const checkedFiles = [...sourceFiles];
for (const sourceRoot of sourceRoots) checkedFiles.push(...await collectFiles(sourceRoot));
checkedFiles.push('docs/index.html');

const conflicted = [];
for (const file of checkedFiles) {
  const contents = await readFile(path.join(root, file), 'utf8');
  if (conflictPattern.test(contents)) conflicted.push(file);
}
if (conflicted.length > 0) {
  throw new Error(`Unresolved conflict marker(s): ${conflicted.join(', ')}`);
}

if (sourceOnly) {
  console.log(`Source verification passed: ${checkedFiles.length} files have no conflict markers.`);
  process.exit(0);
}

const html = await readFile(path.join(root, 'docs/index.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map((match) => match[1]);
const entryScripts = scripts.filter((src) => /(?:^|\/)main\.[a-f0-9]+\.js(?:[?#].*)?$/i.test(src));
if (scripts.length !== 1 || entryScripts.length !== 1) {
  throw new Error(
    `Expected one generated script and one main entry in docs/index.html; found scripts=${scripts.length}, main=${entryScripts.length}`,
  );
}

console.log(`Release verification passed: ${checkedFiles.length} files have no conflict markers; one entry script (${entryScripts[0]}).`);
