// The site's Agent API proxy: a Cloudflare Pages Function in production
// (functions/api/agent/[[path]].js) and the same handler in scripts/serve.mjs
// locally. The Agent API wants the partner key on every call and answers no
// CORS preflight, so the page calls this same-origin path and the handler adds
// the key. It forwards only the calls the desk makes, refuses owner intents
// that break the hosted rules, and limits each client address.
import { checkHostedIntent } from './hosted.mjs';

export const DEFAULT_UPSTREAM = 'https://api.demo.agentsonintents.com';
const AGENT = '[A-Za-z0-9_-]{8,128}';
const ROUTES = [
  { method: 'GET', path: /^\/v1\/tokens$/ },
  { method: 'GET', path: /^\/v1\/status$/, query: ['correlation_id', 'wait_ms'] },
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

function problem(status, code, detail) {
  return new Response(JSON.stringify({ errors: [{ code, title: code.replace(/_/g, ' '), detail, layer: 'proxy' }] }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** Fixed windows per client address, in memory. Best effort: each edge instance counts on its own. */
export function windowLimiter({ now = () => Date.now() } = {}) {
  const hits = new Map();
  return {
    allow(key, limit, windowMs) {
      const t = now();
      const slot = hits.get(key);
      if (!slot || t - slot.start >= windowMs) {
        if (hits.size > 10_000) hits.clear();
        hits.set(key, { start: t, count: 1 });
        return true;
      }
      slot.count += 1;
      return slot.count <= limit;
    },
  };
}

const LIMITS = { all: [600, 600_000], create: [5, 3_600_000], intent: [40, 3_600_000] };

/** Token prices from the Agent API, kept for a few minutes per instance. */
function tokenPrices({ upstream, apiKey, fetcher, now, ttlMs = 300_000 }) {
  let cache = null;
  let at = 0;
  return async () => {
    if (cache && now() - at < ttlMs) return cache;
    const res = await fetcher(`${upstream}/v1/tokens`, { headers: { accept: 'application/json', 'x-api-key': apiKey } });
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
export function agentProxy({ apiKey, upstream = DEFAULT_UPSTREAM, fetch: fetcher = (...a) => globalThis.fetch(...a), now = () => Date.now(), limiter = windowLimiter({ now }) }) {
  const prices = tokenPrices({ upstream, apiKey, fetcher, now });

  /**
   * @param {Request} request
   * @param {{ path: string, client: string }} p path after the proxy prefix, client address
   */
  return async function handle(request, { path, client }) {
    if (!apiKey) return problem(503, 'proxy_not_configured', 'the live desk is not configured on this host');
    const method = request.method.toUpperCase();
    const route = ROUTES.find((r) => r.method === method && r.path.test(path));
    if (!route) return problem(404, 'not_proxied', `${method} ${path} is not one of the calls the desk makes`);
    if (!limiter.allow(`all:${client}`, ...LIMITS.all)) return problem(429, 'rate_limited', 'too many requests from this address; wait a few minutes');

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
      const text = await request.text();
      if (text.length > MAX_BODY) return problem(413, 'body_too_large', 'request body too large');
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        return problem(400, 'bad_json', 'the body is not JSON');
      }
      if (route.check === 'confidential' && json.confidential !== true) {
        return problem(422, 'confidential_required', 'the desk sends every deposit, swap and withdrawal in confidential form');
      }
      if (route.check === 'intent') {
        if (!limiter.allow(`intent:${client}`, ...LIMITS.intent)) return problem(429, 'rate_limited', 'too many owner actions from this address; wait an hour');
        if (json?.type === 'agent_create' && !limiter.allow(`create:${client}`, ...LIMITS.create)) {
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
      body = text;
    }

    let res;
    try {
      // Workers' fetch takes only 'follow' or 'manual'; a redirect is passed back, never followed.
      res = await fetcher(target, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(90_000) });
    } catch (err) {
      return problem(502, 'upstream_unreachable', `the Agent API did not answer (${err?.name ?? 'error'})`);
    }
    return new Response(await res.text(), {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' },
    });
  };
}
