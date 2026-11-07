// Transaction cost analysis rebuilt from a journal, with no network access.
import { fromUnits, toNumber } from './units.mjs';

const sumUnits = (rows, key) => rows.reduce((acc, row) => acc + BigInt(row[key]), 0n);

/** The wallet's slice cap as journaled with the order, in whole units of the sold asset. */
function walletCapOf(cap, sell) {
  if (!cap) return null;
  const whole = (raw) => (raw == null ? null : fromUnits(BigInt(raw), sell.decimals));
  return {
    revision: cap.revision ?? null,
    reason: cap.reason ?? null,
    perSwap: whole(cap.perSwap),
    perDay: whole(cap.perDay),
    largestSlice: whole(cap.largestSlice),
  };
}

/**
 * Definitions (all in basis points of the input value):
 * - execution cost: each fill's all-in cost against the USD mid quoted with it,
 *   weighted by input. Fees, spread and impact, without market movement.
 * - shortfall: realized rate against the mid at arrival. Execution cost plus
 *   whatever the market did while the order was worked.
 * - timing: shortfall minus execution cost. Positive means the market moved
 *   against the order while it was being worked.
 */
export function buildReport(events) {
  const orderEvent = events.find((e) => e.type === 'order');
  if (!orderEvent) throw new Error('journal has no order event');
  const order = orderEvent.order;
  const { sell, buy } = order;
  const arrival = events.find((e) => e.type === 'arrival');
  const abort = events.find((e) => e.type === 'abort');
  const sliceEvents = events.filter((e) => e.type === 'slice');
  // Every execution attempt is journaled; only attempts that traded count as fills.
  const attempts = events.filter((e) => e.type === 'fill');
  const fills = attempts.filter((e) => BigInt(e.amountIn) > 0n);
  const misses = attempts.filter((e) => BigInt(e.amountIn) === 0n);
  const halt = events.find((e) => e.type === 'halt');
  const skips = events.filter((e) => e.type === 'skip');
  const last = events[events.length - 1];

  const totalUnits = BigInt(order.totalUnits);
  const inUnits = sumUnits(fills, 'amountIn');
  const outUnits = sumUnits(fills, 'amountOut');
  const inHuman = toNumber(inUnits, sell.decimals);
  const outHuman = toNumber(outUnits, buy.decimals);
  const realizedRate = inHuman > 0 ? outHuman / inHuman : null;

  let weight = 0;
  let weightedCost = 0;
  for (const f of fills) {
    if (f.costBps == null) continue;
    const x = toNumber(BigInt(f.amountIn), sell.decimals);
    weight += x;
    weightedCost += x * f.costBps;
  }
  const executionCostBps = weight > 0 ? weightedCost / weight : null;

  const probe = arrival?.probe?.q ?? null;
  const oneShot = arrival?.oneShot?.q ?? null;
  const arrivalMid = probe?.ok ? probe.midRate : null;
  // When the USD reference never changed (the Agent API publishes prices every
  // few minutes), a market move lands in execution cost and can not be split out.
  const mids = [arrivalMid, ...fills.map((f) => f.midRate)].filter((m) => m != null);
  const referenceStatic = mids.length > 1 && mids.every((m) => Math.abs(m / mids[0] - 1) < 1e-9);
  const shortfallBps = realizedRate && arrivalMid ? (1 - realizedRate / arrivalMid) * 10_000 : null;
  const timingBps = shortfallBps != null && executionCostBps != null ? shortfallBps - executionCostBps : null;
  const buyUsdAtArrival = probe?.ok && probe.outUsd > 0
    ? probe.outUsd / toNumber(BigInt(probe.amountOut), buy.decimals)
    : null;

  let vsOneShot;
  if (oneShot?.ok) {
    const outForFilled = oneShot.rate * inHuman;
    vsOneShot = {
      executable: true,
      rate: oneShot.rate,
      costBps: oneShot.costBps,
      outForFilled,
      deltaBuy: outHuman - outForFilled,
      deltaBps: realizedRate ? (realizedRate / oneShot.rate - 1) * 10_000 : null,
      deltaUsd: buyUsdAtArrival ? (outHuman - outForFilled) * buyUsdAtArrival : null,
      executionSavingsBps: oneShot.costBps != null && executionCostBps != null ? oneShot.costBps - executionCostBps : null,
    };
  } else {
    vsOneShot = { executable: false, message: oneShot?.message ?? 'no quote recorded' };
  }

  const reasons = {};
  for (const s of sliceEvents) reasons[s.decision.reason] = (reasons[s.decision.reason] ?? 0) + 1;

  return {
    orderId: order.id,
    mode: orderEvent.mode,
    seed: orderEvent.seed ?? null,
    aborted: Boolean(abort),
    abortMessage: abort?.message ?? null,
    halted: halt ? { slice: halt.sliceId, t: halt.t, status: halt.status, message: halt.message } : null,
    walletCap: walletCapOf(orderEvent.walletCap, sell),
    sell: { ref: sell.ref, symbol: sell.symbol, chain: sell.blockchain },
    buy: { ref: buy.ref, symbol: buy.symbol, chain: buy.blockchain },
    total: fromUnits(totalUnits, sell.decimals),
    filled: fromUnits(inUnits, sell.decimals),
    filledPct: totalUnits > 0n ? Number((inUnits * 10_000n) / totalUnits) / 100 : 0,
    received: fromUnits(outUnits, buy.decimals),
    unfilled: fromUnits(totalUnits - inUnits, sell.decimals),
    windowMs: order.horizonMs,
    elapsedMs: last?.t ?? 0,
    slices: { planned: order.slices, quotes: sliceEvents.length, fills: fills.length, misses: misses.length, skips: skips.length, reasons },
    rates: {
      realized: realizedRate,
      arrivalProbe: probe?.ok ? probe.rate : null,
      arrivalMid,
      floor: sliceEvents[0]?.floorRate ?? null,
    },
    costs: {
      arrivalProbeBps: probe?.ok ? probe.costBps : null,
      executionCostBps,
      shortfallBps,
      timingBps,
      referenceStatic,
    },
    vsOneShot,
    fills: fills.map((f) => ({
      slice: f.sliceId,
      t: f.t,
      sold: fromUnits(BigInt(f.amountIn), sell.decimals),
      got: fromUnits(BigInt(f.amountOut), buy.decimals),
      rate: toNumber(BigInt(f.amountOut), buy.decimals) / toNumber(BigInt(f.amountIn), sell.decimals),
      costBps: f.costBps,
      status: f.status,
      txHashes: f.txHashes ?? [],
      warnings: f.details?.warnings ?? [],
      vsQuoteBps:
        f.quotedAmountOut != null && BigInt(f.quotedAmountOut) > 0n
          ? (Number(BigInt(f.amountOut)) / Number(BigInt(f.quotedAmountOut)) - 1) * 10_000
          : null,
    })),
    misses: misses.map((m) => ({
      slice: m.sliceId,
      t: m.t,
      status: m.status,
      reason: m.details?.failureReason ?? m.details?.failureCode ?? m.details?.code ?? (m.details?.warnings?.length ? m.details.warnings.join(', ') : null),
    })),
    skipped: skips.map((s) => ({ slice: s.sliceId, t: s.t, amount: fromUnits(BigInt(s.amount), sell.decimals), reason: s.reason })),
  };
}

const MODE_TITLES = { dry: 'dry run', preview: 'agent preview, no funds moved', live: 'live' };

const COST_NOTES = {
  dry:
    'Costs are measured against the USD prices 1Click returns with each quote and include its platform fee ' +
    '(25 bps without an API key; with one, 20 bps, or 1 bp on stablecoin pairs). Those prices can lag the market by a few bps, so compare ' +
    'numbers taken at the same moment, as the one-shot comparison below does.',
  agent:
    'Costs are measured against the USD token prices the Agent API publishes, read with each quote, and include the Agent API fee. ' +
    'Those prices can lag the market by a few bps, so compare numbers taken at the same moment, as the one-shot comparison below does.',
};

const MODE_FOOTERS = {
  dry:
    'Dry run: every price above is a real 1Click quote taken at that moment, and each fill is simulated at its quoted amount. ' +
    'It assumes liquidity refills between slices; only a live run measures that.',
  preview:
    "Agent preview: every price above is the agent's own swap preview, requested through its grant and checked against its signed policy. " +
    'Nothing was submitted and no funds moved; each fill is shown at its previewed amount.',
  live:
    "Live run: every fill above was submitted through the agent's grant as a swap whose minimum output is the desk's floor, " +
    'and the amounts received are the settled amounts the Agent API reported.',
};

const num = (value, digits = 2) =>
  value == null || Number.isNaN(value)
    ? '-'
    : value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const signed = (value, digits = 1) => (value == null ? '-' : `${value >= 0 ? '+' : ''}${num(value, digits)}`);
const clock = (ms) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};
// Amounts under 1 keep three significant digits instead of rounding to zero.
const amount = (text, digits) => {
  const v = Number(text);
  if (v === 0 || Math.abs(v) >= 1) return num(v, digits);
  return num(v, Math.min(10, Math.max(digits, 2 - Math.floor(Math.log10(Math.abs(v))))));
};
const usd = (value) => (value == null ? '-' : `${value < 0 ? '-' : ''}$${num(Math.abs(value), 2)}`);

/** Markdown rendering of buildReport output. */
export function renderReport(r) {
  const lines = [];
  lines.push(`# Execution report: ${r.orderId} (${MODE_TITLES[r.mode] ?? r.mode})`, '');
  if (r.aborted) {
    lines.push(`Aborted before the first slice: ${r.abortMessage}.`, '');
    return lines.join('\n');
  }
  lines.push(
    `Sold ${amount(r.filled, 2)} ${r.sell.symbol} (${r.sell.chain}) for ${amount(r.received, 6)} ${r.buy.symbol} (${r.buy.chain}) ` +
      `in ${r.slices.fills} fills over ${clock(r.elapsedMs)} of order time. Filled ${num(r.filledPct, 2)}% of ${amount(r.total, 2)} ${r.sell.symbol}.`,
    '',
  );
  if (r.halted) {
    lines.push(`Stopped early at ${clock(r.halted.t)} on slice ${r.halted.slice} (${r.halted.status}): ${r.halted.message}.`, '');
  }
  if (r.walletCap) {
    const c = r.walletCap;
    lines.push(
      c.perSwap == null
        ? `Wallet cap (policy revision ${c.revision}): none; the wallet would have accepted the whole order as one swap.`
        : `Wallet cap (policy revision ${c.revision}): the wallet refuses any swap above ${amount(c.perSwap, 2)} ${r.sell.symbol}` +
            `${c.perDay != null ? ` and sales above ${amount(c.perDay, 2)} ${r.sell.symbol} a day` : ''}; ` +
            `this run's largest slice was ${amount(c.largestSlice, 2)} ${r.sell.symbol}.`,
      '',
    );
  }
  lines.push(
    '| Cost in bps of the input | bps |',
    '| --- | ---: |',
    `| Execution cost: fees, spread and impact at each fill | ${num(r.costs.executionCostBps, 1)} |`,
    `| Market move while the order was worked | ${signed(r.costs.timingBps)} |`,
    `| Implementation shortfall against arrival | ${num(r.costs.shortfallBps, 1)} |`,
    `| Reference: one slice-sized swap at arrival | ${num(r.costs.arrivalProbeBps, 1)} |`,
    '',
    COST_NOTES[r.mode === 'dry' ? 'dry' : 'agent'],
    '',
  );
  if (r.costs.referenceStatic) {
    lines.push(
      'The USD reference prices did not change while this order was worked, so this report can not split a market move from ' +
        'execution cost: the market-move line reads 0 and execution cost includes any move. The one-shot comparison below compares ' +
        `${r.buy.symbol} received directly and does not depend on those prices.`,
      '',
    );
  }

  const o = r.vsOneShot;
  lines.push(`One-shot alternative at arrival: ${amount(r.total, 2)} ${r.sell.symbol} in a single swap.`, '');
  if (o.executable) {
    lines.push(
      `- Quoted cost ${num(o.costBps, 1)} bps, ${num(o.outForFilled, 6)} ${r.buy.symbol} for the filled amount.`,
      `- Slicing received ${signed(o.deltaBuy, 6)} ${r.buy.symbol} (${signed(o.deltaBps)} bps, about ${usd(o.deltaUsd)} at the arrival price), market move included.`,
    );
    if (!r.costs.referenceStatic) lines.push(`- Execution cost avoided, market move excluded: ${signed(o.executionSavingsBps)} bps.`);
    if (r.mode === 'live') {
      lines.push(
        '- In a live run each fill is a settlement while the one-shot alternative is only a quote, and settlements can land ' +
          'below their quotes inside the slippage tolerance ("vs quote" below), so this comparison leans against slicing.',
      );
    }
    lines.push('');
  } else {
    lines.push(`- Not executable as one swap: ${o.message}.`, '');
  }

  // Live fills also show how far each settlement landed from its own quote.
  const live = r.mode === 'live';
  lines.push(
    `| Slice | Order time | Sold | Received | Rate | Cost bps |${live ? ' vs quote bps |' : ''} Status |`,
    `| --- | --- | ---: | ---: | ---: | ---: |${live ? ' ---: |' : ''} --- |`,
  );
  for (const f of r.fills) {
    lines.push(
      `| ${f.slice} | ${clock(f.t)} | ${amount(f.sold, 2)} | ${amount(f.got, 6)} | ${f.rate.toPrecision(6)} | ${num(f.costBps, 1)} |` +
        `${live ? ` ${signed(f.vsQuoteBps)} |` : ''} ${f.status} |`,
    );
  }
  const referenced = r.fills.filter((f) => f.txHashes.length);
  if (referenced.length) {
    lines.push('', 'Settlement references:', '');
    for (const f of referenced) lines.push(`- Slice ${f.slice}: ${f.txHashes.join(', ')}`);
  }
  const warned = r.fills.filter((f) => f.warnings.length);
  if (warned.length) {
    const codes = [...new Set(warned.flatMap((f) => f.warnings))].join(', ');
    lines.push('', `Preview warnings on ${warned.length} of ${r.fills.length} fills: ${codes}. A live run stops at the first warning.`);
  }
  if (r.misses.length) {
    lines.push('', 'Attempts that did not fill:', '');
    for (const m of r.misses) lines.push(`- Slice ${m.slice} at ${clock(m.t)}: ${m.status}${m.reason ? ` (${m.reason})` : ''}`);
  }
  if (r.skipped.length) {
    lines.push('', 'Unfilled slices:', '');
    for (const s of r.skipped) lines.push(`- Slice ${s.slice}: ${amount(s.amount, 2)} ${r.sell.symbol} (${s.reason})`);
  }
  const reasons = Object.entries(r.slices.reasons).map(([k, v]) => `${k} ${v}`).join(', ');
  lines.push('', `Decisions: ${reasons}. Seed: ${r.seed ?? 'not recorded'}.`);
  if (MODE_FOOTERS[r.mode]) lines.push('', MODE_FOOTERS[r.mode]);
  return lines.join('\n') + '\n';
}
