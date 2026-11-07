// The slice cap: the owner signs an order's slice size into the agent's
// policy, so the wallet itself refuses any swap larger than one slice and any
// sale beyond the order in a day, whatever the desk sends. The Agent API
// counts both per asset (`limits.per_transaction` and `limits.daily`, in
// atomic units) across every grant. Pure functions, so every rule has a test.
import { largestPossibleSlice } from '../schedule.mjs';

/** The cap an order needs: per swap, the largest slice any seed can draw; per day, the order. */
export function capFor(order) {
  if (order.slices < 2) throw new Error('a one-slice order is one swap; there is no slice size to cap');
  const perSwap = largestPossibleSlice({ total: order.totalUnits, slices: order.slices, sizeJitter: order.sizeJitter });
  if (perSwap >= order.totalUnits) {
    throw new Error(`with sizeJitter ${order.sizeJitter} one slice can grow to the whole order; lower it below 1`);
  }
  return { assetId: order.sell.assetId, perSwap, perDay: order.totalUnits };
}

/** A copy of `policy` with the cap for one asset. Limits on other assets stay as they are. */
export function withSliceCap(policy, { assetId, perSwap, perDay }) {
  const limits = policy.limits ?? {};
  return {
    ...policy,
    limits: {
      ...limits,
      per_transaction: { ...(limits.per_transaction ?? {}), [assetId]: perSwap.toString() },
      daily: { ...(limits.daily ?? {}), [assetId]: perDay.toString() },
    },
  };
}

/**
 * Does the signed policy hold this order to one slice per swap?
 *
 * - `no_cap`: the wallet would accept the whole order as one swap.
 * - `cap_allows_whole_order`: there is a cap, but the whole order fits under it.
 * - `cap_below_slice`: the wallet would refuse one of this run's slices.
 * - `daily_below_order`: the wallet would stop the order before it is done.
 * - `capped`: every slice fits and the whole order as one swap does not.
 *
 * @param {object|null} policy the applied policy (`GET /v1/agents/{id}/policy`)
 * @param {{ assetId: string, schedule: { amount: bigint }[], total: bigint }} p
 */
export function checkSliceCap(policy, { assetId, schedule, total }) {
  const largest = schedule.reduce((max, s) => (s.amount > max ? s.amount : max), 0n);
  const read = (window) => {
    const raw = policy?.limits?.[window]?.[assetId];
    return raw == null ? null : BigInt(raw);
  };
  const perSwap = read('per_transaction');
  const perDay = read('daily');
  let reason = 'capped';
  if (perSwap === null) reason = 'no_cap';
  else if (perSwap >= total) reason = 'cap_allows_whole_order';
  else if (perSwap < largest) reason = 'cap_below_slice';
  else if (perDay !== null && perDay < total) reason = 'daily_below_order';
  return { ok: reason === 'capped', reason, perSwap, perDay, largest, total };
}
