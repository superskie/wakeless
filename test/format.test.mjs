import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareOrder } from '../src/order.mjs';
import { precheck } from '../src/precheck.mjs';
import { TOKENS, fakeMarket } from './helpers.mjs';
import {
  chipAmount,
  clockTime,
  dollars,
  failureReason,
  oneShotGap,
  penaltyText,
  plainMessage,
  qty,
  reportMode,
  signedQty,
} from '../web/format.mjs';

const CLOUDFLARE_502 =
  '<!DOCTYPE html>\n<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->\n<head>\n<title>1click.chaindefuser.com | 502: Bad gateway</title>\n<meta charset="UTF-8" /><style>body{margin:0}.cf-error{color:#333';

test('token amounts keep three significant digits instead of rounding to 0.00', () => {
  // Slices of a live $25 ETH order and of a $500k BTC order, as the desk showed them before: 0.00 and 0.01.
  assert.equal(qty(0.00058), '0.000580');
  assert.equal(qty(0.000703), '0.000703');
  assert.equal(qty(0.0132), '0.0132');
  assert.equal(qty(0.0149), '0.0149');
  assert.equal(qty(1.3208), '1.32');
  assert.equal(qty(500_000), '500,000');
  assert.equal(qty(0), '0');
  assert.equal(qty(-0.000097), '-0.0000970');
  assert.equal(qty(null), '-');
  assert.equal(signedQty(-0.000097), '-0.0000970');
  assert.equal(signedQty(1.5), '+1.50');
});

test('dollar differences show cents under $10', () => {
  assert.equal(dollars(0.4), '$0.40');
  assert.equal(dollars(-0.031), '$0.03');
  assert.equal(dollars(2437.4), '$2,437');
  assert.equal(dollars(-15.6), '$16');
});

test('error messages lose their markup and control characters', () => {
  const text = plainMessage(CLOUDFLARE_502);
  assert.doesNotMatch(text, /[<>]/);
  assert.match(text, /502: Bad gateway/);
  assert.doesNotMatch(text, /margin|cf-error/, 'an unclosed style block is dropped too');
  assert.equal(plainMessage('a\u001b[2K\rb\u0085c'), 'a [2K b c');
  assert.equal(plainMessage('Tom &amp; Jerry &lt;3'), 'Tom & Jerry <3');
  assert.equal(plainMessage(null), '');
  const long = plainMessage('x'.repeat(500), 40);
  assert.equal(long.length, 40);
  assert.ok(long.endsWith('...'));
});

test('a failed quote says why in a few words', () => {
  assert.equal(failureReason({ noLiquidity: true, status: 400, message: 'No liquidity available' }), 'no liquidity');
  assert.equal(failureReason({ noLiquidity: false, status: 503, message: 'HTTP 503' }), 'HTTP 503');
  assert.equal(failureReason({ status: 429, message: 'Too Many Requests' }), 'HTTP 429: Too Many Requests');
  assert.equal(failureReason({ status: 0, message: '1Click did not answer within 30 s' }), 'timed out after 30 s');
  assert.equal(failureReason({ status: 500, message: 'Failed to receive response within timeout' }), 'timed out');
  assert.equal(failureReason({ status: 0, message: 'The operation was aborted due to timeout' }), 'timed out');
  assert.equal(failureReason({ status: 502, message: CLOUDFLARE_502 }), 'HTTP 502: 1click.chaindefuser.com | 502: Bad gateway');
  assert.equal(failureReason({ status: 502, message: '<html><body></body></html>' }), 'HTTP 502');
  assert.equal(failureReason({ status: 0, message: 'Failed to fetch' }), 'Failed to fetch');
  assert.equal(failureReason({}), 'no answer');
});

test('only a no-liquidity answer is reported as the market refusing the whole order', () => {
  const order = { total: '100000', symbol: 'USDC' };
  const none = oneShotGap({ executable: false, noLiquidity: true, status: 400, message: 'No liquidity available' }, order);
  assert.equal(none.headline, 'One swap got no quote.');
  assert.match(none.detail, /no liquidity for the whole 100,000 USDC/);

  const down = oneShotGap({ executable: false, noLiquidity: false, status: 503, message: 'HTTP 503' }, order);
  assert.doesNotMatch(`${down.headline} ${down.detail}`, /no quote|liquidity/i);
  assert.match(down.detail, /did not answer the whole-order quote \(HTTP 503\), so this run has no comparison/);
  assert.equal(down.bar, 'no answer');

  const slow = oneShotGap({ executable: false, noLiquidity: false, status: null, message: '1Click did not answer within 30 s' }, order);
  assert.match(slow.detail, /\(timed out after 30 s\)/);

  // A report from before vsOneShot carried noLiquidity: claim neither cause.
  const old = oneShotGap({ executable: false, message: 'HTTP 503' }, order);
  assert.doesNotMatch(`${old.headline} ${old.detail}`, /liquidity|did not answer/i);
  assert.match(old.detail, /no comparison/);
});

test('a live report never calls its fills simulated and offers no rerun', () => {
  const live = reportMode('live');
  assert.doesNotMatch(live.fineprint, /dry run|simulated/i);
  assert.match(live.fineprint, /settled amounts the Agent API reported/);
  assert.equal(live.rerun, false);
  assert.equal(live.kicker, 'Report, live run');
  assert.equal(reportMode('dry').rerun, true);
  assert.match(reportMode('dry').fineprint, /Dry run/);
  assert.equal(reportMode('preview').rerun, false);
  assert.equal(reportMode(undefined).rerun, false);
});

test('a pre-trade row without a reference reads as a dash, not +0.0 bps', () => {
  assert.equal(penaltyText({ q: { ok: true }, penaltyBps: null }), '-');
  assert.equal(penaltyText({ q: { ok: true }, penaltyBps: 0.01 }), '+0.0 bps');
  assert.equal(penaltyText({ q: { ok: true }, penaltyBps: 48.83 }), '+48.8 bps');
  assert.equal(penaltyText({ q: { ok: false, noLiquidity: true } }), 'no quote');
  assert.equal(penaltyText({ q: { ok: false, noLiquidity: false } }), 'no answer');
});

test('when the $1,000 reference quote fails, no row of the check claims a size costs nothing', async () => {
  const market = fakeMarket();
  let calls = 0;
  const client = {
    quote: (body) => (calls++ === 0 ? Promise.resolve({ ok: false, status: 429, latencyMs: 1, json: { message: 'Too Many Requests' } }) : market.quote(body)),
  };
  const order = prepareOrder({ id: 'check', sell: 'usdc:arb', buy: 'sol:sol', amount: '500000', minSliceUsd: 100 }, TOKENS);
  const r = await precheck({ order, client });
  assert.equal(r.reference.q.ok, false);
  assert.ok(r.rows.length > 1);
  for (const row of r.rows) assert.equal(penaltyText(row), row.q.ok ? '-' : 'no quote');
});

test('size chips round down, so a live $50 chip never lands above $50', () => {
  for (const price of [3512.37, 2499.99, 96.123, 1.0003, 0.2871, 104_321.5, 7.77]) {
    for (const usd of [10, 25, 50]) {
      const amount = chipAmount(usd, price, { decimals: 18, atMost: true });
      const worth = Number(amount) * price;
      assert.ok(worth <= usd, `${amount} at ${price} is $${worth}, above $${usd}`);
      assert.ok(worth > usd * 0.999, `${amount} at ${price} is $${worth}, more than 0.1% under $${usd}`);
    }
  }
  assert.equal(chipAmount(29, 100), '0.29', 'an amount that is exact in decimal stays exact');
  assert.equal(chipAmount(50, 3500), '0.01428');
});

test('stablecoin chips stay at face value unless that would go over the chip', () => {
  assert.equal(chipAmount(500_000, 0.9998, { decimals: 6 }), '500000');
  assert.equal(chipAmount(500_000, 1.0003, { decimals: 6 }), '500000', 'a simulated order keeps the round number');
  assert.equal(chipAmount(50, 0.9999, { decimals: 6, atMost: true }), '50');
  const live = chipAmount(50, 1.0003, { decimals: 6, atMost: true });
  assert.ok(Number(live) * 1.0003 <= 50 && Number(live) < 50, live);
  assert.equal(chipAmount(50, null), '');
  assert.equal(chipAmount(0, 3500), '');
});

test('the clock stops at the next scheduled slice during quote latency and never runs backwards', () => {
  // The audit's case: 16 slices over 10 minutes at x120, every quote taking 1 s.
  const speed = 120;
  const latency = 1000;
  const horizon = 600_000;
  const slots = Array.from({ length: 16 }, (_, i) => Math.round((i + 0.5) * (horizon / 16)));
  // Engine events in wall time: arrival after two quotes at t = 0, then each slice after its sleep and its quote.
  const events = [{ t: 0, wall: 0, type: 'order' }, { t: 0, wall: 2 * latency, type: 'arrival' }];
  let wall = 2 * latency;
  let t = 0;
  for (const at of slots) {
    wall += (at - t) / speed + latency;
    t = at;
    events.push({ t, wall, type: 'slice' });
  }
  let shown = 0;
  let backwards = 0;
  // Sampled every 100 ms like the audit's probe, and once more at the last event, where the run ends.
  const samples = [...Array.from({ length: Math.floor(wall / 100) + 1 }, (_, i) => i * 100), wall];
  for (const now of samples) {
    const seen = events.filter((e) => e.wall <= now);
    const last = seen.at(-1);
    const arrived = seen.some((e) => e.type === 'arrival');
    const cap = arrived ? slots.find((s) => s > last.t) ?? horizon : 0;
    const next = clockTime({ shown, lastT: last.t, sinceMs: now - last.wall, speed, horizon, cap });
    if (next < shown) backwards += 1;
    const engineAt = events.find((e) => e.wall > now)?.t ?? horizon;
    assert.ok(next <= engineAt, `at ${now} ms the clock shows ${next}, past the engine's next event at ${engineAt}`);
    shown = next;
  }
  assert.equal(backwards, 0);
  assert.equal(shown, slots.at(-1));
});

test('at x1 the clock follows the wall clock and ignores the cap', () => {
  assert.equal(clockTime({ shown: 0, lastT: 1000, sinceMs: 500, speed: 1, horizon: 60_000, cap: 1200 }), 1500);
  assert.equal(clockTime({ shown: 5000, lastT: 1000, sinceMs: 0, speed: 1, horizon: 60_000 }), 5000);
  assert.equal(clockTime({ shown: 0, lastT: 59_000, sinceMs: 5000, speed: 1, horizon: 60_000 }), 60_000);
});
