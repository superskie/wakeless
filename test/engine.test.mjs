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
