import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toUnits, fromUnits } from '../src/units.mjs';

test('toUnits parses exact decimals', () => {
  assert.equal(toUnits('25000.5', 6), 25_000_500_000n);
  assert.equal(toUnits('1', 0), 1n);
  assert.equal(toUnits('0.000001', 6), 1n);
  assert.equal(toUnits(250000, 6), 250_000_000_000n);
});

test('toUnits refuses rounding, signs and junk', () => {
  assert.throws(() => toUnits('1.1234567', 6), /decimal places/);
  assert.throws(() => toUnits('-1', 6), /positive decimal/);
  assert.throws(() => toUnits('1e6', 6), /positive decimal/);
  assert.throws(() => toUnits('', 6), /positive decimal/);
});

test('fromUnits round-trips and trims trailing zeros', () => {
  assert.equal(fromUnits(25_000_500_000n, 6), '25000.5');
  assert.equal(fromUnits(1n, 9), '0.000000001');
  assert.equal(fromUnits(0n, 6), '0');
  for (const text of ['1', '0.1', '123456.789', '0.000001']) {
    assert.equal(fromUnits(toUnits(text, 6), 6), text);
  }
});
