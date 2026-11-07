// Randomized slice schedule: no fixed cadence, no fixed size, exact total.

const WEIGHT_SCALE = 1_000_000;

/**
 * Split `total` into `slices` pieces spread over `horizonMs`.
 *
 * Each slice gets its own slot of width horizon/slices and lands at a random
 * point around the slot centre, so the order of slices is preserved and two
 * slices never collide. Sizes vary around the even size by up to `sizeJitter`
 * and are then rescaled so they add up to `total` exactly.
 *
 * @param {object} p
 * @param {bigint} p.total total input in base units
 * @param {number} p.slices number of slices, at least 1
 * @param {number} p.horizonMs working window in milliseconds
 * @param {number} [p.timeJitter] 0..1, share of a slot a slice may move off-centre
 * @param {number} [p.sizeJitter] 0..1, max relative deviation from the even size
 * @param {bigint} [p.minSlice] smallest slice allowed, in base units
 * @param {() => number} p.rand uniform [0, 1)
 * @returns {{ index: number, atMs: number, amount: bigint }[]}
 */
export function buildSchedule({ total, slices, horizonMs, timeJitter = 0, sizeJitter = 0, minSlice = 0n, rand }) {
  if (typeof total !== 'bigint' || total <= 0n) throw new Error('total must be a positive bigint');
  if (!Number.isInteger(slices) || slices < 1) throw new Error('slices must be an integer >= 1');
  if (!(horizonMs > 0)) throw new Error('horizonMs must be positive');
  for (const [name, value] of [['timeJitter', timeJitter], ['sizeJitter', sizeJitter]]) {
    if (!(value >= 0 && value <= 1)) throw new Error(`${name} must be between 0 and 1`);
  }
  if (total < BigInt(slices) * minSlice) {
    throw new Error(`total is smaller than ${slices} slices of the minimum size; use fewer slices`);
  }

  const slot = horizonMs / slices;
  const weights = [];
  const times = [];
  for (let i = 0; i < slices; i++) {
    const offset = (rand() * 2 - 1) * timeJitter * (slot / 2);
    times.push(Math.round((i + 0.5) * slot + offset));
    weights.push(BigInt(Math.round((1 + (rand() * 2 - 1) * sizeJitter) * WEIGHT_SCALE)));
  }

  // Every slice gets the minimum first; the rest is shared by the random
  // weights. Floor division leaves a remainder of a few units, which goes to
  // the last slice so the total stays exact.
  const weightSum = weights.reduce((a, b) => a + b, 0n);
  const spare = total - BigInt(slices) * minSlice;
  const amounts = weights.map((w) => minSlice + (spare * w) / weightSum);
  amounts[slices - 1] += total - amounts.reduce((a, b) => a + b, 0n);

  return amounts.map((amount, index) => ({ index, atMs: times[index], amount }));
}

/**
 * The most any one slice of `buildSchedule` can be, for every seed: one slice
 * draws the largest weight and all others the smallest, plus the remainder of
 * at most `slices` units that goes to the last slice. A larger minimum slice
 * only lowers this bound, so it holds for any `minSlice`, whatever price
 * converted `minSliceUsd` into units. Splits and deferrals never make a slice
 * larger, so no swap of the order can exceed it.
 *
 * @param {object} p
 * @param {bigint} p.total total input in base units
 * @param {number} p.slices number of slices
 * @param {number} [p.sizeJitter] 0..1, as passed to buildSchedule
 * @returns {bigint}
 */
export function largestPossibleSlice({ total, slices, sizeJitter = 0 }) {
  if (typeof total !== 'bigint' || total <= 0n) throw new Error('total must be a positive bigint');
  if (!Number.isInteger(slices) || slices < 1) throw new Error('slices must be an integer >= 1');
  if (!(sizeJitter >= 0 && sizeJitter <= 1)) throw new Error('sizeJitter must be between 0 and 1');
  const most = BigInt(Math.round((1 + sizeJitter) * WEIGHT_SCALE));
  const least = BigInt(Math.round((1 - sizeJitter) * WEIGHT_SCALE));
  const n = BigInt(slices);
  return (total * most) / (most + (n - 1n) * least) + n;
}
