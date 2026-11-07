import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Action, decide, floorFrom } from '../src/guard.mjs';

const ctx = { floorRate: 100, amount: 1_000n, minSlice: 100n, defers: 0, maxDefers: 2, timeLeft: true };

test('a quote at or above the floor executes', () => {
  assert.deepEqual(decide({ ...ctx, quote: { ok: true, rate: 100 } }), { action: Action.EXECUTE, reason: 'at_or_above_floor' });
  assert.equal(decide({ ...ctx, quote: { ok: true, rate: 101 } }).action, Action.EXECUTE);
});

test('a quote below the floor waits while retries and time remain', () => {
  assert.deepEqual(decide({ ...ctx, quote: { ok: true, rate: 99.9 } }), { action: Action.DEFER, reason: 'below_floor_wait' });
});

test('a quote below the floor is skipped when retries or time run out', () => {
  assert.equal(decide({ ...ctx, defers: 2, quote: { ok: true, rate: 99 } }).reason, 'below_floor_exhausted');
  assert.equal(decide({ ...ctx, timeLeft: false, quote: { ok: true, rate: 99 } }).reason, 'below_floor_exhausted');
});

test('no liquidity splits while both halves stay above the minimum', () => {
  const q = { ok: false, noLiquidity: true, message: 'No liquidity available' };
  assert.equal(decide({ ...ctx, quote: q }).action, Action.SPLIT);
  assert.equal(decide({ ...ctx, amount: 199n, quote: q }).reason, 'no_liquidity_wait');
  assert.equal(decide({ ...ctx, amount: 199n, defers: 2, quote: q }).reason, 'no_liquidity_exhausted');
});

test('other failed quotes wait, then skip', () => {
  const q = { ok: false, noLiquidity: false, message: 'HTTP 503' };
  assert.equal(decide({ ...ctx, quote: q }).reason, 'quote_failed_wait');
  assert.equal(decide({ ...ctx, timeLeft: false, quote: q }).reason, 'quote_failed_exhausted');
});

test('a refusal that waiting can not fix stops the order, even with time left', () => {
  const q = { ok: false, noLiquidity: false, refused: true, code: 'wallet_frozen', message: 'The wallet is frozen.' };
  assert.deepEqual(decide({ ...ctx, quote: q }), { action: Action.STOP, reason: 'refused_wallet_frozen' });
  assert.equal(decide({ ...ctx, quote: { ...q, noLiquidity: true } }).action, Action.STOP);
});

test('floor is the arrival rate minus the accepted adverse move', () => {
  assert.equal(floorFrom(100, 50), 99.5);
  assert.equal(floorFrom(0.0104, 0), 0.0104);
});
