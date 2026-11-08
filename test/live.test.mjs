// Live mode against an Agent API double: what gets submitted, with which
// limits, and when the desk stops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOrder } from '../src/engine.mjs';
import { prepareOrder } from '../src/order.mjs';
import { fakeClock } from '../src/clock.mjs';
import { memoryJournal } from '../src/journal.mjs';
import { buildReport, renderReport } from '../src/report.mjs';
import { mulberry32 } from '../src/rng.mjs';
import { fromUnits, minOutAtRate } from '../src/units.mjs';
import { agentQuoteClient } from '../src/agent/quotes.mjs';
import { agentExecutor, submitFailure } from '../src/executors/agent.mjs';
import { dryExecutor } from '../src/executors/dry.mjs';
import { safeErrorText } from '../src/oneclick.mjs';
import { TOKENS } from './helpers.mjs';

const spec = {
  id: 'live-test',
  sell: 'usdc:arb',
  buy: 'sol:sol',
  amount: '1000',
  slices: 5,
  horizonMinutes: 10,
  maxAdverseBps: 50,
  maxDefers: 2,
  minSliceUsd: 10,
};

/** Previews at a fixed rate; settles submitted swaps with scripted outcomes. */
function fakeAgentApi({ outcomes = [], warnings = [], feeBps = 18, rate = 0.0104 } = {}) {
  const previews = [];
  const submits = [];
  const bot = {
    async swap(agentId, req, opts) {
      if (req.dry) {
        previews.push(req);
        const out = BigInt(Math.floor((Number(req.amount) / 1e6) * rate * (1 - feeBps / 10_000) * 1e9));
        return {
          dry: true,
          type: 'swap',
          quote: { amount_out: out.toString(), min_amount_out: ((out * 99n) / 100n).toString(), time_estimate_seconds: 10 },
          fee: { percent: String(feeBps / 100) },
          spend: null,
          warnings: warnings.map((code) => ({ code })),
        };
      }
      submits.push({ agentId, req, opts });
      return { correlation_id: `op-${submits.length}`, status: 'PROCESSING', idempotencyKey: opts.idempotencyKey };
    },
  };
  const api = {
    async getStatus(id) {
      const n = Number(id.slice(3));
      const { req } = submits[n - 1];
      // An outcome is a status, or { status, details } for flags such as never_executed.
      const scripted = outcomes[n - 1] ?? 'SUCCESS';
      const { status: outcome, details: extra = {} } = typeof scripted === 'string' ? { status: scripted } : scripted;
      const settled = BigInt(req.min_amount_out) + 1_000n;
      return {
        correlation_id: id,
        status: outcome,
        failure_code: outcome === 'SUCCESS' ? null : 'not_filled',
        details: { intent_hash: `intent-${n}`, amount_out: outcome === 'SUCCESS' ? settled.toString() : null, confidential: req.confidential, ...extra },
      };
    },
  };
  const prices = { get: async (assetId) => TOKENS.find((t) => t.assetId === assetId) };
  return { bot, api, prices, previews, submits };
}

async function run(fake, mode, overrides = {}) {
  const order = prepareOrder({ ...spec, ...overrides }, TOKENS);
  const journal = memoryJournal();
  const client = agentQuoteClient({ bot: fake.bot, agentId: 'agent-1', prices: fake.prices, clock: () => 0 });
  const executor = agentExecutor({ api: fake.api, bot: fake.bot, agentId: 'agent-1', mode, runId: 'run', submitOptions: { backoffMs: 0 } });
  const result = await runOrder({ order, client, executor, clock: fakeClock(), journal, rand: mulberry32(7), seed: 7 });
  return { order, result, journal, report: buildReport(journal.events) };
}

test('minimum output at a rate is exact and rounds up', () => {
  assert.equal(minOutAtRate(0.5, 10_000_000n, 6, 9), 5_000_000_000n);
  assert.equal(minOutAtRate(2, 3n, 0, 0), 6n);
  assert.equal(minOutAtRate(1 / 3, 1n, 0, 0), 1n);
  assert.equal(minOutAtRate(0, 5n, 6, 9), 0n);
});

test('preview mode prices every slice through the agent and submits nothing', async () => {
  const fake = fakeAgentApi({ warnings: ['insufficient_balance'] });
  const { report } = await run(fake, 'preview');

  assert.equal(fake.submits.length, 0);
  assert.equal(report.mode, 'preview');
  assert.equal(report.filledPct, 100);
  assert.ok(report.fills.every((f) => f.status === 'PREVIEW'));
  assert.ok(fake.previews.every((p) => p.dry === true && p.confidential === true));
  // Probe, one-shot, then one preview per slice.
  assert.equal(fake.previews.length, 2 + report.slices.quotes);
  const text = renderReport(report);
  assert.match(text, /agent preview, no funds moved/);
  assert.match(text, /Preview warnings on 5 of 5 fills: insufficient_balance/);
});

test('live mode submits each slice once, confidential, with the floor as its minimum output', async () => {
  const fake = fakeAgentApi();
  const { report, journal } = await run(fake, 'live');
  const floor = journal.events.find((e) => e.type === 'slice').floorRate;

  assert.equal(fake.submits.length, 5);
  for (const { agentId, req } of fake.submits) {
    assert.equal(agentId, 'agent-1');
    assert.equal(req.confidential, true);
    assert.equal('dry' in req, false);
    assert.ok(BigInt(req.min_amount_out) >= minOutAtRate(floor, BigInt(req.amount), 6, 9));
  }
  assert.equal(new Set(fake.submits.map((s) => s.opts.idempotencyKey)).size, 5);
  assert.equal(report.mode, 'live');
  assert.equal(report.filledPct, 100);
  assert.ok(report.fills.every((f) => f.status === 'SUCCESS' && f.txHashes[0].startsWith('intent-')));
  // Received is what settled, not what was quoted.
  const settled = fake.submits.reduce((sum, { req }) => sum + BigInt(req.min_amount_out) + 1_000n, 0n);
  assert.equal(report.received, fromUnits(settled, 9));
  assert.match(renderReport(report), /Settlement references/);
});

test('a preview warning stops live mode before anything is submitted', async () => {
  const fake = fakeAgentApi({ warnings: ['insufficient_balance'] });
  const { result, report } = await run(fake, 'live');

  assert.equal(result.halted, true);
  assert.equal(fake.submits.length, 0);
  assert.equal(report.filledPct, 0);
  assert.equal(report.halted.status, 'BLOCKED');
  assert.match(renderReport(report), /Stopped early .*insufficient_balance/);
});

test('a refunded slice waits and is tried again under a new idempotency key', async () => {
  const fake = fakeAgentApi({ outcomes: ['REFUNDED'] });
  const { report } = await run(fake, 'live');

  assert.equal(fake.submits.length, 6);
  assert.equal(report.filledPct, 100);
  assert.equal(report.slices.misses, 1);
  assert.equal(report.misses[0].status, 'REFUNDED');
  const [, sliceId] = fake.submits[0].opts.idempotencyKey.match(/^wakeless-run-(.+)-0$/);
  assert.ok(fake.submits.some((s) => s.opts.idempotencyKey === `wakeless-run-${sliceId}-1`));
});

test('an uncertain settlement stops the desk until a person checks it', async () => {
  const fake = fakeAgentApi({ outcomes: ['SUCCESS', 'UNCERTAIN'] });
  const { result, report } = await run(fake, 'live');

  assert.equal(result.halted, true);
  assert.equal(fake.submits.length, 2);
  assert.equal(report.slices.fills, 1);
  assert.equal(report.halted.status, 'UNCERTAIN');
});

test('three unfilled attempts in a row stop the desk', async () => {
  const neverRan = { status: 'FAILED', details: { never_executed: true } };
  const fake = fakeAgentApi({ outcomes: [neverRan, neverRan, neverRan, neverRan] });
  const { result, report } = await run(fake, 'live');

  assert.equal(result.halted, true);
  assert.equal(fake.submits.length, 3);
  assert.equal(report.filledPct, 0);
  assert.match(report.halted.message, /3 attempts in a row/);
});

test('a FAILED swap without proof that nothing ran stops the desk instead of sending the slice again', async () => {
  const fake = fakeAgentApi({ outcomes: ['FAILED'] });
  const { result, report } = await run(fake, 'live');

  assert.equal(result.halted, true);
  assert.equal(fake.submits.length, 1);
  assert.equal(report.halted.status, 'FAILED');
  assert.match(report.halted.message, /without proof that nothing ran; check op-1/);
});

/**
 * An upstream that executes a swap the first time it sees an idempotency key
 * (a replay of the key returns the same operation), while the client gets
 * `lose(n)` instead of the reply to its n-th submit.
 */
function committingUpstream(lose) {
  const fake = fakeAgentApi();
  const swap = fake.bot.swap;
  const executed = new Map();
  let calls = 0;
  fake.bot.swap = async (agentId, req, opts) => {
    if (req.dry) return swap(agentId, req, opts);
    calls += 1;
    if (!executed.has(opts.idempotencyKey)) executed.set(opts.idempotencyKey, await swap(agentId, req, opts));
    const failure = lose(calls);
    if (failure) throw failure;
    return executed.get(opts.idempotencyKey);
  };
  return { fake, executed };
}

test('a submit whose replies are all lost executes the slice once and stops with its key', async () => {
  const lostReplies = {
    'network drop': () => Object.assign(new Error('the Agent API is not reachable: fetch failed'), { status: null }),
    'proxy 502': () => Object.assign(new Error('the Agent API did not answer (TimeoutError)'), { status: 502, code: 'upstream_unreachable', layer: 'proxy' }),
    '409 on the replay': (n) =>
      n === 1 ? Object.assign(new Error('fetch failed'), { status: null }) : Object.assign(new Error('A request with this key is in progress.'), { status: 409, code: 'idempotency_conflict', layer: 'request' }),
    '429 on the replay': (n) =>
      n === 1 ? Object.assign(new Error('fetch failed'), { status: null }) : Object.assign(new Error('Too many requests.'), { status: 429, code: 'rate_limited', retryable: true }),
    'a refusal on the replay': (n) =>
      n === 1 ? Object.assign(new Error('fetch failed'), { status: null }) : Object.assign(new Error('No route.'), { status: 409, code: 'route_unavailable', layer: 'provider' }),
  };
  for (const [name, lose] of Object.entries(lostReplies)) {
    const { fake, executed } = committingUpstream(lose);
    const { result, report, journal } = await run(fake, 'live');

    const perSlice = new Map();
    for (const key of executed.keys()) {
      const slice = key.match(/^wakeless-run-(.+)-\d+$/)[1];
      perSlice.set(slice, (perSlice.get(slice) ?? 0) + 1);
    }
    assert.ok([...perSlice.values()].every((n) => n === 1), `${name}: a slice executed twice: ${[...executed.keys()]}`);
    assert.equal(executed.size, 1, `${name}: the desk stops at the first unclear submit`);
    assert.equal(result.halted, true, name);
    assert.equal(report.halted.status, 'UNKNOWN', name);
    const [key] = executed.keys();
    assert.match(report.halted.message, new RegExp(`check idempotency key ${key}`), name);
    const fill = journal.events.find((e) => e.type === 'fill');
    assert.equal(fill.details.idempotencyKey, key, name);
    assert.equal(fill.details.unsettledAmountIn, fake.submits[0].req.amount, name);
  }
});

test('an upstream that commits on first sight of a key and loses some replies still executes each slice once', async () => {
  // The first try of every key loses its reply; the replay under the same key gets the original operation.
  const seen = new Set();
  const { fake, executed } = committingUpstream(() => null);
  const commit = fake.bot.swap;
  fake.bot.swap = async (agentId, req, opts) => {
    const reply = await commit(agentId, req, opts);
    if (!req.dry && !seen.has(opts.idempotencyKey)) {
      seen.add(opts.idempotencyKey);
      throw Object.assign(new Error('fetch failed'), { status: null });
    }
    return reply;
  };
  const { report } = await run(fake, 'live');

  assert.equal(report.filledPct, 100);
  assert.equal(executed.size, 5, 'one execution per slice');
  assert.equal(fake.submits.length, 5);
});

test('a refusal documented as sending nothing lets the slice wait and go again under a new key', async () => {
  const fake = fakeAgentApi();
  const swap = fake.bot.swap;
  let refused = 0;
  fake.bot.swap = async (agentId, req, opts) => {
    if (!req.dry && refused === 0) {
      refused += 1;
      throw Object.assign(new Error('The wallet is busy.'), { status: 409, code: 'wallet_busy', layer: 'policy' });
    }
    return swap(agentId, req, opts);
  };
  const { report } = await run(fake, 'live');

  assert.equal(report.filledPct, 100);
  assert.equal(fake.submits.length, 5);
  assert.equal(report.misses[0].status, 'REJECTED');
  assert.ok(fake.submits.some((s) => /-1$/.test(s.opts.idempotencyKey)), 'the refused slice went again under its next key');
});

test('only refusals documented as sending nothing count as nothing sent', () => {
  const kind = (fields) => submitFailure(Object.assign(new Error('x'), fields));
  assert.equal(kind({ status: 403, code: 'policy_action_denied', layer: 'policy' }), 'refused');
  assert.equal(kind({ status: 400, code: 'insufficient_balance', layer: 'balance' }), 'refused');
  assert.equal(kind({ status: 401, code: 'some_new_auth_code', layer: 'auth' }), 'refused');
  assert.equal(kind({ status: 422, code: 'hosted_rule', layer: 'proxy' }), 'refused');
  assert.equal(kind({ status: 409, code: 'route_unavailable', layer: 'provider' }), 'refused_for_now');
  assert.equal(kind({ status: 429, code: 'rate_limited', layer: 'proxy' }), 'refused_for_now');
  assert.equal(kind({ status: 429, code: 'provider_rate_limited', layer: 'provider' }), 'refused_for_now');
  // May have executed: no answer, a server failure, a retryable throttle, earlier work under the key, anything new.
  assert.equal(kind({ status: null }), 'unknown');
  assert.equal(kind({ name: 'TimeoutError' }), 'unknown');
  assert.equal(kind({ status: 502, code: 'upstream_unreachable', layer: 'proxy' }), 'unknown');
  assert.equal(kind({ status: 500, code: 'internal_error', layer: 'api', retryable: true }), 'unknown');
  assert.equal(kind({ status: 429, code: 'provider_rate_limited', retryable: true }), 'unknown');
  assert.equal(kind({ status: 409, code: 'idempotency_conflict', layer: 'request' }), 'unknown');
  assert.equal(kind({ status: 400, code: 'some_new_code' }), 'unknown');
  assert.equal(kind({ status: 418, code: 'teapot', layer: 'proxy' }), 'unknown');
});

test('the executor refuses a floor that is not a positive rate, in every mode', async () => {
  const fake = fakeAgentApi();
  const order = prepareOrder(spec, TOKENS);
  const quote = { amountIn: 200_000_000n, amountOut: 2_000_000_000n, minAmountOut: null, warnings: [] };
  const request = { originAsset: order.sell.assetId, destinationAsset: order.buy.assetId };
  for (const mode of ['preview', 'live']) {
    const executor = agentExecutor({ api: fake.api, bot: fake.bot, agentId: 'agent-1', mode, runId: 'run' });
    for (const floorRate of [0, -1, NaN]) {
      const fill = await executor.execute({ slice: { id: '1', defers: 0 }, quote, request, floorRate, order });
      assert.equal(fill.status, 'NO_FLOOR');
      assert.equal(fill.next, 'halt');
      assert.equal(fill.amountIn, 0n);
    }
  }
  const dry = await dryExecutor().execute({ slice: { id: '1' }, quote, floorRate: 0 });
  assert.deepEqual([dry.status, dry.next, dry.amountIn], ['NO_FLOOR', 'halt', 0n]);
  assert.equal(fake.submits.length, 0);
});

test('error messages lose any header value the runtime quoted, so no key reaches a journal', () => {
  const err = new TypeError('Headers.append: "FAKE-NOT-A-KEY\rmid" is an invalid header value.');
  assert.equal(safeErrorText(err), 'Headers.append: "<redacted>" is an invalid header value.');
  assert.equal(safeErrorText({ message: 'x "k1"k2"k3" is an invalid header value' }), 'x "<redacted>" is an invalid header value');
  assert.equal(safeErrorText(new Error('key FAKE-1 refused'), ['FAKE-1']), 'key <redacted> refused');
});

test('a network error is retried with the same idempotency key', async () => {
  const fake = fakeAgentApi();
  const swap = fake.bot.swap;
  let lostKey = null;
  fake.bot.swap = async (agentId, req, opts) => {
    if (!req.dry && lostKey === null) {
      lostKey = opts.idempotencyKey;
      throw new Error('fetch failed');
    }
    return swap(agentId, req, opts);
  };
  const { report } = await run(fake, 'live');

  assert.equal(report.filledPct, 100);
  assert.equal(fake.submits[0].opts.idempotencyKey, lostKey);
});

test('a hard refusal from the API stops the desk instead of retrying', async () => {
  const fake = fakeAgentApi();
  fake.bot.swap = async (agentId, req) => {
    if (req.dry) return fakeAgentApi().bot.swap(agentId, req);
    throw Object.assign(new Error('The grant does not allow this action.'), { status: 403, code: 'policy_action_denied' });
  };
  const { result, report } = await run(fake, 'live');

  assert.equal(result.halted, true);
  assert.equal(report.halted.status, 'REJECTED');
  assert.match(report.halted.message, /policy_action_denied/);
});

test('the owner freezing the wallet stops the desk at its next slice', async () => {
  const fake = fakeAgentApi();
  const swap = fake.bot.swap;
  let previews = 0;
  fake.bot.swap = async (agentId, req, opts) => {
    // Probe, one-shot and two slices quote; then the owner freezes the wallet.
    if (req.dry && ++previews > 4) {
      throw Object.assign(new Error('The wallet is frozen.'), { status: 409, code: 'wallet_frozen' });
    }
    return swap(agentId, req, opts);
  };
  const { result, report, journal } = await run(fake, 'live');

  assert.equal(result.halted, true);
  assert.equal(previews, 5, 'no slice is quoted after the refusal');
  assert.equal(fake.submits.length, 2);
  assert.equal(report.slices.fills, 2);
  assert.equal(report.halted.status, 'REFUSED');
  assert.equal(journal.events.filter((e) => e.type === 'slice').at(-1).decision.reason, 'refused_wallet_frozen');
  assert.match(renderReport(report), /Stopped early .*The wallet is frozen\. \(wallet_frozen\)/);
});

test('the report states the wallet cap journaled with the order', async () => {
  const fake = fakeAgentApi();
  const order = prepareOrder(spec, TOKENS);
  const journal = memoryJournal();
  const client = agentQuoteClient({ bot: fake.bot, agentId: 'agent-1', prices: fake.prices, clock: () => 0 });
  const executor = agentExecutor({ api: fake.api, bot: fake.bot, agentId: 'agent-1', mode: 'preview', runId: 'run' });
  const walletCap = { revision: 4, reason: 'capped', perSwap: '260000000', perDay: '1000000000', largestSlice: '231000000' };
  await runOrder({ order, client, executor, clock: fakeClock(), journal, rand: mulberry32(7), seed: 7, walletCap });

  const text = renderReport(buildReport(journal.events));
  assert.match(text, /Wallet cap \(policy revision 4\): the wallet refuses any swap above 260\.00 USDC and sales above 1,000\.00 USDC a day; this run's largest slice was 231\.00 USDC\./);
  // A run without a cap says nothing about one.
  assert.doesNotMatch(renderReport((await run(fakeAgentApi(), 'preview')).report), /Wallet cap/);
});

test('a route the agent can not fill is split, like a 1Click no-liquidity answer', async () => {
  const fake = fakeAgentApi();
  const swap = fake.bot.swap;
  fake.bot.swap = async (agentId, req, opts) => {
    if (req.dry && Number(req.amount) > 150_000_000) {
      throw Object.assign(new Error('No route or liquidity is available for this asset pair or amount.'), { status: 409, code: 'route_unavailable' });
    }
    return swap(agentId, req, opts);
  };
  const { report } = await run(fake, 'preview', { slices: 4 });

  assert.ok(report.slices.reasons.no_liquidity_split >= 1);
  assert.equal(report.filledPct, 100);
  assert.equal(report.vsOneShot.executable, false);
});
