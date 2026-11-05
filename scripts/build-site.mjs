#!/usr/bin/env node
// Builds the hosted web desk into site/. It copies web/, the src modules the
// desk imports (followed from web/*.mjs) and the committed files it fetches,
// and nothing else, so .env, journals and keys can not reach the host.
//
//   node scripts/build-site.mjs
//   node scripts/serve.mjs --root site     (check the build locally)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'site');

const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
const DATA_RE = /['"](\.\.\/(?:examples|research)\/[^'"]+)['"]/g;

const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

function assertSafe(file) {
  const r = rel(file);
  if (r.startsWith('..') || r.split('/').some((part) => part.startsWith('.'))) throw new Error(`refusing to ship ${r}`);
  if (!fs.existsSync(file)) throw new Error(`missing ${r}`);
}

/** Every module reachable from the entry points, plus the data files they fetch. */
function collect(entries) {
  const modules = new Set();
  const data = new Set();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop();
    if (modules.has(file)) continue;
    assertSafe(file);
    modules.add(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORT_RE)) queue.push(path.resolve(path.dirname(file), m[1] ?? m[2]));
    for (const m of text.matchAll(DATA_RE)) {
      const target = path.resolve(path.dirname(file), m[1]);
      assertSafe(target);
      data.add(target);
    }
  }
  return { modules, data };
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    if (d.name.startsWith('.')) return [];
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : [p];
  });
}

function copy(file) {
  const target = path.join(OUT, path.relative(ROOT, file));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(file, target);
  return fs.statSync(file).size;
}

const webDir = path.join(ROOT, 'web');
const webFiles = walk(webDir);
const { modules, data } = collect(webFiles.filter((f) => f.endsWith('.mjs')));
const files = [...new Set([...webFiles, ...modules, ...data])].sort();

fs.rmSync(OUT, { recursive: true, force: true });
let bytes = 0;
for (const file of files) bytes += copy(file);
// Cloudflare Pages reads _redirects; the root opens the desk.
fs.writeFileSync(path.join(OUT, '_redirects'), '/ /web/ 302\n');

const outside = files.filter((f) => !f.startsWith(webDir + path.sep)).map(rel);
console.log(`site/: ${files.length} files, ${(bytes / 1024).toFixed(0)} KiB`);
console.log(`outside web/: ${outside.join(', ')}`);
