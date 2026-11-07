import test from 'node:test';
import assert from 'node:assert/strict';
import { HOSTED, checkAddress, checkHostedIntent, destinationsFor, hostedPolicy } from '../src/agent/hosted.mjs';
import { toChecksumAddress } from '../src/evm.mjs';

const ETH_BASE = 'nep141:base.omft.near';
const prices = new Map([[ETH_BASE, { price: 2500, decimals: 18 }]]);
const priceOf = (id) => prices.get(id) ?? null;
const EVM = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const SOL = 'BWB7mq4RkwPpLjdvzbPWX82VE5pQvp6kfa7f44NNRpuJ';
const owner = { type: 'evm', address: EVM, chain_id: 1, public_key: `0x${'ab'.repeat(64)}` };
const eth = (x) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;

const policyFor = (overrides = {}) => ({
  ...hostedPolicy({ sellAssetId: ETH_BASE, perSwap: eth(0.004), perDay: eth(0.01), destinations: destinationsFor({ chain: 'sol', address: SOL }, { chain: 'base', address: EVM }) }),
  ...overrides,
});
const create = (policy) => checkHostedIntent({ type: 'agent_create', name: 'Wakeless desk', owner, policy }, { priceOf });

test('addresses are checked per chain', () => {
  assert.ok(checkAddress('base', EVM).ok);
  assert.ok(checkAddress('eth', toChecksumAddress(EVM)).ok);
  assert.ok(!checkAddress('base', '0x8585').ok);
  assert.ok(!checkAddress('base', '0xF39fd6e51aad88f6f4ce6ab8827279cfffb92266').ok, 'mixed case with a wrong checksum');
  assert.ok(checkAddress('sol', SOL).ok);
  assert.ok(!checkAddress('sol', `${SOL.slice(0, -1)}0`).ok, '0 is not base58');
  assert.ok(!checkAddress('sol', SOL.slice(0, 20)).ok);
  assert.ok(checkAddress('near', 'wakeless.near').ok);
  assert.ok(checkAddress('near', 'f'.repeat(64)).ok);
  assert.ok(!checkAddress('near', 'Bad_Account').ok);
  assert.ok(!checkAddress('btc', 'bc1qxyz').ok);
});

test('destinations use lowercase EVM addresses and drop duplicates', () => {
  const list = destinationsFor({ chain: 'base', address: EVM.toUpperCase().replace('0X', '0x') }, { chain: 'base', address: EVM }, { chain: 'sol', address: SOL }, null);
  assert.deepEqual(list, [
    { action: 'withdraw', chain: 'base', address: EVM, memo: null },
    { action: 'withdraw', chain: 'sol', address: SOL, memo: null },
  ]);
});

test('the hosted policy swaps and withdraws only, with a slice cap and the budget', () => {
  const p = policyFor();
  assert.deepEqual(p.actions, ['swap', 'withdraw']);
  assert.equal(p.confidential, true);
  assert.equal(p.limits.per_transaction[ETH_BASE], eth(0.004).toString());
  assert.equal(p.limits.daily[ETH_BASE], eth(0.01).toString());
  assert.equal(p.destinations.mode, 'only');
  assert.equal(p.budget.daily_usd, String(HOSTED.budgetUsd));
  assert.ok(create(p).ok, create(p).reason);
});

test('the proxy rule refuses wallets the hosted site must not make', () => {
  const cases = [
    ['above the cap', policyFor({ limits: { per_transaction: { [ETH_BASE]: eth(0.05).toString() }, daily: { [ETH_BASE]: eth(0.2).toString() } } }), /capped at \$50/],
    ['transfers', policyFor({ actions: ['swap', 'transfer'] }), /only swap and withdraw/],
    ['public form only', policyFor({ confidential: false }), /confidential/],
    ['any destination', policyFor({ destinations: { mode: 'any', list: [] } }), /withdrawals go to/],
    ['three destinations', policyFor({ destinations: { mode: 'only', list: destinationsFor({ chain: 'base', address: EVM }, { chain: 'sol', address: SOL }, { chain: 'near', address: 'x.near' }) } }), /withdrawals go to/],
    ['a big budget', policyFor({ budget: { daily_usd: '5000', weekly_usd: null, monthly_usd: null } }), /budget/],
    ['no slice cap', policyFor({ limits: {} }), /per-swap and a daily limit/],
    ['cap equal to the order', policyFor({ limits: { per_transaction: { [ETH_BASE]: eth(0.01).toString() }, daily: { [ETH_BASE]: eth(0.01).toString() } } }), /below the daily/],
    ['unpriced asset', policyFor({ limits: { per_transaction: { 'nep141:x': '1' }, daily: { 'nep141:x': '2' } } }), /no price/],
    ['frozen from the start', policyFor({ frozen: true }), /unfrozen/],
    ['bad destination', policyFor({ destinations: { mode: 'only', list: [{ action: 'withdraw', chain: 'base', address: '0x1234', memo: null }] } }), /destination base/],
  ];
  for (const [label, policy, reason] of cases) {
    const v = create(policy);
    assert.equal(v.ok, false, label);
    assert.match(v.reason, reason, label);
  }
  const noKey = checkHostedIntent({ type: 'agent_create', name: 'x', owner: { ...owner, public_key: undefined }, policy: policyFor() }, { priceOf });
  assert.match(noKey.reason, /public key/);
});

test('grants expire within a day; freeze and unfreeze pass; other intents do not', () => {
  const now = Date.parse('2026-11-08T00:00:00Z');
  const grant = (hours) => checkHostedIntent({ type: 'grant_issue', agent_id: 'a'.repeat(64), credential: 'c'.repeat(64), label: 'w', expires_at: new Date(now + hours * 3_600_000).toISOString() }, { priceOf, now });
  assert.ok(grant(2).ok);
  assert.ok(grant(24).ok);
  assert.ok(!grant(30 * 24).ok);
  assert.ok(!grant(-1).ok);
  assert.ok(checkHostedIntent({ type: 'agent_freeze', agent_id: 'a' }, { priceOf }).ok);
  assert.ok(checkHostedIntent({ type: 'agent_unfreeze', agent_id: 'a' }, { priceOf }).ok);
  for (const type of ['policy_update', 'agent_delete', 'grant_revoke', undefined]) {
    assert.ok(!checkHostedIntent({ type, agent_id: 'a' }, { priceOf }).ok, String(type));
  }
});
