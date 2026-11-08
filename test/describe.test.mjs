// Console lines: network text can not drive the terminal, and new outcomes read plainly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeEvent, printable } from '../src/describe.mjs';

const order = { id: 'o', amount: '10', slices: 2, horizonMs: 60_000, sell: { symbol: 'USDC', blockchain: 'arb', decimals: 6 }, buy: { symbol: 'SOL', blockchain: 'sol', decimals: 9 } };

test('C0 and C1 control characters from the network never reach the terminal', () => {
  assert.equal(printable('a\u001b[2Jb\rc\u0085d\u009be\u007ff'), 'a [2Jb c d e f');
  const lines = [
    describeEvent({ type: 'halt', message: 'bad\u001b]0;title\u0007 news' }, order),
    describeEvent({ type: 'abort', message: 'x\ry' }, order),
    describeEvent({ type: 'arrival', probe: { q: { ok: false, message: 'p\u001b[31m' } }, oneShot: { q: { ok: false, noLiquidity: false, message: 'o\u009b1m' } } }, order),
    describeEvent({ type: 'fill', t: 0, sliceId: '1', status: 'REJECTED', amountIn: '0', amountOut: '0', details: { failureReason: 'r\u001b[0m' } }, order),
  ];
  for (const line of lines) assert.doesNotMatch(line, /[\u0000-\u001f\u007f-\u009f]/, JSON.stringify(line));
});

test('an unknown submit outcome and a stall read as what they are', () => {
  const unknown = describeEvent({ type: 'fill', t: 30_000, sliceId: '2', status: 'UNKNOWN', amountIn: '0', amountOut: '0', details: { failureReason: 'outcome unknown: fetch failed' } }, order);
  assert.equal(unknown, '[00:30]   slice 2: outcome unknown: fetch failed');
  const stall = describeEvent({ type: 'stall', t: 90_000, sliceId: '3', lateMs: 600_000, respread: [{ id: '3' }], expired: ['4'] }, order);
  assert.equal(stall, '[01:30] stalled: slice 3 came due 10:00 late; 1 slices spread over the time left, 1 expired');
  const arrival = describeEvent({ type: 'arrival', probe: { q: { ok: true, rate: 0.01, costBps: 15 } }, oneShot: { q: { ok: false, noLiquidity: false, message: '1Click did not answer within 30 s' } } }, order);
  assert.match(arrival, /whole order in one swap: no quote \(1Click did not answer within 30 s\)/);
});
