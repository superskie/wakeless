// Thin client for the NEAR Intents 1Click API (https://docs.near-intents.org).
import { toNumber } from './units.mjs';

export const DEFAULT_BASE = 'https://1click.chaindefuser.com';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Node's fetch quotes a header value it refuses in full ('Headers.append:
// "<value>" is an invalid header value.'), and that value is an API key or a
// grant token. Greedy from the first quote, so a value holding quotes is cut too.
const QUOTED_HEADER_VALUE = /"[\s\S]*"(?=\s*is an invalid header value)/gi;

/**
 * An error's message, safe to print, journal or save: any header value the
 * runtime quoted is cut out, and so is every string in `secrets`.
 * @param {unknown} err
 * @param {(string|undefined)[]} [secrets]
 */
export function safeErrorText(err, secrets = []) {
  let text = String(err?.message ?? err ?? '');
  for (const secret of secrets) if (secret) text = text.split(secret).join('<redacted>');
  return text.replace(QUOTED_HEADER_VALUE, '"<redacted>"');
}

/**
 * @param {object} [opts]
 * @param {string} [opts.base]
 * @param {string} [opts.apiKey] partner key, sent as X-API-Key when present
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs] longer than 1Click's own 25 s wait for its solvers
 * @param {number} [opts.retries] extra attempts after a 429, a 5xx or a network error;
 *   a timeout is tried again only once, because the next try usually times out too
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 */
export function createOneClick({
  base = DEFAULT_BASE,
  apiKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
  retries = 2,
  sleep = pause,
} = {}) {
  async function request(method, path, body) {
    let lastFailure;
    let timeouts = 0;
    for (let attempt = 0; attempt <= retries; attempt++) {
      // Back off only after the server has refused once; the first try is immediate.
      if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
      const started = Date.now();
      try {
        const headers = { accept: 'application/json' };
        if (body) headers['content-type'] = 'application/json';
        if (apiKey) headers['x-api-key'] = apiKey;
        const res = await fetchImpl(base + path, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await res.text();
        let json;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = { message: text.slice(0, 300) };
        }
        const result = { ok: res.ok, status: res.status, json, latencyMs: Date.now() - started };
        if (res.status === 429 || res.status >= 500) {
          lastFailure = result;
          // 1Click answers 500 "Failed to receive response within timeout" when its own solvers are slow.
          if (res.status >= 500 && /timeout/i.test(String(json?.message ?? '')) && ++timeouts > 1) break;
          continue;
        }
        return result;
      } catch (err) {
        const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        lastFailure = {
          ok: false,
          status: 0,
          // Name who did not answer; the AbortError text reads like a local failure.
          json: { message: timedOut ? `1Click did not answer within ${Math.round(timeoutMs / 1000)} s` : safeErrorText(err, [apiKey]) },
          latencyMs: Date.now() - started,
        };
        if (timedOut && ++timeouts > 1) break;
      }
    }
    return lastFailure;
  }

  return {
    base,
    hasKey: Boolean(apiKey),
    tokens: () => request('GET', '/v0/tokens'),
    quote: (body) => request('POST', '/v0/quote', body),
  };
}

/**
 * Quote body for a swap that starts and ends inside NEAR Intents. This is how
 * the desk works an order: one deposit in, many internal slices, one
 * withdrawal out, so per-slice bridge minimums and withdrawal fees never apply.
 */
export function intentsQuoteBody({
  sellAsset,
  buyAsset,
  amount,
  account,
  dry = true,
  slippageBps = 100,
  deadlineMs = 30 * 60_000,
  now = Date.now(),
}) {
  return {
    dry,
    swapType: 'EXACT_INPUT',
    slippageTolerance: slippageBps,
    originAsset: sellAsset,
    depositType: 'INTENTS',
    destinationAsset: buyAsset,
    amount: amount.toString(),
    refundTo: account,
    refundType: 'INTENTS',
    recipient: account,
    recipientType: 'INTENTS',
    deadline: new Date(now + deadlineMs).toISOString(),
  };
}

/**
 * Reduce a raw quote response to the numbers the desk decides on.
 *
 * `costBps` is the all-in cost against the USD mid prices 1Click reports with
 * the quote (fees, spread and price impact together). `midRate` is the output
 * per unit of input those mid prices imply at the same moment.
 */
export function normalizeQuote(res, { sellDecimals, buyDecimals, amountIn }) {
  const q = res?.json?.quote;
  if (res?.ok && q?.amountOut) {
    const amountOut = BigInt(q.amountOut);
    const inHuman = toNumber(amountIn, sellDecimals);
    const outHuman = toNumber(amountOut, buyDecimals);
    const inUsd = Number(q.amountInUsd);
    const outUsd = Number(q.amountOutUsd);
    const pricesKnown = inUsd > 0 && outUsd > 0;
    return {
      ok: true,
      amountIn,
      amountOut,
      rate: outHuman / inHuman,
      inUsd,
      outUsd,
      costBps: pricesKnown ? (1 - outUsd / inUsd) * 10_000 : null,
      midRate: pricesKnown ? (inUsd * outHuman) / (outUsd * inHuman) : null,
      minAmountOut: q.minAmountOut ?? null,
      timeEstimate: q.timeEstimate ?? null,
      latencyMs: res.latencyMs,
      // Agent API previews say here when the real request would be refused.
      warnings: Array.isArray(res.json.warnings) ? res.json.warnings : [],
    };
  }
  const message = res?.json?.message ?? `HTTP ${res?.status}`;
  const code = res?.json?.code ?? null;
  return {
    ok: false,
    status: res?.status ?? 0,
    message,
    code,
    // 1Click says "No liquidity available"; the Agent API says
    // "No route or liquidity is available" with code route_unavailable.
    noLiquidity: /no liquidity|no route/i.test(message) || code === 'route_unavailable',
    // The owner froze, archived or deleted the agent: no later slot will quote.
    refused: STOP_CODES.has(code),
    latencyMs: res?.latencyMs ?? null,
  };
}

/** Agent API refusals that waiting does not fix. They stop the order instead of deferring it. */
export const STOP_CODES = new Set(['wallet_frozen', 'agent_archived', 'agent_deleted']);
