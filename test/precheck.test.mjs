import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareOrder } from '../src/order.mjs';
import { Advice, adviceText, precheck } from '../src/precheck.mjs';
import { TOKENS, fakeMarket } from './helpers.mjs';

const order = (amount, extra = {}) =>
  prepareOrder({ id: 'check', sell: 'usdc:arb', buy: 'sol:sol', amount, minSliceUsd: 100, ...extra }, TOKENS);

// fakeMarket: cost = 15 bps fee + 4 bps x (size / $100k)^2, no quote above capUsd.
// At $500k: one swap +100 bps, 4 slices +6.25, 8 slices +1.56, 16 slices +0.39.

test('a large order is cut into the fewest slices whose size penalty fits the tolerance', async () => {
  const market = fakeMarket();
  const r = await precheck({ order: order('500000'), client: market });
  assert.equal(r.advice, Advice.SLICE);
  assert.equal(r.recommendedSlices, 8);
  assert.ok(r.pick.penaltyBps > 1 && r.pick.penaltyBps < 2, `8 slices pay ${r.pick.penaltyBps}`);
  const one = r.rows.find((row) => row.slices === 1);
  assert.ok(one.penaltyBps > 95 && one.penaltyBps < 105, `one swap pays ${one.penaltyBps}`);
  assert.ok(r.pick.vsOneSwapBps > 95, 'slicing is expected to receive about 100 bps more');
  assert.match(adviceText(r), /^Use 8 slices of about \$62,500/);
});

test('every quote stays inside NEAR Intents and the reference is a $1,000 swap', async () => {
  const market = fakeMarket();
  await precheck({ order: order('500000'), client: market });
  assert.equal(market.calls[0].amount, '1000000000');
  for (const { request } of market.calls) {
    assert.equal(request.dry, true);
    assert.equal(request.depositType, 'INTENTS');
    assert.equal(request.recipientType, 'INTENTS');
  }
});

test('an order that fits in one swap is told to stay one swap', async () => {
  const market = fakeMarket();
  const r = await precheck({ order: order('20000'), client: market });
  assert.equal(r.advice, Advice.ONE_SWAP);
  assert.equal(r.recommendedSlices, 1);
  assert.match(adviceText(r), /^One swap is enough right now/);
});

test('when one swap finds no liquidity, the advice still slices and says so', async () => {
  const market = fakeMarket({ capUsd: 400_000 });
  const r = await precheck({ order: order('500000'), client: market });
  assert.equal(r.oneSwapFills, false);
  assert.equal(r.recommendedSlices, 8);
  assert.equal(r.pick.vsOneSwapBps, null);
  assert.match(adviceText(r), /one swap of the whole order gets no quote \(No liquidity available\)/);
});

test('with a tight tolerance it reports the closest count instead of pretending', async () => {
  const market = fakeMarket();
  const r = await precheck({ order: order('500000'), client: market, toleranceBps: 0.01, maxSlices: 16 });
  assert.equal(r.advice, Advice.CLOSEST);
  assert.equal(r.recommendedSlices, 16);
  assert.match(adviceText(r), /^No slice count tried gets inside the 0.01 bps tolerance\. 16 slices come closest/);
});

test('it never quotes slices smaller than the reference or the minimum slice', async () => {
  const market = fakeMarket();
  const r = await precheck({ order: order('5000', { minSliceUsd: 1000 }), client: market });
  // $5,000 / 8 = $625 is below both, so the ladder stops at 4 slices.
  assert.deepEqual(
    r.rows.map((row) => row.slices),
    [1, 2, 4],
  );
});

test('one lucky reading at a mid size does not set the advice', async () => {
  // Penalty by slice count as seen live on 7 Nov: 16 slices once read +1.8 bps
  // and a minute later +17.4. Here 8 reads lucky, 16 does not, 32 and 64 fit.
  const penalty = { 1: 22, 2: 13, 4: 12, 8: 1.5, 16: 17, 32: 1.5, 64: 0 };
  const total = 500_000;
  const client = {
    async quote(body) {
      const usd = Number(BigInt(body.amount)) / 1e6;
      const slices = Math.round(total / usd);
      const bps = usd <= 1000 ? 0 : penalty[slices];
      const out = usd * 0.0104 * (1 - bps / 10_000);
      return {
        ok: true,
        status: 201,
        latencyMs: 1,
        json: { quote: { amountOut: String(Math.floor(out * 1e9)), amountInUsd: String(usd), amountOutUsd: String(usd) } },
      };
    },
  };
  const r = await precheck({ order: order(String(total)), client });
  assert.equal(r.rows.find((row) => row.slices === 8).penaltyBps < 2, true, '8 slices read inside the tolerance');
  assert.equal(r.advice, Advice.SLICE);
  assert.equal(r.recommendedSlices, 32);
});

test('no reference quote means no advice', async () => {
  const market = fakeMarket({ capUsd: 500 });
  const r = await precheck({ order: order('500000'), client: market });
  assert.equal(r.advice, Advice.NO_QUOTES);
  assert.equal(r.recommendedSlices, null);
  assert.match(adviceText(r), /did not quote the reference swap/);
});
