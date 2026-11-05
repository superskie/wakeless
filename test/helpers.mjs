// Test doubles: a token list and a deterministic market that quotes like 1Click.

export const TOKENS = [
  { assetId: 'nep141:usdc.test', symbol: 'USDC', blockchain: 'arb', decimals: 6, price: 1 },
  { assetId: 'nep141:sol.test', symbol: 'SOL', blockchain: 'sol', decimals: 9, price: 96 },
];

/**
 * Quotes USDC -> SOL at `midRate` minus a cost that grows with size:
 * cost = feeBps + impactBps * (usd / 100k)^2, plus `extraBps` while `bad(t)` is true.
 * Above `capUsd` it answers like 1Click does: 400 "No liquidity available".
 */
export function fakeMarket({ clock, midRate = 0.0104, feeBps = 15, impactBps = 4, capUsd = 600_000, bad = () => false, extraBps = 0 } = {}) {
  const buyPrice = 1 / midRate; // USDC is $1, so SOL's USD price follows from the mid
  const calls = [];
  return {
    calls,
    async quote(body) {
      calls.push({ t: clock?.now() ?? 0, amount: body.amount, request: body });
      const inHuman = Number(BigInt(body.amount)) / 1e6;
      if (inHuman > capUsd) {
        return { ok: false, status: 400, latencyMs: 1, json: { message: 'No liquidity available' } };
      }
      let costBps = feeBps + impactBps * (inHuman / 100_000) ** 2;
      if (bad(clock?.now() ?? 0)) costBps += extraBps;
      const outHuman = inHuman * midRate * (1 - costBps / 10_000);
      const amountOut = BigInt(Math.floor(outHuman * 1e9));
      return {
        ok: true,
        status: 201,
        latencyMs: 1,
        json: {
          quote: {
            amountIn: body.amount,
            amountOut: amountOut.toString(),
            amountInUsd: String(inHuman),
            amountOutUsd: String((Number(amountOut) / 1e9) * buyPrice),
            minAmountOut: amountOut.toString(),
            timeEstimate: 10,
          },
        },
      };
    },
  };
}
