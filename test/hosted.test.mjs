import test from 'node:test';
import assert from 'node:assert/strict';
import { HOSTED, HOSTED_SIZE_JITTER, MAX_CHECKED_ORDER_USD, checkAddress, checkHostedIntent, destinationsFor, hostedPolicy } from '../src/agent/hosted.mjs';
import { publicKeyToAddress, toChecksumAddress } from '../src/evm.mjs';
import { DEFAULTS } from '../src/order.mjs';
import { largestPossibleSlice } from '../src/schedule.mjs';

const ETH_BASE = 'nep141:base.omft.near';
const SOL_ID = 'nep141:sol.omft.near';
const DECOY = 'nep141:usdc.decoy.near';
const prices = new Map([
  [ETH_BASE, { price: 2500, decimals: 18 }],
  [SOL_ID, { price: 150, decimals: 9 }],
  [DECOY, { price: 1, decimals: 6 }],
]);
const priceOf = (id) => prices.get(id) ?? null;
// The well-known anvil test account #0 and its public key (a public test key, never funded).
const EVM = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const PUBLIC_KEY = '0x8318535b54105d4a7aae60c08fc45f9687181b4fdfc625bd1a753fa7397fed753547f11ca8696646f2f3acb08e31016afac23e630c5d11f59f61fef57b0d2aa5';
const SOL = 'BWB7mq4RkwPpLjdvzbPWX82VE5pQvp6kfa7f44NNRpuJ';
const owner = { type: 'evm', address: EVM, chain_id: 1, public_key: PUBLIC_KEY };
const eth = (x) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;

const policyFor = (overrides = {}) => ({
  ...hostedPolicy({ sellAssetId: ETH_BASE, buyAssetId: SOL_ID, perSwap: eth(0.004), perDay: eth(0.01), destinations: destinationsFor({ chain: 'sol', address: SOL }, { chain: 'base', address: EVM }) }),
  ...overrides,
});
const createRequest = (policy, extra = {}) => ({ type: 'agent_create', name: 'Wakeless desk', owner, policy, ...extra });
const create = (policy) => checkHostedIntent(createRequest(policy), { priceOf });

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
    ['unpriced asset', policyFor({ assets: ['nep141:x', SOL_ID], limits: { per_transaction: { 'nep141:x': '1' }, daily: { 'nep141:x': '2' } } }), /no price/],
    ['unpriced bought asset', policyFor({ assets: [ETH_BASE, 'nep141:x'] }), /no price for nep141:x/],
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
  assert.ok(checkHostedIntent({ type: 'agent_freeze', agent_id: 'a'.repeat(64) }, { priceOf }).ok);
  assert.ok(checkHostedIntent({ type: 'agent_unfreeze', agent_id: 'a'.repeat(64) }, { priceOf }).ok);
  for (const type of ['policy_update', 'agent_delete', 'grant_revoke', undefined]) {
    assert.ok(!checkHostedIntent({ type, agent_id: 'a'.repeat(64) }, { priceOf }).ok, String(type));
  }
  for (const body of [null, [], 'agent_freeze', 7]) assert.ok(!checkHostedIntent(body, { priceOf }).ok, JSON.stringify(body));
});

test('the owner fixture is the anvil account behind its public key', () => {
  assert.equal(publicKeyToAddress(PUBLIC_KEY), EVM);
});

test('the hard bound is explicit and the slice bound follows the desk jitter', () => {
  assert.equal(MAX_CHECKED_ORDER_USD, 62.5);
  assert.equal(HOSTED_SIZE_JITTER, DEFAULTS.sizeJitter, 'keep the proxy slice bound in step with the desk');
  const total = eth(0.01);
  const largest = largestPossibleSlice({ total, slices: HOSTED.minSlices, sizeJitter: DEFAULTS.sizeJitter });
  const at = (perSwap) => create(policyFor({ limits: { per_transaction: { [ETH_BASE]: perSwap.toString() }, daily: { [ETH_BASE]: total.toString() } } }));
  assert.ok(at(largest).ok, at(largest).reason);
  assert.match(at(largest + 1n).reason, /largest slice of a 2-slice order/);
  // A tighter budget and fewer actions an hour only narrow the wallet.
  const narrow = hostedPolicy({ sellAssetId: ETH_BASE, buyAssetId: SOL_ID, perSwap: eth(0.004), perDay: eth(0.01), destinations: destinationsFor({ chain: 'sol', address: SOL }), budgetUsd: 100, maxActionsPerHour: 60 });
  assert.ok(create(narrow).ok, create(narrow).reason);
  assert.equal(hostedPolicy({ sellAssetId: ETH_BASE, perSwap: 1n, perDay: 2n, destinations: [] }).assets, 'any', 'the old call still builds a policy, which the proxy refuses');
});

test('every field outside the hosted rules is refused, not passed on', () => {
  const base = policyFor();
  const entry = base.destinations.list[1];
  const limits = (per, daily) => ({ per_transaction: per, daily });
  const policyCases = [
    ['native signing', { ...base, native: { evm: { sign_message: true, sign_transaction: true } } }, /policy\.native is not allowed/],
    ['a schedule', { ...base, schedule: { mode: 'only', time_zone: 'UTC', windows: [{ days: ['mon'], start: '00:00', end: '00:01' }] } }, /policy\.schedule is not allowed/],
    ['any asset', { ...base, assets: 'any' }, /two assets/],
    ['only the sold asset', { ...base, assets: [ETH_BASE] }, /two assets/],
    ['bought asset first', { ...base, assets: [SOL_ID, ETH_BASE] }, /two assets/],
    ['a third asset', { ...base, assets: [ETH_BASE, SOL_ID, DECOY] }, /two assets/],
    ['the same asset twice', { ...base, assets: [ETH_BASE, ETH_BASE] }, /two assets/],
    ['hourly window', { ...base, limits: { ...base.limits, hourly: { [ETH_BASE]: '1' } } }, /policy\.limits\.hourly is not allowed/],
    ['monthly window', { ...base, limits: { ...base.limits, monthly: { [ETH_BASE]: '1' } } }, /policy\.limits\.monthly is not allowed/],
    ['weekly window', { ...base, limits: { ...base.limits, weekly: { [ETH_BASE]: '1' } } }, /policy\.limits\.weekly is not allowed/],
    ['decoy limit, sold asset unlimited', { ...base, limits: limits({ [DECOY]: '1000000' }, { [DECOY]: '2000000' }) }, /two assets/],
    ['decoy limit next to the sold one', { ...base, limits: limits({ [ETH_BASE]: eth(0.004).toString(), [DECOY]: '1' }, base.limits.daily) }, /one sell asset/],
    ['a limit on the bought asset too', { ...base, limits: limits(base.limits.per_transaction, { ...base.limits.daily, [SOL_ID]: '1' }) }, /one sell asset/],
    ['leading zeros in a limit', { ...base, limits: limits({ [ETH_BASE]: `0${eth(0.004)}` }, base.limits.daily) }, /policy\.limits\.per_transaction\.nep141:base\.omft\.near is not what/],
    ['weekly budget', { ...base, budget: { ...base.budget, weekly_usd: '100' } }, /policy\.budget\.weekly_usd is not what/],
    ['budget written 150.00', { ...base, budget: { ...base.budget, daily_usd: '150.00' } }, /policy\.budget\.daily_usd is not what/],
    ['budget as a number', { ...base, budget: { ...base.budget, daily_usd: 150 } }, /budget/],
    ['extra budget key', { ...base, budget: { ...base.budget, yearly_usd: null } }, /policy\.budget\.yearly_usd is not allowed/],
    ['actions reordered', { ...base, actions: ['withdraw', 'swap'] }, /policy\.actions\[0\] is not what/],
    ['swap only', { ...base, actions: ['swap'] }, /policy\.actions is not what/],
    ['a timelock', { ...base, timelock_ms: 60_000 }, /no timelock/],
    ['null timelock', { ...base, timelock_ms: null }, /no timelock/],
    ['mixed-case destination', { ...base, destinations: { mode: 'only', list: [{ ...entry, address: toChecksumAddress(EVM) }] } }, /policy\.destinations\.list\[0\]\.address is not what/],
    ['the same destination twice', { ...base, destinations: { mode: 'only', list: [entry, entry] } }, /policy\.destinations\.list is not what/],
    ['a destination memo', { ...base, destinations: { mode: 'only', list: [{ ...entry, memo: 'x' }] } }, /memo is not what/],
    ['a destination key', { ...base, destinations: { mode: 'only', list: [{ ...entry, tag: 1 }] } }, /list\[0\]\.tag is not allowed/],
    ['an extra policy key', { ...base, expected_revision: 1 }, /policy\.expected_revision is not allowed/],
  ];
  for (const [label, policy, reason] of policyCases) {
    const v = create(policy);
    assert.equal(v.ok, false, label);
    assert.match(v.reason, reason, label);
  }

  const requestCases = [
    ['external_user_id', createRequest(base, { external_user_id: 'u1' }), /external_user_id is not allowed/],
    ['an owner key', createRequest(base, { owner: { ...owner, label: 'x' } }), /owner\.label is not allowed/],
    ['mismatched public key', createRequest(base, { owner: { ...owner, public_key: `0x${'ab'.repeat(64)}` } }), /belongs to another address/],
    ['checksummed owner address', createRequest(base, { owner: { ...owner, address: toChecksumAddress(EVM) } }), /lowercase/],
    ['no chain id', createRequest(base, { owner: { type: 'evm', address: EVM, public_key: PUBLIC_KEY } }), /chain id/],
    ['chain id as text', createRequest(base, { owner: { ...owner, chain_id: '1' } }), /chain id/],
    ['a name with a newline', createRequest(base, { name: 'Wakeless\ndesk' }), /name the wallet/],
  ];
  for (const [label, request, reason] of requestCases) {
    const v = checkHostedIntent(request, { priceOf });
    assert.equal(v.ok, false, label);
    assert.match(v.reason, reason, label);
  }
  assert.ok(checkHostedIntent(createRequest(base), { priceOf }).ok);

  const now = Date.parse('2026-11-08T00:00:00Z');
  const grant = { type: 'grant_issue', agent_id: 'a'.repeat(64), label: 'wakeless-web', credential: 'c'.repeat(64), expires_at: new Date(now + 3_600_000).toISOString() };
  const intentCases = [
    ['grant scope', { ...grant, scope: 'all' }, /scope is not allowed/],
    ['short agent id', { ...grant, agent_id: 'a' }, /agent id/],
    ['upper-case agent id', { ...grant, agent_id: 'A'.repeat(64) }, /agent id/],
    ['63-digit agent id', { ...grant, agent_id: 'a'.repeat(63) }, /agent id/],
    ['expiry without milliseconds', { ...grant, expires_at: '2026-11-08T01:00:00Z' }, /expires within/],
    ['expiry with an offset', { ...grant, expires_at: '2026-11-08T03:00:00.000+02:00' }, /expires within/],
    ['label with a control character', { ...grant, label: 'w\u0007' }, /label the grant/],
    ['freeze reason', { type: 'agent_freeze', agent_id: 'a'.repeat(64), reason: 'x' }, /reason is not allowed/],
    ['freeze without a valid id', { type: 'agent_freeze', agent_id: 'a' }, /agent id/],
    ['unfreeze with a policy', { type: 'agent_unfreeze', agent_id: 'a'.repeat(64), policy: base }, /policy is not allowed/],
  ];
  for (const [label, request, reason] of intentCases) {
    const v = checkHostedIntent(request, { priceOf, now });
    assert.equal(v.ok, false, label);
    assert.match(v.reason, reason, label);
  }
  assert.ok(checkHostedIntent(grant, { priceOf, now }).ok);
});
