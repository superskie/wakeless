import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runOrder } from '../src/engine.mjs';
import { prepareOrder } from '../src/order.mjs';
import { dryExecutor } from '../src/executors/dry.mjs';
import { fakeClock } from '../src/clock.mjs';
import { fileJournal, memoryJournal, readJournal } from '../src/journal.mjs';
import { buildReport, renderReport } from '../src/report.mjs';
import { mulberry32 } from '../src/rng.mjs';
import { TOKENS, fakeMarket } from './helpers.mjs';

const MIN = 60_000;
const spec = {
  id: 'test-order',
  sell: 'usdc:arb',
  buy: 'sol:sol',
  amount: '250000',
  slices: 10,
  horizonMinutes: 20,
  maxAdverseBps: 30,
  maxDefers: 2,
  minSliceUsd: 100,
};

async function run({ market, clock, specOverrides = {}, seed = 1, journal = memoryJournal() }) {
  const order = prepareOrder({ ...spec, ...specOverrides }, TOKENS);
  const result = await runOrder({ order, client: market, executor: dryExecutor(), clock, journal, rand: mulberry32(seed), seed });
  return { order, result, journal };
}

test('a calm market fills the whole order with intents-only dry quotes', async () => {
  const clock = fakeClock();
  const market = fakeMarket({ clock });
  const { journal } = await run({ market, clock });
  const report = buildReport(journal.events);

  assert.equal(report.filledPct, 100);
  assert.equal(report.filled, '250000');
  assert.equal(report.slices.fills, 10);
  assert.equal(report.slices.skips, 0);
  for (const call of market.calls) {
    assert.equal(call.request.dry, true);
    assert.equal(call.request.depositType, 'INTENTS');
    assert.equal(call.request.recipientType, 'INTENTS');
    assert.equal(call.request.refundType, 'INTENTS');
  }
  // Probe, one-shot, then one quote per slice.
  assert.equal(market.calls.length, 12);
  // Slices are spread over the window, not fired at once.
  const sliceTimes = market.calls.slice(2).map((c) => c.t);
  assert.ok(sliceTimes[0] > 0 && sliceTimes.at(-1) <= 20 * MIN);
  assert.ok(sliceTimes.every((t, i) => i === 0 || t > sliceTimes[i - 1]));
});

test('no fill is ever below the floor; a bad stretch is waited out', async () => {
  const clock = fakeClock();
  // Slot 3 of 10 spans minutes 4 to 6; quotes there are 100 bps worse.
  const market = fakeMarket({ clock, bad: (t) => t >= 4 * MIN && t < 6 * MIN, extraBps: 100 });
  const { journal } = await run({ market, clock });
  const slices = journal.events.filter((e) => e.type === 'slice');
  const fills = journal.events.filter((e) => e.type === 'fill');
  const floor = slices[0].floorRate;

  assert.ok(slices.some((s) => s.decision.reason === 'below_floor_wait'));
  for (const f of fills) assert.ok(f.quotedRate >= floor, `fill at ${f.quotedRate} under floor ${floor}`);
  assert.equal(buildReport(journal.events).filledPct, 100);
});

test('a market that stays bad leaves the order unfilled instead of chasing it', async () => {
  const clock = fakeClock();
  const market = fakeMarket({ clock, bad: (t) => t > 0, extraBps: 100 });
  const { journal } = await run({ market, clock });
  const report = buildReport(journal.events);

  assert.equal(report.slices.fills, 0);
  assert.equal(report.filledPct, 0);
  assert.equal(report.unfilled, '250000');
  assert.equal(report.slices.skips, 10);
  assert.ok(report.skipped.every((s) => s.reason === 'below_floor_exhausted'));
  assert.match(renderReport(report), /Unfilled slices/);
});

test('slices too big for the market are split until they clear', async () => {
  const clock = fakeClock();
  // 5 slices of about 50k each against a market that refuses anything over 30k.
  const market = fakeMarket({ clock, capUsd: 30_000 });
  const { journal } = await run({ market, clock, specOverrides: { slices: 5 } });
  const report = buildReport(journal.events);
  const arrival = journal.events.find((e) => e.type === 'arrival');

  assert.ok(arrival.probeRetries.length >= 1, 'probe halved at least once');
  assert.ok(arrival.probe.q.ok);
  assert.equal(report.filledPct, 100);
  assert.ok(report.slices.reasons.no_liquidity_split >= 1);
  assert.ok(report.fills.every((f) => Number(f.sold) <= 30_000));
  assert.equal(report.vsOneShot.executable, false);
  assert.match(renderReport(report), /Not executable as one swap: No liquidity available/);
});

test('an order aborts cleanly when the arrival quote is refused', async () => {
  const clock = fakeClock();
  const refused = { calls: [], quote: async () => ({ ok: false, status: 401, latencyMs: 1, json: { message: 'Unauthorized' } }) };
  const { result, journal } = await run({ market: refused, clock });
  assert.equal(result.aborted, true);
  const report = buildReport(journal.events);
  assert.equal(report.aborted, true);
  assert.match(renderReport(report), /Aborted before the first slice: Unauthorized/);
});

test('report math: slicing cost, one-shot cost and the saving between them', async () => {
  const clock = fakeClock();
  // 10 equal slices of 25k: 15 + 4 * 0.25^2 = 15.25 bps each. One shot of 250k: 15 + 4 * 2.5^2 = 40 bps.
  const market = fakeMarket({ clock, feeBps: 15, impactBps: 4 });
  const { journal } = await run({ market, clock, specOverrides: { sizeJitter: 0, timeJitter: 0 } });
  const r = buildReport(journal.events);
  const close = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) < tol, `${a} vs ${b}`);

  close(r.costs.executionCostBps, 15.25);
  close(r.costs.shortfallBps, 15.25);
  close(r.costs.timingBps, 0);
  close(r.vsOneShot.costBps, 40);
  close(r.vsOneShot.executionSavingsBps, 24.75);
  close(r.vsOneShot.deltaBps, ((1 - 0.001525) / (1 - 0.004) - 1) * 10_000);
  assert.ok(r.vsOneShot.deltaUsd > 600 && r.vsOneShot.deltaUsd < 630, `deltaUsd ${r.vsOneShot.deltaUsd}`);
});

/** A clock whose `n`-th sleep oversleeps by `jumpMs`, like a frozen tab or a sleeping laptop. */
function stallingClock(n, jumpMs) {
  const base = fakeClock();
  let sleeps = 0;
  return {
    ...base,
    async sleepUntil(ms) {
      await base.sleepUntil(ms);
      if (++sleeps === n) base.advance(jumpMs);
    },
  };
}

test('after a stall the slices left are spread over the time left, and none trades after the window', async () => {
  const clock = stallingClock(3, 13 * MIN);
  const market = fakeMarket({ clock });
  const { order, journal } = await run({ market, clock, specOverrides: { slices: 16, horizonMinutes: 30 } });
  const stall = journal.events.find((e) => e.type === 'stall');
  const slot = order.horizonMs / order.slices;

  assert.ok(stall, 'the stall is journaled');
  assert.ok(stall.lateMs > slot / 2);
  assert.equal(stall.slicesLeft, stall.respread.length + stall.expired.length);
  const decided = journal.events.filter((e) => e.type === 'slice' && e.t >= stall.t).map((e) => e.t);
  assert.equal(decided.length, stall.respread.length);
  for (let i = 1; i < decided.length; i++) assert.ok(decided[i] > decided[i - 1], 'one at a time, in order');
  assert.ok(decided.every((t) => t <= order.horizonMs), 'nothing trades after the window');
  const expired = journal.events.filter((e) => e.type === 'skip' && e.reason === 'expired').map((e) => e.sliceId);
  assert.deepEqual(expired, stall.expired);
  const report = buildReport(journal.events);
  assert.equal(report.slices.fills + report.slices.skips, 16);
  assert.match(renderReport(report), /\(expired\)/);
});

test('a stall that outlasts the window expires every slice left instead of trading them late', async () => {
  const clock = stallingClock(3, 45 * MIN);
  const market = fakeMarket({ clock });
  const { journal } = await run({ market, clock, specOverrides: { slices: 16, horizonMinutes: 30 } });
  const report = buildReport(journal.events);

  assert.equal(report.slices.fills, 2);
  assert.equal(report.skipped.length, 14);
  assert.ok(report.skipped.every((s) => s.reason === 'expired'));
  assert.equal(journal.events.filter((e) => e.type === 'slice').length, 2, 'expired slices are not even quoted');
});

test('a long stall takes a fresh probe that can raise the floor but never lowers it', async () => {
  // 100 bps worse is still a usable probe (under the 150 bps bound), so only the max() keeps the floor.
  for (const [moveBps, raises] of [[-200, true], [100, false]]) {
    const clock = stallingClock(3, 13 * MIN);
    // After the stall the market is `moveBps` worse (positive) or better (negative) for the seller.
    const market = fakeMarket({ clock, bad: (t) => t > 10 * MIN, extraBps: moveBps });
    const { journal } = await run({ market, clock, specOverrides: { slices: 16, horizonMinutes: 30 } });
    const stall = journal.events.find((e) => e.type === 'stall');

    assert.ok(stall.probe, 'the stall took a fresh probe');
    assert.equal(stall.floorRate > stall.floorBefore, raises, `move ${moveBps} bps`);
    assert.ok(stall.floorRate >= stall.floorBefore);
  }
});

test('splits are bounded: three deep, each using up a wait, never below the split floor', async () => {
  const clock = fakeClock();
  // Every size finds no liquidity once the two arrival quotes are taken.
  let calls = 0;
  const ok = fakeMarket({ clock });
  const market = { quote: async (body) => (++calls <= 2 ? ok.quote(body) : { ok: false, status: 400, latencyMs: 1, json: { message: 'No liquidity available' } }) };
  const { order, journal } = await run({ market, clock, specOverrides: { slices: 4, minSliceUsd: 0, maxDefers: 20 } });
  const slices = journal.events.filter((e) => e.type === 'slice');
  const splitFloor = BigInt(journal.events[0].rules.splitFloor);

  assert.equal(journal.events[0].rules.maxSplits, 3);
  assert.ok(splitFloor >= order.totalUnits / 64n, `split floor ${splitFloor}`);
  assert.ok(slices.every((s) => s.slice.splits <= 3));
  assert.ok(slices.every((s) => BigInt(s.slice.amount) >= splitFloor));
  // At most 1 + 2 + 4 + 8 quotes per scheduled slice from splits, plus waits of the deepest pieces.
  assert.ok(calls < 2 + 4 * (15 + 8 * 20), `${calls} quotes`);
  assert.equal(buildReport(journal.events).filledPct, 0);
});

test('a minimum slice of 0 is raised to 1 unit, and an asset without a price gets a usable hint', () => {
  assert.equal(prepareOrder({ ...spec, minSliceUsd: 0 }, TOKENS).minSliceUnits, 1n);
  assert.equal(prepareOrder({ ...spec, minSlice: '250' }, TOKENS).minSliceUnits, 250_000_000n);
  const unpriced = TOKENS.map((t) => (t.symbol === 'USDC' ? { ...t, price: null } : t));
  assert.throws(() => prepareOrder(spec, unpriced), /give the smallest slice in USDC instead, for example "minSlice": "1562\.5"/);
});

test('an outlier arrival probe is asked again, and refused when it stays an outlier', async () => {
  for (const [outliers, aborts] of [[1, false], [2, true]]) {
    const clock = fakeClock();
    const market = fakeMarket({ clock });
    const quote = market.quote;
    let seen = 0;
    // The first `outliers` quotes come back 600 bps under the market.
    market.quote = async (body) => {
      const res = await quote(body);
      if (++seen <= outliers) {
        const out = (BigInt(res.json.quote.amountOut) * 9_400n) / 10_000n;
        res.json.quote = { ...res.json.quote, amountOut: out.toString(), amountOutUsd: String((Number(out) / 1e9) * (1 / 0.0104)) };
      }
      return res;
    };
    const { result, journal } = await run({ market, clock });
    const arrival = journal.events.find((e) => e.type === 'arrival');

    assert.equal(Boolean(result.aborted), aborts, `${outliers} outlier quotes`);
    assert.equal(arrival.probeRetries.length, 1);
    assert.match(arrival.probeRetries[0].message, /more than the 150 bps/);
    if (aborts) assert.match(renderReport(buildReport(journal.events)), /no price floor from the arrival quote/);
    else assert.ok(arrival.probe.q.costBps < 150);
  }
});

test('an arrival quote with no output sets no floor: the order aborts', async () => {
  const clock = fakeClock();
  const market = fakeMarket({ clock });
  const quote = market.quote;
  market.quote = async (body) => {
    const res = await quote(body);
    res.json.quote = { ...res.json.quote, amountOut: '0', amountOutUsd: '0' };
    return res;
  };
  const { result, journal } = await run({ market, clock });
  assert.equal(result.aborted, true);
  assert.equal(journal.events.filter((e) => e.type === 'fill').length, 0);
  assert.match(journal.events.find((e) => e.type === 'abort').message, /no output/);
});

test('the report says no liquidity only when the whole-order quote found none', async () => {
  const clock = fakeClock();
  const market = fakeMarket({ clock });
  const quote = market.quote;
  market.quote = async (body) =>
    BigInt(body.amount) === 250_000_000_000n ? { ok: false, status: 500, latencyMs: 1, json: { message: 'Failed to receive response within timeout of 25000ms' } } : quote(body);
  const { journal } = await run({ market, clock });
  const report = buildReport(journal.events);

  assert.deepEqual([report.vsOneShot.executable, report.vsOneShot.noLiquidity, report.vsOneShot.status], [false, false, 500]);
  const text = renderReport(report);
  assert.match(text, /No one-shot comparison: 1Click did not quote the whole order \(HTTP 500: Failed to receive response/);
  assert.doesNotMatch(text, /no liquidity/i);
});

test('the report is rebuilt from the journal file alone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-'));
  const file = path.join(dir, 'order.jsonl');
  const clock = fakeClock();
  const market = fakeMarket({ clock });
  await run({ market, clock, journal: fileJournal(file) });

  const events = readJournal(file);
  const report = buildReport(events);
  assert.equal(report.filledPct, 100);
  assert.equal(report.seed, 1);
  // Amounts survive the round trip as exact integers.
  const fills = events.filter((e) => e.type === 'fill');
  assert.equal(fills.reduce((a, f) => a + BigInt(f.amountIn), 0n), 250_000_000_000n);
  fs.rmSync(dir, { recursive: true, force: true });
});
