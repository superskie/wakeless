// Turn an order file into a validated order with exact base-unit amounts.
import { resolveAsset } from './assets.mjs';
import { toUnits } from './units.mjs';

export const DEFAULTS = Object.freeze({
  slices: 10,
  horizonMinutes: 30,
  timeJitter: 0.8,
  sizeJitter: 0.3,
  maxAdverseBps: 50,
  maxDefers: 2,
  minSliceUsd: 100,
  slippageBps: 100,
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

  let minSliceUnits = 0n;
  if (s.minSliceUsd > 0) {
    if (!(sell.price > 0)) throw new Error(`no USD price for ${sell.ref}; set minSliceUsd to 0`);
    minSliceUnits = BigInt(Math.ceil((s.minSliceUsd / sell.price) * 10 ** sell.decimals));
  }

  for (const [name, ok] of [
    ['slices', Number.isInteger(s.slices) && s.slices >= 1 && s.slices <= 500],
    ['horizonMinutes', s.horizonMinutes > 0 && s.horizonMinutes <= 7 * 24 * 60],
    ['maxAdverseBps', s.maxAdverseBps >= 0 && s.maxAdverseBps <= 2_000],
    ['maxDefers', Number.isInteger(s.maxDefers) && s.maxDefers >= 0 && s.maxDefers <= 20],
    ['slippageBps', s.slippageBps > 0 && s.slippageBps <= 1_000],
  ]) {
    if (!ok) throw new Error(`invalid ${name}: ${s[name]}`);
  }

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
    deskAccount: s.deskAccount,
    deliverTo: s.deliverTo ?? null,
  };
}
