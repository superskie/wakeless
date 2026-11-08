import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'scripts', 'build-site.mjs');
const build = (out) => execFileSync(process.execPath, [SCRIPT, out], { cwd: REPO, stdio: 'pipe', encoding: 'utf8' });

/** Every file below `dir`, as forward-slash paths relative to it. */
function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p, base) : [path.relative(base, p).split(path.sep).join('/')];
  });
}

const tempDir = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('the site build ships the desk and none of the private files', (t) => {
  const out = tempDir(t, 'wakeless-site-');
  build(out);
  const files = walk(out);
  for (const must of ['index.html', '404.html', '_headers', '_redirects', 'web/index.html', 'web/home.html', 'web/live.mjs', 'src/agent/hosted.mjs']) {
    assert.ok(files.includes(must), `${must} ships`);
  }
  const banned = [/(^|\/)\./, /^\.env/, /^journals\//, /^notes\//, /^CLAUDE\.md$/i, /^brand\//, /^live\//, /^web\/dev\//, /^src\/agent\/proxy\.mjs$/, /^src\/env\.mjs$/, /^scripts\//, /^functions\//, /^test\//, /^bin\//, /node_modules/];
  for (const file of files) for (const re of banned) assert.doesNotMatch(file, re, `${file} must not ship`);

  const headers = fs.readFileSync(path.join(out, '_headers'), 'utf8');
  const csp = headers.match(/Content-Security-Policy: (.*)/)?.[1] ?? '';
  const directives = new Map(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values.join(' ')]));
  const expected = {
    'frame-ancestors': "'none'",
    'base-uri': "'none'",
    'object-src': "'none'",
    'form-action': "'self'",
    'connect-src': "'self' https://1click.chaindefuser.com",
    'img-src': "'self' data:",
    'font-src': "'self'",
    'media-src': "'none'",
    'frame-src': "'none'",
    'worker-src': "'none'",
    'manifest-src': "'self'",
  };
  for (const [name, value] of Object.entries(expected)) assert.equal(directives.get(name), value, name);
  assert.ok(!directives.has('script-src') && !directives.has('default-src'), 'scripts stay open: wallet extensions inject theirs');
  assert.doesNotMatch(csp, /blob:/);
  assert.match(headers, /X-Content-Type-Options: nosniff/);
  assert.match(headers, /X-Frame-Options: DENY/);

  // A second build over the first one is allowed: it holds _headers.
  build(out);
  assert.deepEqual(walk(out).sort(), files.sort());
});

test('the build refuses folders it must not wipe', (t) => {
  const busy = tempDir(t, 'wakeless-busy-');
  fs.writeFileSync(path.join(busy, 'keep.txt'), 'not a build');
  assert.throws(() => build(busy), /holds files but no earlier build/);
  assert.ok(fs.existsSync(path.join(busy, 'keep.txt')), 'nothing was deleted');
  // Inside the repo only site/ itself is a build folder.
  const nested = path.join(REPO, 'site', 'nested-test-build');
  t.after(() => fs.rmSync(nested, { recursive: true, force: true }));
  assert.throws(() => build(nested), /only site\/ is a build folder/);
  assert.ok(!fs.existsSync(nested));
});
