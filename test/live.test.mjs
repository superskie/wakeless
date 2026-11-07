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
import { agentExecutor } from '../src/executors/agent.mjs';
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
      const outcome = outcomes[n - 1] ?? 'SUCCESS';
      const settled = BigInt(req.min_amount_out) + 1_000n;
      return {
        correlation_id: id,
        status: outcome,
        failure_code: outcome === 'SUCCESS' ? null : 'not_filled',
        details: { intent_hash: `intent-${n}`, amount_out: outcome === 'SUCCESS' ? settled.toString() : null, confidential: req.confidential },
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
  const fake = fakeAgentApi({ outcomes: ['FAILED', 'FAILED', 'FAILED', 'FAILED'] });
  const { result, report } = await run(fake, 'live');

  assert.equal(result.halted, true);
  assert.equal(fake.submits.length, 3);
  assert.equal(report.filledPct, 0);
  assert.match(report.halted.message, /3 attempts in a row/);
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
