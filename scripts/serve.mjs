#!/usr/bin/env node
// Static server for the web desk. Serves only web/, src/, examples/ and
// research/, never dotfiles, so .env can not leak. No dependencies.
// /api/agent/* runs the same Agent API proxy as the hosted site's Pages
// Function, with the partner key read from .env on this machine.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentProxy } from '../src/agent/proxy.mjs';
import { readEnvFile } from '../src/env.mjs';

// --root site serves the hosted build from scripts/build-site.mjs instead.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootAt = process.argv.indexOf('--root');
const ROOT = rootAt >= 0 ? path.resolve(REPO, process.argv[rootAt + 1]) : REPO;
const PORT = Number(process.env.PORT) || 8787;
const ALLOWED = new Set(['web', 'src', 'examples', 'research']);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

const env = readEnvFile(path.join(REPO, '.env'));
const proxy = agentProxy({ apiKey: env.NEAR_INTENTS_AGENT_API_KEY, upstream: env.NEAR_INTENTS_AGENT_API_URL || undefined });
const PROXY_PREFIX = '/api/agent';

async function proxyRequest(req, res, url) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
  const response = await proxy(request, { path: url.pathname.slice(PROXY_PREFIX.length), client: req.socket.remoteAddress ?? 'local' });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith(`${PROXY_PREFIX}/`)) {
    proxyRequest(req, res, url).catch(() => {
      res.writeHead(502);
      res.end('proxy error');
    });
    return;
  }
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  // The root is the landing page: web/home.html in the repo, its copy index.html in the build.
  if (rel === '') rel = ROOT === REPO ? 'web/home.html' : 'index.html';
  if (rel.endsWith('/')) rel += 'index.html';
  const parts = rel.split('/');
  const rootPage = ROOT !== REPO && rel === 'index.html';
  if ((!rootPage && !ALLOWED.has(parts[0])) || parts.some((p) => p.startsWith('.') || p === '')) {
    res.writeHead(404);
    return res.end('not found');
  }
  const file = path.join(ROOT, ...parts);
  if (!file.startsWith(ROOT + path.sep)) {
    res.writeHead(404);
    return res.end('not found');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`Wakeless web: http://localhost:${PORT}/web/`));
