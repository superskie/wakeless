// Turn an order file into a validated order with exact base-unit amounts.
import { resolveAsset } from './assets.mjs';
import { fromUnits, toUnits } from './units.mjs';

const maxBigint = (a, b) => (a > b ? a : b);

export const DEFAULTS = Object.freeze({
  slices: 10,
  horizonMinutes: 30,
  timeJitter: 0.8,
  sizeJitter: 0.3,
  maxAdverseBps: 50,
  maxDefers: 2,
  minSliceUsd: 100,
  slippageBps: 100,
  // The arrival probe sets every slice's floor. A probe this far under the
  // quoted USD mid is an outlier (a thin moment, a missing solver), not a price.
  maxProbeCostBps: 150,
  // Label used as refund and recipient in dry quotes. No funds ever reach it;
  // live mode replaces it with the agent's own NEAR Intents account.
  deskAccount: 'dry-run.wakeless.near',
});

/**
 * @param {object} spec parsed order file
 * @param {object[]} tokens response of GET /v0/tokens
 */
export function prepareOrder(spec, tokens) {
  const s = { ...DEFAULTS, ...spec };
  if (!s.id || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(s.id)) {
    throw new Error('order id must be 2-63 chars of lowercase letters, digits and dashes');
  }
  const sell = resolveAsset(tokens, s.sell);
  const buy = resolveAsset(tokens, s.buy);
  if (sell.assetId === buy.assetId) throw new Error('sell and buy must be different assets');

  const totalUnits = toUnits(s.amount, sell.decimals);
  if (totalUnits <= 0n) throw new Error('amount must be positive');

  for (const [name, ok] of [
    ['slices', Number.isInteger(s.slices) && s.slices >= 1 && s.slices <= 500],
    ['horizonMinutes', s.horizonMinutes > 0 && s.horizonMinutes <= 7 * 24 * 60],
    ['maxAdverseBps', s.maxAdverseBps >= 0 && s.maxAdverseBps <= 2_000],
    ['maxDefers', Number.isInteger(s.maxDefers) && s.maxDefers >= 0 && s.maxDefers <= 20],
    ['slippageBps', s.slippageBps > 0 && s.slippageBps <= 1_000],
    ['maxProbeCostBps', s.maxProbeCostBps > 0 && s.maxProbeCostBps <= 2_000],
  ]) {
    if (!ok) throw new Error(`invalid ${name}: ${s[name]}`);
  }

  // The smallest slice, in units of the sold asset: `minSlice` when the order
  // names one, else `minSliceUsd` at the token's USD price. Never below 1 unit,
  // because a slice of 0 is no swap at all.
  let minSliceUnits = 1n;
  if (s.minSlice != null) {
    minSliceUnits = toUnits(s.minSlice, sell.decimals);
  } else if (s.minSliceUsd > 0) {
    if (!(sell.price > 0)) {
      const suggestion = fromUnits(maxBigint(1n, totalUnits / BigInt(16 * (Number.isInteger(s.slices) ? s.slices : 1))), sell.decimals);
      throw new Error(`no USD price for ${sell.ref}, so minSliceUsd can not be converted; give the smallest slice in ${sell.symbol} instead, for example "minSlice": "${suggestion}"`);
    }
    minSliceUnits = BigInt(Math.ceil((s.minSliceUsd / sell.price) * 10 ** sell.decimals));
  }
  if (minSliceUnits < 1n) minSliceUnits = 1n;

  return {
    id: s.id,
    sell,
    buy,
    amount: String(s.amount),
    totalUnits,
    slices: s.slices,
    horizonMs: Math.round(s.horizonMinutes * 60_000),
    timeJitter: s.timeJitter,
    sizeJitter: s.sizeJitter,
    maxAdverseBps: s.maxAdverseBps,
    maxDefers: s.maxDefers,
    minSliceUsd: s.minSliceUsd,
    minSliceUnits,
    slippageBps: s.slippageBps,
    maxProbeCostBps: s.maxProbeCostBps,
    deskAccount: s.deskAccount,
    deliverTo: s.deliverTo ?? null,
  };
}
