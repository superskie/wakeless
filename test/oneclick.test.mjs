import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOneClick, intentsQuoteBody, normalizeQuote } from '../src/oneclick.mjs';
import { prepareOrder } from '../src/order.mjs';
import { TOKENS } from './helpers.mjs';

function scriptedFetch(responses) {
  const seen = [];
  const impl = async (url, init) => {
    seen.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status });
  };
  return { impl, seen };
}

test('client retries 429 and 5xx, then returns the final answer', async () => {
  const { impl, seen } = scriptedFetch([
    { status: 429, body: { message: 'slow down' } },
    { status: 503, body: { message: 'unavailable' } },
    { status: 201, body: { quote: { amountOut: '1' } } },
  ]);
  const client = createOneClick({ fetchImpl: impl, sleep: async () => {} });
  const res = await client.quote({ dry: true });
  assert.equal(res.status, 201);
  assert.equal(seen.length, 3);
});

test('client does not retry a 400 and sends the partner key only when set', async () => {
  const { impl, seen } = scriptedFetch([{ status: 400, body: { message: 'No liquidity available' } }]);
  const res = await createOneClick({ fetchImpl: impl, sleep: async () => {} }).quote({});
  assert.equal(res.status, 400);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].init.headers['x-api-key'], undefined);

  const keyed = scriptedFetch([{ status: 201, body: {} }]);
  await createOneClick({ fetchImpl: keyed.impl, apiKey: 'k', sleep: async () => {} }).quote({});
  assert.equal(keyed.seen[0].init.headers['x-api-key'], 'k');
});

test('client turns network errors into a failed result after retries', async () => {
  const { impl, seen } = scriptedFetch([new Error('ECONNRESET'), new Error('ECONNRESET'), new Error('ECONNRESET')]);
  const res = await createOneClick({ fetchImpl: impl, sleep: async () => {} }).quote({});
  assert.equal(res.ok, false);
  assert.equal(res.status, 0);
  assert.match(res.json.message, /ECONNRESET/);
  assert.equal(seen.length, 3);
});

test('a timeout is tried once more, waits longer than 1Click does, and says 1Click did not answer', async () => {
  const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const { impl, seen } = scriptedFetch([timeout(), timeout(), { status: 201, body: {} }]);
  const res = await createOneClick({ fetchImpl: impl, sleep: async () => {} }).quote({});
  assert.equal(seen.length, 2, 'a second timeout ends the tries');
  assert.equal(res.json.message, '1Click did not answer within 30 s');

  // 1Click's own answer when its solvers are slow counts as a timeout too.
  const slow = { status: 500, body: { message: 'Failed to receive response within timeout of 25000ms' } };
  const upstream = scriptedFetch([slow, { ...slow }, { status: 201, body: {} }]);
  const answer = await createOneClick({ fetchImpl: upstream.impl, sleep: async () => {} }).quote({});
  assert.equal(upstream.seen.length, 2);
  assert.equal(answer.status, 500);
  assert.match(answer.json.message, /within timeout of 25000ms/);
});

test('an error that quotes the partner key keeps it out of the result', async () => {
  const key = 'FAKE-KEY\rmid';
  const leak = new TypeError(`Headers.append: "${key}" is an invalid header value.`);
  const { impl } = scriptedFetch([leak, leak, leak]);
  const res = await createOneClick({ fetchImpl: impl, apiKey: key, sleep: async () => {} }).quote({});
  assert.doesNotMatch(res.json.message, /FAKE-KEY/);
  assert.match(res.json.message, /<redacted>/);
});

test('intents quote body keeps every leg inside NEAR Intents', () => {
  const body = intentsQuoteBody({ sellAsset: 'a', buyAsset: 'b', amount: 5n, account: 'x.near', now: 0 });
  assert.deepEqual(
    { ...body },
    {
      dry: true,
      swapType: 'EXACT_INPUT',
      slippageTolerance: 100,
      originAsset: 'a',
      depositType: 'INTENTS',
      destinationAsset: 'b',
      amount: '5',
      refundTo: 'x.near',
      refundType: 'INTENTS',
      recipient: 'x.near',
      recipientType: 'INTENTS',
      deadline: new Date(30 * 60_000).toISOString(),
    },
  );
});

test('normalizeQuote derives rate, cost against mid and the implied mid', () => {
  const res = {
    ok: true,
    status: 201,
    latencyMs: 5,
    json: { quote: { amountOut: '10000000000', amountInUsd: '1000', amountOutUsd: '995', minAmountOut: '9900000000' } },
  };
  const q = normalizeQuote(res, { sellDecimals: 6, buyDecimals: 9, amountIn: 1_000_000_000n });
  assert.equal(q.ok, true);
  assert.equal(q.rate, 0.01);
  assert.ok(Math.abs(q.costBps - 50) < 1e-9);
  assert.ok(Math.abs(q.midRate - 0.01 / 0.995) < 1e-12);

  const fail = normalizeQuote({ ok: false, status: 400, json: { message: 'No liquidity available' } }, { sellDecimals: 6, buyDecimals: 9, amountIn: 1n });
  assert.equal(fail.ok, false);
  assert.equal(fail.noLiquidity, true);
});

test('prepareOrder validates the order file', () => {
  const base = { id: 'ok-order', sell: 'usdc:arb', buy: 'sol:sol', amount: '1000' };
  const o = prepareOrder(base, TOKENS);
  assert.equal(o.totalUnits, 1_000_000_000n);
  assert.equal(o.minSliceUnits, 100_000_000n);
  assert.throws(() => prepareOrder({ ...base, id: 'Bad Id' }, TOKENS), /order id/);
  assert.throws(() => prepareOrder({ ...base, buy: 'usdc:arb' }, TOKENS), /different assets/);
  assert.throws(() => prepareOrder({ ...base, buy: 'doge:sol' }, TOKENS), /not found/);
  assert.throws(() => prepareOrder({ ...base, amount: '1.1234567' }, TOKENS), /decimal places/);
  assert.throws(() => prepareOrder({ ...base, slices: 0 }, TOKENS), /invalid slices/);
});
