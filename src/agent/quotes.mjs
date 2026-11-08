// Live price source: the agent's own swap preview, requested through its grant
// and checked against its signed policy. Responses are shaped like 1Click
// quotes, so the engine, the guard and the report treat a live slice exactly
// like a dry-run one, and the guard judges the route the swap will really take.
import { toNumber } from '../units.mjs';
import { safeErrorText } from '../oneclick.mjs';

/** Agent API token list in the shape the order code expects. */
export function toDeskTokens(list) {
  return list.map((t) => ({
    assetId: t.asset_id,
    symbol: t.symbol,
    blockchain: t.blockchain,
    decimals: t.decimals,
    price: t.price ?? null,
    priceUpdatedAt: t.price_updated_at ?? null,
  }));
}

/** USD token prices from the Agent API, cached for `ttlMs`. */
export function priceBook(api, { ttlMs = 30_000, now = () => Date.now() } = {}) {
  let cache = null;
  let loadedAt = 0;
  return {
    async tokens() {
      if (!cache || now() - loadedAt > ttlMs) {
        const res = await api.getTokens();
        const list = Array.isArray(res) ? res : res.tokens ?? res.data ?? [];
        if (!list.length) throw new Error('the Agent API returned no tokens');
        cache = toDeskTokens(list);
        loadedAt = now();
      }
      return cache;
    },
    async get(assetId) {
      const token = (await this.tokens()).find((t) => t.assetId === assetId);
      if (!token) throw new Error(`asset not listed by the Agent API: ${assetId}`);
      return token;
    },
  };
}

/**
 * @param {object} p
 * @param {{ swap: Function }} p.bot grant-scoped client (`api.forGrant(token)`)
 * @param {string} p.agentId
 * @param {{ get: (assetId: string) => Promise<object> }} p.prices
 * @param {boolean} [p.confidential] preview the confidential form of the swap
 */
export function agentQuoteClient({ bot, agentId, prices, confidential = true, clock = () => performance.now() }) {
  return {
    async quote(body) {
      const started = clock();
      const latency = () => Math.round(clock() - started);
      try {
        const preview = await bot.swap(agentId, {
          origin_asset: body.originAsset,
          destination_asset: body.destinationAsset,
          amount: String(body.amount),
          confidential,
          dry: true,
        });
        const [sell, buy] = await Promise.all([prices.get(body.originAsset), prices.get(body.destinationAsset)]);
        const amountIn = BigInt(body.amount);
        const amountOut = BigInt(preview.quote.amount_out);
        const priced = sell.price > 0 && buy.price > 0;
        return {
          ok: true,
          status: 200,
          latencyMs: latency(),
          json: {
            source: 'agent-api-preview',
            quote: {
              amountIn: amountIn.toString(),
              amountOut: amountOut.toString(),
              minAmountOut: preview.quote.min_amount_out ?? null,
              amountInUsd: priced ? String(toNumber(amountIn, sell.decimals) * sell.price) : null,
              amountOutUsd: priced ? String(toNumber(amountOut, buy.decimals) * buy.price) : null,
              timeEstimate: preview.quote.time_estimate_seconds ?? null,
            },
            confidential,
            fee: preview.fee ?? null,
            spend: preview.spend ?? null,
            warnings: preview.warnings ?? [],
          },
        };
      } catch (err) {
        return {
          ok: false,
          status: err?.status ?? 0,
          latencyMs: latency(),
          // The message is journaled, so a header value the runtime quoted in it is cut out.
          json: { source: 'agent-api-preview', message: safeErrorText(err), code: err?.code ?? null },
        };
      }
    },
  };
}
