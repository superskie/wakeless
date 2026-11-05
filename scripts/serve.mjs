#!/usr/bin/env node
// Static server for the web desk. Serves only web/, src/, examples/ and
// research/, never dotfiles, so .env can not leak. No dependencies.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (rel === '') {
    res.writeHead(302, { location: '/web/' });
    return res.end();
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const parts = rel.split('/');
  if (!ALLOWED.has(parts[0]) || parts.some((p) => p.startsWith('.') || p === '')) {
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
