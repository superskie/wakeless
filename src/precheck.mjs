// Pre-trade check: is slicing worth it for this order right now, and into how
// many slices? Every number comes from 1Click dry quotes taken back to back,
// so the comparison does not depend on how fresh the USD prices are.
import { intentsQuoteBody, normalizeQuote } from './oneclick.mjs';

export const PRECHECK_DEFAULTS = Object.freeze({
  // The size that stands in for "no size penalty".
  referenceUsd: 1_000,
  // Slice counts tried, smallest first. The check stops early once a slice
  // would be smaller than the reference or the order's minimum slice.
  candidates: [1, 2, 4, 8, 16, 32, 64],
  // A slice whose rate is within this distance of the reference rate counts
  // as paying no size penalty. Back-to-back quotes differ by about this much.
  toleranceBps: 2,
});

export const Advice = Object.freeze({
  ONE_SWAP: 'one_swap',
  SLICE: 'slice',
  CLOSEST: 'closest',
  NO_QUOTES: 'no_quotes',
});

/**
 * @param {object} p
 * @param {object} p.order from prepareOrder
 * @param {{ quote: (body: object) => Promise<object> }} p.client
 * @param {number} [p.referenceUsd]
 * @param {number[]} [p.candidates]
 * @param {number} [p.toleranceBps]
 * @param {number} [p.maxSlices] the most slices the caller can run
 * @param {() => number} [p.now] wall clock in ms
 * @param {(row: object) => void} [p.onRow] called after each slice count is quoted
 */
export async function precheck({
  order,
  client,
  referenceUsd = PRECHECK_DEFAULTS.referenceUsd,
  candidates = PRECHECK_DEFAULTS.candidates,
  toleranceBps = PRECHECK_DEFAULTS.toleranceBps,
  maxSlices = 500,
  now = () => Date.now(),
  onRow = () => {},
}) {
  const { sell, buy, totalUnits } = order;
  const quoteFor = async (amount) => {
    const request = intentsQuoteBody({
      sellAsset: sell.assetId,
      buyAsset: buy.assetId,
      amount,
      account: order.deskAccount,
      slippageBps: order.slippageBps,
      now: now(),
    });
    const res = await client.quote(request);
    const q = normalizeQuote(res, { sellDecimals: sell.decimals, buyDecimals: buy.decimals, amountIn: amount });
    return { request, status: res.status, response: res.json, q };
  };

  const takenAt = new Date(now()).toISOString();
  let referenceUnits = sell.price > 0 ? BigInt(Math.round((referenceUsd / sell.price) * 10 ** sell.decimals)) : totalUnits;
  if (referenceUnits <= 0n || referenceUnits > totalUnits) referenceUnits = totalUnits;
  const reference = { amount: referenceUnits, ...(await quoteFor(referenceUnits)) };

  const counts = [...new Set(candidates)].filter((n) => Number.isInteger(n) && n >= 1 && n <= maxSlices).sort((a, b) => a - b);
  const rows = [];
  for (const slices of counts) {
    const amount = totalUnits / BigInt(slices);
    // Slices smaller than the reference cannot beat it, and the engine will
    // not send slices below the order's minimum.
    if (slices > 1 && (amount < referenceUnits || amount < order.minSliceUnits)) break;
    const row = { slices, amount, ...(await quoteFor(amount)) };
    rows.push(row);
    onRow(row);
  }

  const refRate = reference.q.ok ? reference.q.rate : null;
  const one = rows.find((r) => r.slices === 1);
  const oneRate = one?.q.ok ? one.q.rate : null;
  for (const row of rows) {
    // Positive: this slice size receives less per unit than the reference.
    row.penaltyBps = refRate && row.q.ok ? (1 - row.q.rate / refRate) * 10_000 : null;
    // Positive: slicing at this count receives more than one swap would,
    // assuming solvers quote every slice like the first.
    row.vsOneSwapBps = oneRate && row.q.ok ? (row.q.rate / oneRate - 1) * 10_000 : null;
  }

  const usable = rows.filter((r) => r.penaltyBps != null);
  let advice;
  let pick = null;
  if (!usable.length) {
    advice = Advice.NO_QUOTES;
  } else {
    // One quote per size is noisy: a solver missing from one auction can make
    // a mid-size slice look worse than a bigger one. Take the smallest count
    // from which every larger count tried also fits, so one lucky reading
    // cannot set the advice.
    const fits = (r) => r.penaltyBps <= toleranceBps;
    pick = usable.find((r, i) => usable.slice(i).every(fits));
    if (pick) {
      advice = pick.slices === 1 ? Advice.ONE_SWAP : Advice.SLICE;
    } else {
      pick = usable.reduce((best, r) => (r.penaltyBps < best.penaltyBps ? r : best));
      advice = Advice.CLOSEST;
    }
  }

  return {
    takenAt,
    sell,
    buy,
    totalUnits,
    totalUsd: sell.price > 0 ? Number(order.amount) * sell.price : null,
    referenceUsd: referenceUnits === totalUnits && sell.price > 0 ? Number(order.amount) * sell.price : referenceUsd,
    toleranceBps,
    reference,
    rows,
    oneSwapFills: Boolean(one?.q.ok),
    oneSwapMessage: one && !one.q.ok ? one.q.message : null,
    advice,
    recommendedSlices: pick?.slices ?? null,
    pick,
  };
}

// Readings inside rounding show as +0.0, not -0.0.
const fixed = (value, digits = 1) => {
  const v = Math.abs(value) < 0.5 * 10 ** -digits ? 0 : value;
  return (v >= 0 ? '+' : '') + v.toFixed(digits);
};
const dollars = (usd) => `$${Math.round(usd).toLocaleString('en-US')}`;

/** One paragraph of advice, shared by the command line and the web desk. */
export function adviceText(result) {
  const { advice, pick, toleranceBps, totalUsd } = result;
  const ref = `a ${dollars(result.referenceUsd)} swap`;
  if (advice === Advice.NO_QUOTES) {
    return result.reference.q.ok
      ? 'No slice size got a usable quote. Try a smaller order or another pair.'
      : `1Click did not quote the reference swap (${result.reference.q.message}). Try again later.`;
  }
  const sliceUsd = totalUsd ? totalUsd / pick.slices : null;
  const one = result.rows.find((r) => r.slices === 1);
  if (advice === Advice.ONE_SWAP) {
    return (
      `One swap is enough right now: the whole order pays ${fixed(pick.penaltyBps)} bps against ${ref}, inside the ` +
      `${toleranceBps} bps tolerance. Slicing would only give the price time to move.`
    );
  }
  const against = result.oneSwapFills
    ? `one swap of the whole order pays ${fixed(one.penaltyBps)} bps`
    : `one swap of the whole order gets no quote (${result.oneSwapMessage})`;
  const gain =
    pick.vsOneSwapBps != null
      ? ` Expected: about ${fixed(pick.vsOneSwapBps)} bps more than one swap${totalUsd ? `, ${dollars((pick.vsOneSwapBps / 10_000) * totalUsd)}` : ''}, if solvers quote every slice like the first.`
      : '';
  if (advice === Advice.SLICE) {
    return (
      `Use ${pick.slices} slices${sliceUsd ? ` of about ${dollars(sliceUsd)}` : ''}: each pays ${fixed(pick.penaltyBps)} bps ` +
      `against ${ref}, inside the ${toleranceBps} bps tolerance, while ${against}.${gain}`
    );
  }
  return (
    `No slice count tried gets inside the ${toleranceBps} bps tolerance. ${pick.slices} slices come closest at ` +
    `${fixed(pick.penaltyBps)} bps against ${ref}, while ${against}.${gain}`
  );
}
