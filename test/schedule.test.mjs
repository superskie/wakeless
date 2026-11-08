import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSchedule } from '../src/schedule.mjs';
import { mulberry32 } from '../src/rng.mjs';

const base = { total: 250_000_000_000n, slices: 25, horizonMs: 20 * 60_000, timeJitter: 0.8, sizeJitter: 0.35 };

test('slices add up to the total exactly, for many seeds', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const s = buildSchedule({ ...base, rand: mulberry32(seed) });
    assert.equal(s.length, 25);
    assert.equal(s.reduce((a, x) => a + x.amount, 0n), base.total);
  }
});

test('each slice stays inside its own slot, so order and spacing hold', () => {
  const slot = base.horizonMs / base.slices;
  for (let seed = 1; seed <= 200; seed++) {
    const s = buildSchedule({ ...base, timeJitter: 1, rand: mulberry32(seed) });
    s.forEach((x, i) => {
      assert.ok(x.atMs >= i * slot - 1 && x.atMs <= (i + 1) * slot + 1, `slice ${i} at ${x.atMs}`);
    });
  }
});

test('size jitter stays inside its bound before rescaling', () => {
  const s = buildSchedule({ ...base, rand: mulberry32(7) });
  const even = Number(base.total) / base.slices;
  for (const x of s) {
    const ratio = Number(x.amount) / even;
    // Rescaling moves sizes by at most the jitter of the whole set, so allow a small margin.
    assert.ok(ratio > 1 - 0.35 - 0.1 && ratio < 1 + 0.35 + 0.1, `ratio ${ratio}`);
  }
});

test('the same seed replays the same schedule; another seed does not', () => {
  const a = buildSchedule({ ...base, rand: mulberry32(42) });
  const b = buildSchedule({ ...base, rand: mulberry32(42) });
  const c = buildSchedule({ ...base, rand: mulberry32(43) });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test('zero jitter gives even sizes at slot centres', () => {
  const s = buildSchedule({ ...base, timeJitter: 0, sizeJitter: 0, rand: mulberry32(1) });
  const slot = base.horizonMs / base.slices;
  s.forEach((x, i) => {
    assert.equal(x.atMs, Math.round((i + 0.5) * slot));
    assert.equal(x.amount, base.total / 25n);
  });
});

test('minimum slice is enforced and impossible splits are refused', () => {
  const minSlice = 9_000_000_000n;
  for (let seed = 1; seed <= 100; seed++) {
    const s = buildSchedule({ ...base, sizeJitter: 0.9, minSlice, rand: mulberry32(seed) });
    assert.ok(s.every((x) => x.amount >= minSlice));
    assert.equal(s.reduce((a, x) => a + x.amount, 0n), base.total);
  }
  assert.throws(() => buildSchedule({ ...base, minSlice: 20_000_000_000n, rand: mulberry32(1) }), /fewer slices/);
});

test('no schedule holds an empty slice: such a config is refused, and a 1-unit minimum always works', () => {
  const tiny = { total: 25n, slices: 25, horizonMs: 60_000, sizeJitter: 0.9 };
  assert.throws(() => buildSchedule({ ...tiny, total: 24n, rand: mulberry32(1) }), /empty/);
  let refused = 0;
  for (let seed = 1; seed <= 200; seed++) {
    try {
      assert.ok(buildSchedule({ ...tiny, total: 60n, rand: mulberry32(seed) }).every((s) => s.amount > 0n));
    } catch (err) {
      assert.match(err.message, /0 base units/);
      refused += 1;
    }
    assert.ok(buildSchedule({ ...tiny, total: 60n, minSlice: 1n, rand: mulberry32(seed) }).every((s) => s.amount >= 1n));
  }
  assert.ok(refused > 0, 'without a minimum some seeds would round a slice to 0');
});
