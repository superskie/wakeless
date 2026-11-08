#!/usr/bin/env node
// Builds the hosted web desk into site/. It copies web/, the src modules the
// desk imports (followed from web/*.mjs) and the committed files it fetches,
// and nothing else, so .env, journals and keys can not reach the host.
//
//   node scripts/build-site.mjs [out]     (default site/; WAKELESS_SITE_OUT works too)
//   node scripts/serve.mjs --root site     (check the build locally)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = outDir(process.argv[2] ?? process.env.WAKELESS_SITE_OUT);

/**
 * Where the build goes. The folder is wiped first, so inside the repo only
 * site/ itself is accepted, never a folder that holds the repo, and never a
 * folder with other files in it unless an earlier build (its _headers) is there.
 */
function outDir(arg) {
  const out = path.resolve(arg ?? path.join(ROOT, 'site'));
  const fromRoot = path.relative(ROOT, out);
  const inRepo = !fromRoot.startsWith('..') && !path.isAbsolute(fromRoot);
  const toRoot = path.relative(out, ROOT);
  const holdsRepo = !toRoot.startsWith('..') && !path.isAbsolute(toRoot);
  if ((inRepo && fromRoot !== 'site') || holdsRepo) throw new Error(`refusing to build into ${out}: inside the repo only site/ is a build folder`);
  if (fs.existsSync(out) && fs.readdirSync(out).length && !fs.existsSync(path.join(out, '_headers'))) {
    throw new Error(`refusing to build into ${out}: it holds files but no earlier build`);
  }
  return out;
}

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
    // web/dev/ holds pages that render images for the repo (the link card); they never ship.
    if (d.isDirectory() && p === path.join(ROOT, 'web', 'dev')) return [];
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
// The landing page is the root. It links everything by absolute path, so the
// same file works as /index.html here and as /web/home.html in the repo.
fs.copyFileSync(path.join(webDir, 'home.html'), path.join(OUT, 'index.html'));
// With a 404.html at the root, Pages answers unknown paths with it and a 404
// status instead of serving the landing page for every path.
fs.copyFileSync(path.join(webDir, '404.html'), path.join(OUT, '404.html'));
// Cloudflare Pages reads _redirects: one address for the landing page, which
// Pages would otherwise also serve as /web/home.
fs.writeFileSync(path.join(OUT, '_redirects'), '/web/home.html / 301\n/web/home / 301\n');
// Pages reads _headers too (for static files only; the proxy sets its own).
// The desk asks a wallet for signatures, so no other site may frame it, and
// the page may only call its own proxy and 1Click. It embeds no frames,
// workers or media, and its fonts are its own; blob: URLs are only download
// links, which img-src does not govern. Scripts are not restricted further:
// some wallet extensions inject theirs.
fs.writeFileSync(
  path.join(OUT, '_headers'),
  [
    '/*',
    '  X-Frame-Options: DENY',
    "  Content-Security-Policy: frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'; connect-src 'self' https://1click.chaindefuser.com; img-src 'self' data:; font-src 'self'; media-src 'none'; frame-src 'none'; worker-src 'none'; manifest-src 'self'",
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: strict-origin-when-cross-origin',
    '  Permissions-Policy: camera=(), microphone=(), geolocation=()',
    '',
  ].join('\n'),
);

const outside = files.filter((f) => !f.startsWith(webDir + path.sep)).map(rel);
console.log(`${rel(OUT)}/: ${files.length} files, ${(bytes / 1024).toFixed(0)} KiB`);
console.log(`outside web/: ${outside.join(', ')}`);
