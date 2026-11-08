// The local dev server's request handler, kept apart from scripts/serve.mjs so
// tests can drive it (Windows-style paths, a temporary root holding a dummy
// .env) without listen() and without reading .env. No dependencies.
import fs from 'node:fs';
import path from 'node:path';

/** The only top-level folders served. Everything else (.env, .git, notes, journals, live/) stays private. */
export const ALLOWED = new Set(['web', 'src', 'examples', 'research', 'brand']);
/** Loopback only: the server holds the partner key from .env, so nothing else on the network may reach it. */
export const HOST = '127.0.0.1';
export const PROXY_PREFIX = '/api/agent';
const MAX_PROXY_BODY = 64 * 1024;

export const TYPES = {
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
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * The file a request path names below `root`, or null. It checks the decoded
 * and resolved path, not the raw string: on Windows a backslash (%5c) is a
 * separator too, and a drive colon or an NTFS stream name (`::$DATA`) names
 * another file, so a check that only splits on '/' lets `.env` through.
 * @param {string} root the folder served
 * @param {string} rawPath the request path as sent, still percent-encoded, without the query
 * @param {{ landing: string, rootFiles?: string[] }} p the page for '/', and the files served from the root itself
 */
export function resolveStatic(root, rawPath, { landing, rootFiles = [] }) {
  let rel;
  try {
    rel = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (!rel.startsWith('/') || /[\\:\0]/.test(rel)) return null;
  rel = rel.slice(1);
  if (rel === '') rel = landing;
  else if (rel.endsWith('/')) rel += 'index.html';
  const parts = rel.split('/');
  if (parts.some((p) => p === '' || p.startsWith('.'))) return null;
  const base = path.resolve(root);
  const file = path.resolve(base, ...parts);
  const inside = path.relative(base, file);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return null;
  const segments = inside.split(path.sep);
  if (segments.some((s) => s.startsWith('.'))) return null;
  if (!ALLOWED.has(segments[0]) && !(segments.length === 1 && rootFiles.includes(segments[0]))) return null;
  return file;
}

/** Host headers the dev server answers. Any other name may be a page that rebound its DNS to this machine. */
export function allowedHosts(port) {
  const names = ['localhost', '127.0.0.1', '[::1]'];
  return new Set([...names.map((name) => `${name}:${port}`), ...(Number(port) === 80 ? names : [])]);
}

function reply(res, status, text, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(text);
}

/**
 * One /api/agent call through the proxy, as the Pages Function runs it: the
 * raw path (Pages does not decode it either), and the validated Host as the
 * request's origin, so the proxy's same-origin check holds locally too.
 */
async function forward(req, res, { host, raw, path: proxyPath, proxy }) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= MAX_PROXY_BODY) chunks.push(chunk);
  }
  if (size > MAX_PROXY_BODY) return reply(res, 413, 'request body too large');
  const method = String(req.method ?? 'GET').toUpperCase();
  const request = new Request(`http://${host}${raw}`, {
    method,
    headers: req.headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks),
  });
  const response = await proxy(request, { path: proxyPath, client: req.socket?.remoteAddress ?? 'local' });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

/**
 * The dev server's handler for http.createServer.
 * @param {object} p
 * @param {string} p.root the folder served
 * @param {string} p.landing the page for '/'
 * @param {string[]} [p.rootFiles] files served from the root itself
 * @param {number} p.port the port the server listens on, for the Host check
 * @param {(request: Request, ctx: { path: string, client: string }) => Promise<Response>} p.proxy the Agent API proxy
 */
export function devHandler({ root, landing, rootFiles = [], port, proxy }) {
  const hosts = allowedHosts(port);
  return (req, res) => {
    const host = String(req.headers.host ?? '').toLowerCase();
    if (!hosts.has(host)) return reply(res, 403, 'forbidden host');
    const raw = String(req.url ?? '');
    const pathname = raw.split(/[?#]/, 1)[0];
    if (pathname.startsWith(`${PROXY_PREFIX}/`)) {
      forward(req, res, { host, raw, path: pathname.slice(PROXY_PREFIX.length), proxy }).catch(() => {
        if (res.headersSent) res.destroy();
        else reply(res, 502, 'proxy error');
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, 'method not allowed', { allow: 'GET, HEAD' });
    const file = resolveStatic(root, pathname, { landing, rootFiles });
    if (!file) return reply(res, 404, 'not found');
    fs.readFile(file, (err, data) => {
      if (err) return reply(res, 404, 'not found');
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  };
}
