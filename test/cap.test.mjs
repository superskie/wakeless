import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSchedule, largestPossibleSlice } from '../src/schedule.mjs';
import { prepareOrder } from '../src/order.mjs';
import { mulberry32 } from '../src/rng.mjs';
import { capFor, checkSliceCap, withSliceCap } from '../src/agent/cap.mjs';
import { TOKENS } from './helpers.mjs';

const max = (schedule) => schedule.reduce((m, s) => (s.amount > m ? s.amount : m), 0n);

test('no schedule of any seed has a slice above the largest possible slice', () => {
  const rand = mulberry32(99);
  for (let round = 0; round < 400; round++) {
    const slices = 2 + Math.floor(rand() * 40);
    const sizeJitter = [0, 0.1, 0.3, 0.6, 0.95][round % 5];
    const total = BigInt(Math.floor(rand() * 1e12)) + 10_000n * BigInt(slices);
    const minSlice = round % 2 ? 0n : total / BigInt(slices * 3);
    const bound = largestPossibleSlice({ total, slices, sizeJitter });
    assert.ok(bound < total, `bound ${bound} must stay below the order ${total}`);
    for (let seed = 0; seed < 25; seed++) {
      const schedule = buildSchedule({ total, slices, horizonMs: 60_000, sizeJitter, minSlice, rand: mulberry32(round * 100 + seed) });
      assert.ok(max(schedule) <= bound, `slice ${max(schedule)} above bound ${bound}`);
    }
  }
});

test('the worst draw, one largest weight and all others smallest, lands on the bound', () => {
  for (const [slices, sizeJitter, total] of [[4, 0.3, 2_500_000_000_000_000n], [16, 0.3, 500_000_000_000n], [7, 0.8, 999_999_937n]]) {
    // buildSchedule draws a time, then a weight, per slice. The last slice also takes the remainder.
    const draws = [];
    for (let i = 0; i < slices; i++) draws.push(0.5, i === slices - 1 ? 1 - 1e-12 : 0);
    const schedule = buildSchedule({ total, slices, horizonMs: 60_000, sizeJitter, rand: () => draws.shift() });
    const bound = largestPossibleSlice({ total, slices, sizeJitter });
    const worst = schedule.at(-1).amount;
    assert.ok(worst <= bound, `worst slice ${worst} above bound ${bound}`);
    assert.ok(bound - worst <= BigInt(slices), `bound ${bound} is loose against the worst slice ${worst}`);
  }
});

test('the bound is the even slice plus the remainder when sizes do not vary', () => {
  assert.equal(largestPossibleSlice({ total: 1_000_000n, slices: 4, sizeJitter: 0 }), 250_004n);
  // 16 slices at 30% jitter: one slice can take 1.3 / (1.3 + 15 * 0.7) of the order.
  assert.equal(largestPossibleSlice({ total: 500_000_000_000n, slices: 16, sizeJitter: 0.3 }), 55_084_745_778n);
});

const order = (overrides = {}) =>
  prepareOrder({ id: 'cap-test', sell: 'usdc:arb', buy: 'sol:sol', amount: '500000', slices: 16, minSliceUsd: 1000, ...overrides }, TOKENS);

test('the cap an order needs: the largest possible slice per swap, the order per day', () => {
  const o = order();
  const cap = capFor(o);
  assert.equal(cap.assetId, 'nep141:usdc.test');
  assert.equal(cap.perSwap, largestPossibleSlice({ total: o.totalUnits, slices: 16, sizeJitter: o.sizeJitter }));
  assert.equal(cap.perDay, 500_000_000_000n);
  assert.throws(() => capFor(order({ slices: 1, minSliceUsd: 0 })), /one-slice order/);
  assert.throws(() => capFor(order({ sizeJitter: 1 })), /whole order/);
});

test('signing the cap keeps every other rule and other assets\' limits', () => {
  const policy = {
    frozen: false,
    actions: ['swap'],
    limits: { per_transaction: { 'nep141:other': '5' }, hourly: { 'nep141:other': '9' } },
    budget: { daily_usd: '250' },
  };
  const next = withSliceCap(policy, { assetId: 'nep141:usdc.test', perSwap: 123n, perDay: 1000n });
  assert.deepEqual(next.limits, {
    per_transaction: { 'nep141:other': '5', 'nep141:usdc.test': '123' },
    hourly: { 'nep141:other': '9' },
    daily: { 'nep141:usdc.test': '1000' },
  });
  assert.deepEqual(next.actions, ['swap']);
  assert.equal(next.budget.daily_usd, '250');
  assert.deepEqual(policy.limits.per_transaction, { 'nep141:other': '5' }, 'the original policy is not changed');
  assert.deepEqual(withSliceCap({ actions: ['swap'] }, { assetId: 'a', perSwap: 1n, perDay: 2n }).limits, {
    per_transaction: { a: '1' },
    daily: { a: '2' },
  });
});

test('the desk reads whether the signed policy holds the order to one slice per swap', () => {
  const assetId = 'nep141:usdc.test';
  const schedule = [{ amount: 300n }, { amount: 450n }, { amount: 250n }];
  const check = (limits) => checkSliceCap({ limits }, { assetId, schedule, total: 1000n });
  const cap = (perSwap, perDay) => ({ per_transaction: { [assetId]: String(perSwap) }, ...(perDay ? { daily: { [assetId]: String(perDay) } } : {}) });

  assert.equal(check({}).reason, 'no_cap');
  assert.equal(check({ per_transaction: { 'nep141:other': '1' } }).reason, 'no_cap');
  assert.equal(check(cap(1000)).reason, 'cap_allows_whole_order');
  assert.equal(check(cap(449)).reason, 'cap_below_slice');
  assert.equal(check(cap(450, 999)).reason, 'daily_below_order');
  const ok = check(cap(450, 1000));
  assert.deepEqual(ok, { ok: true, reason: 'capped', perSwap: 450n, perDay: 1000n, largest: 450n, total: 1000n });
  assert.equal(check(cap(600)).ok, true, 'a cap without a daily limit still stops the one big swap');
  assert.equal(checkSliceCap(null, { assetId, schedule, total: 1000n }).reason, 'no_cap');
});
