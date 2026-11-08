// The decision rule for one slice. Pure, so every outcome has a test.

export const Action = Object.freeze({
  EXECUTE: 'execute',
  DEFER: 'defer',
  SPLIT: 'split',
  SKIP: 'skip',
  STOP: 'stop',
});

/** How many times one scheduled slice may be halved: at most 8 pieces, so a dry market can not cause a quote storm. */
export const MAX_SPLITS = 3;

/**
 * Decide what to do with a slice given its fresh quote.
 *
 * - A quote at or above the floor executes.
 * - A quote below the floor waits for a later slot, up to `maxDefers` times.
 * - "No liquidity" splits the slice in two while both halves stay above
 *   `minSlice` (never below 1 unit), because smaller sizes usually clear when
 *   large ones cannot. A split is a retry at a smaller size, so it needs a
 *   retry and time left, like a wait, and at most `maxSplits` splits deep.
 * - A refusal that waiting can not fix (the owner froze the wallet) stops the
 *   whole order at once, and so does a floor that is not a positive rate.
 * - Any other failed quote waits like a bad price does.
 * - When retries or time run out, the slice is skipped and reported as unfilled.
 *   The desk never lowers the floor to finish an order.
 *
 * @param {object} p
 * @param {{ ok: boolean, rate?: number, noLiquidity?: boolean, refused?: boolean, code?: string, message?: string }} p.quote
 * @param {number} p.floorRate minimum acceptable output per unit of input
 * @param {bigint} p.amount slice size in base units
 * @param {bigint} p.minSlice smallest piece a split may leave
 * @param {number} p.defers how many times this slice already waited or split
 * @param {number} p.maxDefers
 * @param {boolean} p.timeLeft whether a later slot still fits in the window
 * @param {number} [p.splits] how many splits deep this slice already is
 * @param {number} [p.maxSplits]
 * @param {boolean} [p.splitTimeLeft] whether a split's second half still fits in the window
 * @returns {{ action: string, reason: string }}
 */
export function decide({ quote, floorRate, amount, minSlice, defers, maxDefers, timeLeft, splits = 0, maxSplits = MAX_SPLITS, splitTimeLeft = timeLeft }) {
  const canWait = defers < maxDefers && timeLeft;
  if (!(floorRate > 0)) return { action: Action.STOP, reason: 'no_floor' };

  if (!quote.ok) {
    if (quote.refused) return { action: Action.STOP, reason: `refused_${quote.code}` };
    const smallest = minSlice > 1n ? minSlice : 1n;
    const canSplit = defers < maxDefers && splitTimeLeft && splits < maxSplits;
    if (quote.noLiquidity && canSplit && amount / 2n >= smallest) {
      return { action: Action.SPLIT, reason: 'no_liquidity_split' };
    }
    if (canWait) return { action: Action.DEFER, reason: quote.noLiquidity ? 'no_liquidity_wait' : 'quote_failed_wait' };
    return { action: Action.SKIP, reason: quote.noLiquidity ? 'no_liquidity_exhausted' : 'quote_failed_exhausted' };
  }

  if (quote.rate >= floorRate) return { action: Action.EXECUTE, reason: 'at_or_above_floor' };
  if (canWait) return { action: Action.DEFER, reason: 'below_floor_wait' };
  return { action: Action.SKIP, reason: 'below_floor_exhausted' };
}

/** Floor rate: the arrival rate minus the adverse move the client accepts. */
export function floorFrom(arrivalRate, maxAdverseBps) {
  return arrivalRate * (1 - maxAdverseBps / 10_000);
}
