// Works one order: arrival snapshot, randomized slices, a price floor on every
// slice, and a journal entry for every decision.
import { buildSchedule } from './schedule.mjs';
import { Action, MAX_SPLITS, decide, floorFrom } from './guard.mjs';
import { intentsQuoteBody, normalizeQuote } from './oneclick.mjs';

function medianAmount(schedule) {
  const sorted = schedule.map((s) => s.amount).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted[Math.floor(sorted.length / 2)];
}

const maxBigint = (a, b) => (a > b ? a : b);
const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

/**
 * The bounds a run works within, journaled with the order:
 * - `splitFloor`: no split leaves a piece smaller than the order's minimum
 *   slice or 1/16 of an even slice, and never below 1 unit.
 * - `maxSplits`: splits per scheduled slice; each also uses up one wait.
 * - `maxProbeCostBps`: an arrival probe costing more than this against the
 *   quoted USD mid is an outlier and does not set the floor.
 * - `stallMs`: a slice this late means the desk stalled (a frozen tab, a
 *   sleeping laptop); half a slot, but at least a minute, so a swap's own
 *   settlement time is not taken for a stall.
 * - `graceMs`: how far past the window a slice that is not stalled may still
 *   trade; later than that it expires.
 * - `reprobeAfterMs`: a stall this long takes a fresh probe, which can only
 *   raise the floor.
 */
export function runRules(order) {
  const slot = order.horizonMs / order.slices;
  const evenSlice = BigInt(order.totalUnits) / BigInt(order.slices * 16);
  const stallMs = Math.max(slot / 2, 60_000);
  return {
    splitFloor: maxBigint(maxBigint(BigInt(order.minSliceUnits ?? 0n), evenSlice), 1n),
    maxSplits: MAX_SPLITS,
    maxProbeCostBps: order.maxProbeCostBps ?? 150,
    stallMs: Math.round(stallMs),
    graceMs: Math.round(clamp(slot / 2, 60_000, 5 * 60_000)),
    reprobeAfterMs: Math.round(Math.max(slot, 5 * 60_000)),
  };
}

/** Is this probe a price the floor can come from? */
function probeProblem(q, maxCostBps) {
  if (!q.ok) return null;
  if (!(q.rate > 0) || !(q.amountOut > 0n)) return 'the quote returned no output';
  if (q.costBps != null && q.costBps > maxCostBps) {
    return `the quote costs ${q.costBps.toFixed(1)} bps against the quoted USD mid, more than the ${maxCostBps} bps a floor may come from`;
  }
  return null;
}

/**
 * New times for the slices left after a stall: one per even part of the time
 * left, jittered inside it like the schedule, so they keep their order and
 * their random spacing instead of firing back to back. Only as many as fit
 * at least `minGapMs` apart are kept; the rest expire.
 */
function respread(items, from, to, minGapMs, timeJitter, rand) {
  const fit = Math.max(0, Math.min(items.length, Math.floor((to - from) / minGapMs)));
  const gap = (to - from) / Math.max(fit, 1);
  const kept = items.slice(0, fit).map((item, i) => ({ ...item, atMs: Math.round(from + (i + 0.5 + ((rand() * 2 - 1) * timeJitter) / 2) * gap) }));
  return { kept, expired: items.slice(fit) };
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
 * Journal events, in order: `order` (with the schedule and `rules`, see
 * runRules), `arrival` (probe, probe retries, whole-order quote), then per
 * slice `slice` (quote and decision) and `fill` (each execution attempt),
 * `skip` (left unfilled; reason `expired` when it came due after the window),
 * `stall` (the desk fell behind its schedule; the slices left were spread over
 * the time left), and finally `done`, `halt` or `abort`.
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

  const rules = runRules(order);
  emit('order', { mode: executor.mode, seed, order, schedule, rules, ...(walletCap ? { walletCap } : {}) });

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
  while (!probe.q.ok && probe.q.noLiquidity && probeAmount / 2n >= rules.splitFloor && probeRetries.length < 8) {
    probeRetries.push({ amount: probeAmount, status: probe.q.status, message: probe.q.message });
    probeAmount /= 2n;
    probe = await quoteFor(probeAmount);
  }
  // One outlier probe would loosen the floor of every slice: it is asked once more, then refused.
  let problem = probeProblem(probe.q, rules.maxProbeCostBps);
  if (problem) {
    probeRetries.push({ amount: probeAmount, status: probe.res.status, message: problem, costBps: probe.q.costBps ?? null });
    probe = await quoteFor(probeAmount);
    problem = probeProblem(probe.q, rules.maxProbeCostBps);
  }
  const oneShot = await quoteFor(order.totalUnits);
  emit('arrival', { probe: snapshot(probe), probeRetries, oneShot: snapshot(oneShot) });
  if (!probe.q.ok) {
    emit('abort', { reason: 'arrival_probe_failed', message: probe.q.message });
    return { aborted: true };
  }
  let floorRate = floorFrom(probe.q.rate, order.maxAdverseBps);
  if (problem || !(floorRate > 0)) {
    emit('abort', { reason: 'arrival_probe_outlier', message: `no price floor from the arrival quote: ${problem ?? 'the floor is not a positive rate'}` });
    return { aborted: true };
  }

  const slot = order.horizonMs / order.slices;
  const queue = schedule.map((s) => ({ id: String(s.index + 1), atMs: s.atMs, amount: s.amount, defers: 0, splits: 0 }));

  while (queue.length) {
    queue.sort((a, b) => a.atMs - b.atMs);
    const slice = queue.shift();
    await clock.sleepUntil(slice.atMs);

    // After a frozen tab or a sleeping laptop every overdue slice is due at
    // once. A stalled slice with no window left expires, and so does any
    // slice later than the window plus a short grace; inside the window the
    // slices left are spread over the time left, and a long stall takes a
    // fresh probe that can only raise the floor.
    const now = Math.round(clock.now());
    const lateMs = now - slice.atMs;
    const stalled = lateMs > rules.stallMs;
    if (stalled ? now >= order.horizonMs : now > order.horizonMs + rules.graceMs) {
      emit('skip', { sliceId: slice.id, amount: slice.amount, reason: 'expired', lateMs: Math.round(lateMs) });
      continue;
    }
    if (stalled) {
      // The slices left keep at least half a slot between them; those that do not fit expire.
      const { kept, expired } = respread([slice, ...queue], now, order.horizonMs, slot / 2, order.timeJitter, rand);
      const stall = {
        sliceId: slice.id,
        dueMs: slice.atMs,
        lateMs: Math.round(lateMs),
        slicesLeft: kept.length + expired.length,
        respread: kept.map((s) => ({ id: s.id, atMs: s.atMs })),
        expired: expired.map((s) => s.id),
      };
      if (lateMs > rules.reprobeAfterMs) {
        const fresh = await quoteFor(probeAmount);
        const freshFloor = fresh.q.ok && !probeProblem(fresh.q, rules.maxProbeCostBps) ? floorFrom(fresh.q.rate, order.maxAdverseBps) : null;
        Object.assign(stall, { probe: snapshot(fresh), floorBefore: floorRate });
        if (freshFloor > floorRate) floorRate = freshFloor;
        stall.floorRate = floorRate;
      }
      emit('stall', stall);
      for (const s of expired) emit('skip', { sliceId: s.id, amount: s.amount, reason: 'expired', lateMs: Math.max(0, now - s.atMs) });
      queue.length = 0;
      queue.push(...kept);
      continue;
    }

    const quote = await quoteFor(slice.amount);
    const retryAt = Math.round(clock.now() + slot / 2);
    const decision = decide({
      quote: quote.q,
      floorRate,
      amount: slice.amount,
      minSlice: rules.splitFloor,
      defers: slice.defers,
      maxDefers: order.maxDefers,
      timeLeft: retryAt <= order.horizonMs,
      splits: slice.splits ?? 0,
      maxSplits: rules.maxSplits,
      splitTimeLeft: Math.round(clock.now() + slot / 4) <= order.horizonMs,
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
      const message = quote.q.ok ? `no usable price floor (${decision.reason})` : `${quote.q.message} (${quote.q.code})`;
      emit('halt', { sliceId: slice.id, status: 'REFUSED', message });
      return { aborted: false, halted: true };
    } else if (decision.action === Action.DEFER) {
      queue.push({ ...slice, atMs: retryAt, defers: slice.defers + 1 });
    } else if (decision.action === Action.SPLIT) {
      // Each half is one split deeper and has used up one wait, so splitting ends.
      const half = slice.amount / 2n;
      const at = Math.round(clock.now());
      const deeper = { defers: slice.defers + 1, splits: (slice.splits ?? 0) + 1 };
      queue.push({ ...slice, ...deeper, id: `${slice.id}a`, amount: half, atMs: at });
      queue.push({
        ...slice,
        ...deeper,
        id: `${slice.id}b`,
        amount: slice.amount - half,
        atMs: Math.round(at + slot / 4),
      });
    } else {
      emit('skip', { sliceId: slice.id, amount: slice.amount, reason: decision.reason });
    }
  }

  emit('done', {});
  return { aborted: false };
}
