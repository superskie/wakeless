import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { HOST, devHandler, resolveStatic } from '../scripts/static-files.mjs';
import { agentProxy } from '../src/agent/proxy.mjs';

const PORT = 8787;
const AGENT = 'a'.repeat(64);

/** A throwaway root shaped like the repo, holding the private files a leak would expose. */
function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wakeless-serve-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = {
    '.env': 'DUMMY_KEY=dummy-value-for-tests\n',
    '.git/config': '[core] dummy\n',
    'CLAUDE.md': 'dummy private notes\n',
    'notes/n.md': 'dummy private\n',
    'journals/run.jsonl': '{"dummy":"private"}\n',
    'live/agent.mjs': 'export const dummy = "private";\n',
    'index.html': '<h1>site</h1>',
    'web/home.html': '<h1>home</h1>',
    'web/index.html': '<h1>desk</h1>',
    'web/.hidden': 'dummy private',
    'src/x.mjs': 'export const x = 1;\n',
  };
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return root;
}

/** Drives a node:http style handler with a fake request and response. */
function call(handler, { method = 'GET', url, host = `localhost:${PORT}`, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
    Object.assign(req, { method, url, headers: { ...(host === null ? {} : { host }), ...headers }, socket: { remoteAddress: '127.0.0.1' } });
    const res = {
      status: 0,
      headers: {},
      headersSent: false,
      writeHead(status, h = {}) {
        this.status = status;
        this.headers = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
        this.headersSent = true;
      },
      end(data) {
        resolve({ status: this.status, headers: this.headers, body: data === undefined ? '' : Buffer.from(data).toString('utf8') });
      },
      destroy: () => reject(new Error('response destroyed')),
    };
    try {
      handler(req, res);
    } catch (err) {
      reject(err);
    }
  });
}

const noProxy = () => assert.fail('no proxy call expected');

test('the dev server serves its folders and nothing else, Windows-style paths included', async (t) => {
  const root = makeRoot(t);
  const handler = devHandler({ root, landing: 'web/home.html', port: PORT, proxy: noProxy });
  const served = [
    ['/', '<h1>home</h1>'],
    ['/web/', '<h1>desk</h1>'],
    ['/web/home.html', '<h1>home</h1>'],
    ['/web/home.html?v=1', '<h1>home</h1>'],
    ['/web/%68ome.html', '<h1>home</h1>'],
    ['/src/x.mjs', 'export const x = 1;\n'],
  ];
  for (const [url, body] of served) {
    const res = await call(handler, { url });
    assert.equal(res.status, 200, url);
    assert.equal(res.body, body, url);
    assert.equal(res.headers['x-content-type-options'], 'nosniff', url);
  }
  const refused = [
    // dotfiles and the folders that are not served
    '/.env', '/.git/config', '/CLAUDE.md', '/notes/n.md', '/journals/run.jsonl', '/live/agent.mjs', '/web/.hidden', '/index.html',
    // dot segments, plain and encoded
    '/web/../.env', '/web/%2e%2e/.env', '/web/%2E%2E/%2Eenv', '/web/x/..%2f..%2f.env', '/web/./home.html', '/src/../web/home.html',
    // backslashes, the Windows separator, raw and encoded
    '/web/x%5c..%5c..%5c.env', '/web/x%5C..%5C..%5C.env', '/web\\..\\.env', '/web/x\\..\\..\\.env', '/web/..%5c.env',
    '/web/x%5c..%5c..%5c.git%5cconfig', '/web/x%5c..%5c..%5cCLAUDE.md', '/web/x%5c..%5c..%5cjournals%5crun.jsonl', '/web/x%5c..%5c..%5cnotes%5cn.md',
    // drive letters and NTFS stream names
    '/web/home.html::$DATA', '/web/home.html%3a%3a$DATA', '/.env::$DATA', '/web/x%5c..%5c..%5c.env::$DATA', '/C:/Windows/win.ini', '/c%3a/windows/win.ini',
    // bad escapes and NUL, which used to crash the process
    '/%', '/web/%', '/web/%00', '/web/home.html%00.png', '/web/%E0%A4%A',
    // empty segments, case and missing files
    '//web/home.html', '/web//home.html', '/WEB/home.html', '/Web/home.html', '/web/nothing.html', '/web', '',
  ];
  for (const url of refused) {
    const res = await call(handler, { url });
    assert.equal(res.status, 404, url);
    assert.doesNotMatch(res.body, /dummy|private/, url);
  }
  assert.equal((await call(handler, { method: 'POST', url: '/web/home.html' })).status, 405);
  assert.equal(resolveStatic(root, 'web/home.html', { landing: 'web/home.html' }), null, 'a path must start with a slash');
  assert.equal(resolveStatic(root, '/web/home.html', { landing: 'web/home.html' }), path.join(root, 'web', 'home.html'));
});

test('the built site serves its root page and still no private file', async (t) => {
  const root = makeRoot(t);
  const handler = devHandler({ root, landing: 'index.html', rootFiles: ['index.html'], port: PORT, proxy: noProxy });
  assert.equal((await call(handler, { url: '/' })).body, '<h1>site</h1>');
  assert.equal((await call(handler, { url: '/index.html' })).status, 200);
  for (const url of ['/.env', '/CLAUDE.md', '/index.html%5c..%5c.env', '/web/x%5c..%5c..%5c.env', '/web/index.html::$DATA']) {
    assert.equal((await call(handler, { url })).status, 404, url);
  }
});

test('the dev server answers only its own host names and listens on loopback', async (t) => {
  const root = makeRoot(t);
  const handler = devHandler({ root, landing: 'web/home.html', port: PORT, proxy: noProxy });
  for (const host of ['localhost:8787', '127.0.0.1:8787', '[::1]:8787', 'LOCALHOST:8787']) {
    assert.equal((await call(handler, { url: '/web/home.html', host })).status, 200, host);
  }
  const strangers = [null, '', 'evil.test', 'evil.test:8787', 'localhost', 'localhost:9999', '192.168.1.20:8787', 'localhost.evil.test:8787', '127.0.0.1.nip.io:8787'];
  for (const host of strangers) {
    for (const url of ['/web/home.html', '/.env', `/api/agent/v1/agents/${AGENT}`]) {
      assert.equal((await call(handler, { url, host })).status, 403, `${host} ${url}`);
    }
  }
  assert.equal(HOST, '127.0.0.1');
  const serve = fs.readFileSync(new URL('../scripts/serve.mjs', import.meta.url), 'utf8');
  assert.match(serve, /\.listen\(PORT, HOST,/, 'serve.mjs binds the loopback address');
});

test('the dev server runs /api/agent through the proxy, same-origin rule included', async () => {
  const calls = [];
  const upstream = async (url, init = {}) => {
    calls.push({ path: new URL(url).pathname, body: init.body });
    return Response.json({ ok: true }, { status: 202 });
  };
  const proxy = agentProxy({ apiKey: 'test-key', upstream: 'https://upstream.test', fetch: upstream });
  const handler = devHandler({ root: os.tmpdir(), landing: 'web/home.html', port: PORT, proxy });
  const url = `/api/agent/v1/agents/${AGENT}/deposit`;
  const body = JSON.stringify({ confidential: true, asset: 'nep141:base.omft.near' });
  const own = { 'content-type': 'application/json', origin: `http://localhost:${PORT}` };
  const post = (opts) => call(handler, { method: 'POST', url, body, ...opts });
  const ok = await post({ headers: own });
  assert.equal(ok.status, 202);
  assert.equal(ok.headers['content-security-policy'], "default-src 'none'; frame-ancestors 'none'; sandbox");
  assert.equal((await post({ host: '127.0.0.1:8787', headers: { ...own, origin: 'http://127.0.0.1:8787' } })).status, 202);
  assert.equal((await post({ headers: { ...own, origin: 'http://evil.test' } })).status, 403);
  assert.equal((await post({ headers: { ...own, origin: 'http://127.0.0.1:8787' } })).status, 403, 'the origin must match the Host it came in on');
  assert.equal((await post({ headers: { ...own, 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await post({ host: 'evil.test:8787', headers: { ...own, origin: 'http://evil.test:8787' } })).status, 403, 'a rebound name never reaches the proxy');
  assert.equal((await post({ headers: own, body: 'x'.repeat(70 * 1024) })).status, 413);
  assert.equal(calls.filter((c) => c.path.endsWith('/deposit')).length, 2);
  // The proxy sees the raw path, as on Pages: a dot segment is never normalised into a route.
  assert.equal((await call(handler, { url: '/api/agent/v1/agents/../tokens' })).status, 404);
  assert.equal((await call(handler, { url: '/api/agent/v1/tokens' })).status, 202);
});
