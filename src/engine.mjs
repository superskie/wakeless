// Works one order: arrival snapshot, randomized slices, a price floor on every
// slice, and a journal entry for every decision.
import { buildSchedule } from './schedule.mjs';
import { Action, decide, floorFrom } from './guard.mjs';
import { intentsQuoteBody, normalizeQuote } from './oneclick.mjs';

function medianAmount(schedule) {
  const sorted = schedule.map((s) => s.amount).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * The order's slice schedule. `runOrder` draws it first from `rand`, so the
 * same seed gives the same schedule here and in the run.
 */
export function scheduleFor(order, rand) {
  return buildSchedule({
    total: order.totalUnits,
    slices: order.slices,
    horizonMs: order.horizonMs,
    timeJitter: order.timeJitter,
    sizeJitter: order.sizeJitter,
    minSlice: order.minSliceUnits,
    rand,
  });
}

/** What the journal keeps of a quote: the exact request, the raw response and the numbers used. */
function snapshot({ body, res, q }) {
  return { request: body, status: res.status, latencyMs: res.latencyMs, response: res.json, q };
}

/**
 * Cost of a fill against the USD mid quoted with it. When the settled amount
 * differs from the quoted one (live fills), the output value is scaled to it.
 */
function realizedCostBps(q, amountOut) {
  if (!(q.inUsd > 0) || !(q.outUsd > 0) || !(q.amountOut > 0n) || !(amountOut > 0n)) return q.costBps ?? null;
  const outUsd = amountOut === q.amountOut ? q.outUsd : (q.outUsd * Number(amountOut)) / Number(q.amountOut);
  return (1 - outUsd / q.inUsd) * 10_000;
}

/**
 * The executor contract: `execute({ slice, quote, request, floorRate, order })`
 * returns `{ status, amountIn, amountOut, minAmountOut?, txHashes?, details?,
 * next?, message? }`. Amounts are what actually traded (0n when nothing did).
 * `next: 'retry'` queues the slice again like a deferral, `next: 'halt'` stops
 * the order (a person has to look), anything else moves on.
 *
 * @param {object} p
 * @param {object} p.order from prepareOrder
 * @param {{ quote: (body: object) => Promise<object> }} p.client
 * @param {{ mode: string, execute: Function }} p.executor
 * @param {object} p.clock
 * @param {{ write: Function }} p.journal
 * @param {() => number} p.rand
 * @param {number} [p.seed] recorded so the schedule can be replayed
 * @param {object} [p.walletCap] the wallet's own slice cap, recorded with the order (live modes)
 * @param {(event: object) => void} [p.onEvent]
 */
export async function runOrder({ order, client, executor, clock, journal, rand, seed = null, walletCap = null, onEvent = () => {} }) {
  const { sell, buy } = order;
  const schedule = scheduleFor(order, rand);
  const emit = (type, data) => {
    const event = journal.write(type, { t: Math.round(clock.now()), ...data });
    onEvent(event);
    return event;
  };

  emit('order', { mode: executor.mode, seed, order, schedule, ...(walletCap ? { walletCap } : {}) });

  const quoteFor = async (amount) => {
    const body = intentsQuoteBody({
      sellAsset: sell.assetId,
      buyAsset: buy.assetId,
      amount,
      account: order.deskAccount,
      dry: true,
      slippageBps: order.slippageBps,
      now: clock.wallNow(),
    });
    const res = await client.quote(body);
    const q = normalizeQuote(res, { sellDecimals: sell.decimals, buyDecimals: buy.decimals, amountIn: amount });
    return { body, res, q };
  };

  // Arrival snapshot: the price at slice size sets the floor; the whole-order
  // quote is the "do it all at once" alternative the report compares against.
  // When even a slice-sized quote finds no liquidity, halve the probe until the
  // market answers, so the floor comes from a size that can actually trade.
  let probeAmount = medianAmount(schedule);
  let probe = await quoteFor(probeAmount);
  const probeRetries = [];
  while (!probe.q.ok && probe.q.noLiquidity && probeAmount / 2n >= order.minSliceUnits && probeRetries.length < 8) {
    probeRetries.push({ amount: probeAmount, status: probe.q.status, message: probe.q.message });
    probeAmount /= 2n;
    probe = await quoteFor(probeAmount);
  }
  const oneShot = await quoteFor(order.totalUnits);
  emit('arrival', { probe: snapshot(probe), probeRetries, oneShot: snapshot(oneShot) });
  if (!probe.q.ok) {
    emit('abort', { reason: 'arrival_probe_failed', message: probe.q.message });
    return { aborted: true };
  }
  const floorRate = floorFrom(probe.q.rate, order.maxAdverseBps);

  const slot = order.horizonMs / order.slices;
  const queue = schedule.map((s) => ({ id: String(s.index + 1), atMs: s.atMs, amount: s.amount, defers: 0 }));

  while (queue.length) {
    queue.sort((a, b) => a.atMs - b.atMs);
    const slice = queue.shift();
    await clock.sleepUntil(slice.atMs);

    const quote = await quoteFor(slice.amount);
    const retryAt = Math.round(clock.now() + slot / 2);
    const decision = decide({
      quote: quote.q,
      floorRate,
      amount: slice.amount,
      minSlice: order.minSliceUnits,
      defers: slice.defers,
      maxDefers: order.maxDefers,
      timeLeft: retryAt <= order.horizonMs,
    });
    emit('slice', { slice, floorRate, quote: snapshot(quote), decision });

    if (decision.action === Action.EXECUTE) {
      const fill = await executor.execute({ slice, quote: quote.q, request: quote.body, floorRate, order });
      emit('fill', {
        sliceId: slice.id,
        status: fill.status,
        amountIn: fill.amountIn,
        amountOut: fill.amountOut,
        minAmountOut: fill.minAmountOut ?? null,
        txHashes: fill.txHashes ?? [],
        quotedRate: quote.q.rate,
        quotedAmountOut: quote.q.amountOut,
        costBps: realizedCostBps(quote.q, fill.amountOut),
        midRate: quote.q.midRate,
        inUsd: quote.q.inUsd,
        outUsd: quote.q.outUsd,
        ...(fill.details ? { details: fill.details } : {}),
      });
      if (fill.next === 'halt') {
        emit('halt', { sliceId: slice.id, status: fill.status, message: fill.message ?? `slice ${slice.id} ended ${fill.status}` });
        return { aborted: false, halted: true };
      }
      if (fill.next === 'retry') {
        if (slice.defers < order.maxDefers && retryAt <= order.horizonMs) {
          queue.push({ ...slice, atMs: retryAt, defers: slice.defers + 1 });
        } else {
          emit('skip', { sliceId: slice.id, amount: slice.amount, reason: `not_filled_${String(fill.status).toLowerCase()}` });
        }
      }
    } else if (decision.action === Action.STOP) {
      emit('halt', { sliceId: slice.id, status: 'REFUSED', message: `${quote.q.message} (${quote.q.code})` });
      return { aborted: false, halted: true };
    } else if (decision.action === Action.DEFER) {
      queue.push({ ...slice, atMs: retryAt, defers: slice.defers + 1 });
    } else if (decision.action === Action.SPLIT) {
      const half = slice.amount / 2n;
      const now = Math.round(clock.now());
      queue.push({ ...slice, id: `${slice.id}a`, amount: half, atMs: now });
      queue.push({
        ...slice,
        id: `${slice.id}b`,
        amount: slice.amount - half,
        atMs: Math.min(Math.round(now + slot / 4), order.horizonMs),
      });
    } else {
      emit('skip', { sliceId: slice.id, amount: slice.amount, reason: decision.reason });
    }
  }

  emit('done', {});
  return { aborted: false };
}
