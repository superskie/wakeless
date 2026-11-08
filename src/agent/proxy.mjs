// The site's Agent API proxy: a Cloudflare Pages Function in production
// (functions/api/agent/[[path]].js) and the same handler in scripts/serve.mjs
// locally. The Agent API wants the partner key on every call and answers no
// CORS preflight, so the page calls this same-origin path and the handler adds
// the key. It forwards only the calls the desk makes, refuses owner intents
// that break the hosted rules, and limits each client address.
import { PRICE_MAX_AGE_MS, checkHostedIntent } from './hosted.mjs';

export const DEFAULT_UPSTREAM = 'https://api.demo.agentsonintents.com';
const AGENT = '[A-Za-z0-9_-]{8,128}';
const ROUTES = [
  { method: 'GET', path: /^\/v1\/tokens$/ },
  { method: 'GET', path: /^\/v1\/status$/, query: ['correlation_id', 'wait_ms'], bucket: 'status' },
  { method: 'POST', path: /^\/v1\/generate-intent$/, check: 'intent' },
  { method: 'POST', path: /^\/v1\/submit-intent$/ },
  { method: 'GET', path: new RegExp(`^/v1/agents/${AGENT}$`) },
  { method: 'GET', path: new RegExp(`^/v1/agents/${AGENT}/policy$`) },
  { method: 'GET', path: new RegExp(`^/v1/agents/${AGENT}/balances$`), query: ['source'] },
  { method: 'POST', path: new RegExp(`^/v1/agents/${AGENT}/deposit$`), check: 'confidential' },
  { method: 'POST', path: new RegExp(`^/v1/agents/${AGENT}/swap$`), check: 'confidential', grant: true },
  { method: 'POST', path: new RegExp(`^/v1/agents/${AGENT}/withdraw$`), check: 'confidential', grant: true },
];
const MAX_BODY = 32 * 1024;
const MAX_WAIT_MS = 30_000;
/** Status long-polls one client may hold at once: the Agent API keeps only a few per partner key. */
const MAX_WAITS = 2;
const MAX_KEYS = 10_000;

// Every answer is JSON that the desk reads with fetch, never a document: no
// sniffing, no framing, no script, whatever upstream sends.
const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
};
// Statuses whose Response must have no body (new Response throws otherwise).
const NULL_BODY = new Set([204, 205, 304]);
const JSON_REQUEST = /^application\/json\s*(?:;|$)/i;
const JSON_ANSWER = /^application\/(?:[a-z0-9.+-]+\+)?json\s*(?:;|$)/i;

function problem(status, code, detail, extra = {}) {
  return new Response(JSON.stringify({ errors: [{ code, title: code.replace(/_/g, ' '), detail, layer: 'proxy' }] }), {
    status,
    headers: { ...HEADERS, ...extra },
  });
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The eight 16-bit groups of an IPv6 address, or null when it is not one. */
function ipv6Groups(text) {
  let head = text;
  const tail = [];
  const v4 = text.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const b = v4.slice(2).map(Number);
    if (b.some((x) => x > 255)) return null;
    tail.push((b[0] << 8) | b[1], (b[2] << 8) | b[3]);
    head = v4[1].endsWith('::') ? v4[1] : v4[1].slice(0, -1);
  }
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const split = (s) => (s ? s.split(':') : []);
  const left = split(halves[0]);
  const right = split(halves[1]);
  const fill = 8 - tail.length - left.length - right.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const groups = [...left, ...Array(halves.length === 1 ? 0 : fill).fill('0'), ...right];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return [...groups.map((g) => parseInt(g, 16)), ...tail];
}

/**
 * The key a client is counted under: its IPv4 address, or the /64 of an IPv6
 * one, since one host usually holds a whole /64 and could rotate through it.
 */
export function clientKey(address) {
  const text = String(address ?? '').trim().toLowerCase().replace(/%.*$/, '');
  if (!text.includes(':')) return text || 'unknown';
  const g = ipv6Groups(text);
  if (!g) return text.slice(0, 64);
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join('.');
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

/**
 * Fixed windows per client address, in memory. Best effort: each edge
 * instance counts on its own. One map per window length, kept in order of
 * window start, so a full map drops its oldest entries instead of forgetting
 * every client at once.
 */
export function windowLimiter({ now = () => Date.now(), maxKeys = MAX_KEYS } = {}) {
  const windows = new Map();
  return {
    allow(key, limit, windowMs) {
      const t = now();
      let hits = windows.get(windowMs);
      if (!hits) windows.set(windowMs, (hits = new Map()));
      const slot = hits.get(key);
      if (slot && t - slot.start < windowMs) {
        slot.count += 1;
        return slot.count <= limit;
      }
      hits.delete(key);
      for (const [k, s] of hits) {
        if (hits.size < maxKeys && t - s.start < windowMs) break;
        hits.delete(k);
      }
      hits.set(key, { start: t, count: 1 });
      return true;
    },
  };
}

/**
 * Status long-polls in flight per client. An entry also expires on its own,
 * in case a cancelled request never reaches its `finally`.
 */
export function waitGate({ now = () => Date.now(), max = MAX_WAITS, ttlMs = MAX_WAIT_MS + 15_000, maxKeys = MAX_KEYS } = {}) {
  const open = new Map();
  return {
    /** A release function, or null when the client already holds `max` waits. */
    enter(key) {
      const t = now();
      const live = (open.get(key) ?? []).filter((start) => t - start < ttlMs);
      if (live.length >= max) {
        open.set(key, live);
        return null;
      }
      const mark = t;
      live.push(mark);
      open.delete(key);
      if (open.size >= maxKeys) open.delete(open.keys().next().value);
      open.set(key, live);
      return () => {
        const list = open.get(key);
        const i = list ? list.indexOf(mark) : -1;
        if (i >= 0) list.splice(i, 1);
        if (list && !list.length) open.delete(key);
      };
    },
  };
}

// [requests, window] per client. Status polls have their own bucket, so a desk
// that polls hard can still swap, withdraw, read balances and freeze.
const LIMITS = { all: [600, 600_000], status: [600, 600_000], create: [5, 3_600_000], intent: [40, 3_600_000] };

/**
 * Would a browser have sent this for another site? Browsers mark requests
 * with Sec-Fetch-Site and every POST with Origin, so a third-party page can
 * neither post through a visitor's browser nor spend the visitor's limits. A
 * direct caller can claim anything; the limits and the hosted rules still hold.
 */
function crossSite(request, method) {
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'none') return true;
  if (method !== 'POST') return false;
  const origin = request.headers.get('origin');
  if (origin !== null) return origin !== new URL(request.url).origin;
  return site !== 'same-origin';
}

/** The body as text, or null once it is larger than MAX_BODY: reading stops there. */
async function readBody(request) {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > MAX_BODY) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  // Like request.text(): UTF-8, a leading BOM dropped.
  return new TextDecoder().decode(bytes);
}

/**
 * The parsed body, or an error. The proxy forwards what it parsed, so a
 * number that would not come out of JSON.stringify as written (beyond 2^53,
 * 1.0, 1e3) is refused rather than changed on the way.
 */
function parseJson(text) {
  let lossy = false;
  let value;
  try {
    value = JSON.parse(text, (key, v, context) => {
      if (typeof v === 'number' && typeof context?.source === 'string' && JSON.stringify(v) !== context.source) lossy = true;
      return v;
    });
  } catch {
    return { error: 'the body is not JSON' };
  }
  if (lossy) return { error: 'a number in the body would change on the way; send it as a string' };
  if (!isObject(value)) return { error: 'the body is a JSON object' };
  return { value };
}

/** Upstream's answer under the proxy's own headers, or a problem when it is not JSON. */
async function relay(res) {
  const headers = { ...HEADERS };
  const retry = res.headers.get('retry-after');
  if (retry !== null && /^[0-9]{1,6}$/.test(retry)) headers['retry-after'] = retry;
  if (res.status < 200 || res.status > 599) return problem(502, 'upstream_bad_status', `the Agent API answered with status ${res.status}`);
  if (NULL_BODY.has(res.status)) {
    await res.body?.cancel().catch(() => {});
    return new Response(null, { status: res.status, headers });
  }
  const type = res.headers.get('content-type');
  if (type !== null && !JSON_ANSWER.test(type)) {
    await res.body?.cancel().catch(() => {});
    return problem(502, 'upstream_not_json', `the Agent API answered ${res.status} with something other than JSON`);
  }
  return new Response(await res.text(), { status: res.status, headers });
}

/** Token prices from the Agent API, kept for a few minutes per instance. */
function tokenPrices({ upstream, apiKey, fetcher, now, ttlMs = PRICE_MAX_AGE_MS }) {
  let cache = null;
  let at = 0;
  return async () => {
    if (cache && now() - at < ttlMs) return cache;
    const res = await fetcher(`${upstream}/v1/tokens`, {
      headers: { accept: 'application/json', 'x-api-key': apiKey },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`token list ${res.status}`);
    const json = await res.json();
    const list = Array.isArray(json) ? json : json.tokens ?? json.data ?? [];
    cache = new Map(list.map((t) => [t.asset_id, { price: Number(t.price), decimals: t.decimals }]));
    at = now();
    return cache;
  };
}

/**
 * @param {object} config
 * @param {string} config.apiKey partner key, from a Pages secret
 * @param {string} [config.upstream] Agent API origin
 * @param {typeof fetch} [config.fetch]
 * @param {() => number} [config.now]
 */
export function agentProxy({ apiKey, upstream = DEFAULT_UPSTREAM, fetch: fetcher = (...a) => globalThis.fetch(...a), now = () => Date.now(), limiter = windowLimiter({ now }), waits = waitGate({ now }) }) {
  const prices = tokenPrices({ upstream, apiKey, fetcher, now });

  /**
   * @param {Request} request
   * @param {{ path: string, client: string }} p path after the proxy prefix, client address
   */
  async function handle(request, { path, client }) {
    if (!apiKey) return problem(503, 'proxy_not_configured', 'the live desk is not configured on this host');
    const method = request.method.toUpperCase();
    if (crossSite(request, method)) return problem(403, 'cross_site', "only the desk's own pages call this proxy");
    const who = clientKey(client);
    const route = ROUTES.find((r) => r.method === method && r.path.test(path));
    // A miss counts against the client too: it still runs this function.
    const bucket = route?.bucket ?? 'all';
    if (!limiter.allow(`${bucket}:${who}`, ...LIMITS[bucket])) return problem(429, 'rate_limited', 'too many requests from this address; wait a few minutes');
    if (!route) return problem(404, 'not_proxied', `${method} ${String(path).slice(0, 200)} is not one of the calls the desk makes`);

    const url = new URL(request.url);
    const target = new URL(`${upstream}${path}`);
    for (const name of route.query ?? []) {
      const value = url.searchParams.get(name);
      if (value === null) continue;
      if (name === 'wait_ms') target.searchParams.set(name, String(Math.max(0, Math.min(MAX_WAIT_MS, Number(value) || 0))));
      else if (name === 'source' && value !== 'public' && value !== 'confidential') return problem(400, 'bad_query', 'source is public or confidential');
      else target.searchParams.set(name, value);
    }

    const headers = { accept: 'application/json', 'x-api-key': apiKey };
    const idem = request.headers.get('idempotency-key');
    if (idem) {
      if (!/^[A-Za-z0-9_.:-]{8,200}$/.test(idem)) return problem(400, 'bad_idempotency_key', 'unexpected idempotency key format');
      headers['idempotency-key'] = idem;
    }
    if (route.grant) {
      const grant = request.headers.get('x-grant-token');
      if (!grant || !/^ngt_[A-Za-z0-9_-]{43}$/.test(grant)) return problem(401, 'grant_required', 'this call runs under the order grant');
      headers['x-grant-token'] = grant;
    }

    let body;
    if (method === 'POST') {
      // A JSON content type forces a CORS preflight from any other origin, which this proxy never answers.
      if (!JSON_REQUEST.test(request.headers.get('content-type') ?? '')) return problem(415, 'json_required', 'send the body as application/json');
      const text = await readBody(request);
      if (text === null) return problem(413, 'body_too_large', 'request body too large');
      const parsed = parseJson(text);
      if (parsed.error) return problem(400, 'bad_json', parsed.error);
      const json = parsed.value;
      if (route.check === 'confidential' && json.confidential !== true) {
        return problem(422, 'confidential_required', 'the desk sends every deposit, swap and withdrawal in confidential form');
      }
      if (route.check === 'intent') {
        if (!limiter.allow(`intent:${who}`, ...LIMITS.intent)) return problem(429, 'rate_limited', 'too many owner actions from this address; wait an hour');
        if (json.type === 'agent_create' && !limiter.allow(`create:${who}`, ...LIMITS.create)) {
          return problem(429, 'rate_limited', 'too many new wallets from this address; wait an hour');
        }
        let book;
        try {
          book = await prices();
        } catch {
          return problem(503, 'prices_unavailable', 'could not read token prices to check the order size');
        }
        const verdict = checkHostedIntent(json, { priceOf: (id) => book.get(id) ?? null, now: now() });
        if (!verdict.ok) return problem(422, 'hosted_rule', verdict.reason);
      }
      headers['content-type'] = 'application/json';
      // Upstream gets the object checked here, encoded again: a duplicate key
      // or any other parser difference can not show it something else.
      body = JSON.stringify(json);
    }

    const longPoll = route.bucket === 'status' && Number(target.searchParams.get('wait_ms')) > 0;
    const release = longPoll ? waits.enter(who) : () => {};
    if (!release) return problem(429, 'too_many_waits', `at most ${MAX_WAITS} status waits at a time from one address`, { 'retry-after': '2' });
    try {
      // Workers' fetch takes only 'follow' or 'manual'; a redirect is passed back, never followed.
      const res = await fetcher(target, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(90_000) });
      return await relay(res);
    } catch (err) {
      return problem(502, 'upstream_unreachable', `the Agent API did not answer (${err?.name ?? 'error'})`);
    } finally {
      release();
    }
  }

  // Whatever goes wrong inside, the caller gets a JSON problem under the proxy's headers.
  return async function guarded(request, context) {
    try {
      return await handle(request, context);
    } catch (err) {
      return problem(500, 'proxy_failed', `the proxy could not handle this call (${err?.name ?? 'error'})`);
    }
  };
}
