// The decision rule for one slice. Pure, so every outcome has a test.

export const Action = Object.freeze({
  EXECUTE: 'execute',
  DEFER: 'defer',
  SPLIT: 'split',
  SKIP: 'skip',
  STOP: 'stop',
});

/**
 * Decide what to do with a slice given its fresh quote.
 *
 * - A quote at or above the floor executes.
 * - A quote below the floor waits for a later slot, up to `maxDefers` times.
 * - "No liquidity" splits the slice in two while both halves stay above
 *   `minSlice`, because smaller sizes usually clear when large ones cannot.
 * - A refusal that waiting can not fix (the owner froze the wallet) stops the
 *   whole order at once.
 * - Any other failed quote waits like a bad price does.
 * - When retries or time run out, the slice is skipped and reported as unfilled.
 *   The desk never lowers the floor to finish an order.
 *
 * @param {object} p
 * @param {{ ok: boolean, rate?: number, noLiquidity?: boolean, refused?: boolean, code?: string, message?: string }} p.quote
 * @param {number} p.floorRate minimum acceptable output per unit of input
 * @param {bigint} p.amount slice size in base units
 * @param {bigint} p.minSlice smallest slice allowed
 * @param {number} p.defers how many times this slice already waited
 * @param {number} p.maxDefers
 * @param {boolean} p.timeLeft whether a later slot still fits in the window
 * @returns {{ action: string, reason: string }}
 */
export function decide({ quote, floorRate, amount, minSlice, defers, maxDefers, timeLeft }) {
  const canWait = defers < maxDefers && timeLeft;

  if (!quote.ok) {
    if (quote.refused) return { action: Action.STOP, reason: `refused_${quote.code}` };
    if (quote.noLiquidity && amount / 2n >= minSlice) {
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
