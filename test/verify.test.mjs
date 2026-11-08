import test from 'node:test';
import assert from 'node:assert/strict';
import { OWNER_DOMAIN, checkAppliedPolicy, checkDepositAnswer, checkOwnerIntent, checkToken, checkWalletPolicy, nativePower, parseWalletFile, samePolicy } from '../src/agent/verify.mjs';
import { destinationsFor, hostedPolicy } from '../src/agent/hosted.mjs';

// The well-known anvil test account #0 as the owner; every other value is obviously fake.
const OWNER = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const OTHER = `0x${'ba'.repeat(20)}`;
const KEY = `0x${'4b'.repeat(64)}`;
const AGENT = 'ab'.repeat(32);
const SELL = 'nep141:base.omft.near';
const BUY = 'nep141:sol.omft.near';
const SOL = '11111111111111111111111111111111';
const destinations = destinationsFor({ chain: 'sol', address: SOL }, { chain: 'base', address: OWNER });
const policy = hostedPolicy({ sellAssetId: SELL, buyAssetId: BUY, perSwap: 4n, perDay: 10n, destinations });
const evm = { type: 'evm', address: OWNER, chain_id: 1, public_key: KEY };
const ALL_OFF = { near: { sign_message: [], transfer: false, call: [] }, evm: { sign_typed_data: [], sign_message: false, sign_transaction: false }, solana: { sign_message: false, sign_transaction: false } };

/** A generate-intent response shaped like the live one: the fields ride as JSON text in the typed-data message. */
function generated(type, message, extra = {}) {
  return {
    correlation_id: 'intent_1',
    type,
    agent_id: AGENT,
    status: 'PENDING_SIGNATURE',
    signer: { ...evm },
    intent: {
      standard: 'eip712',
      payload: {
        domain: { ...OWNER_DOMAIN },
        types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }], Request: [{ name: 'message', type: 'string' }, { name: 'timeoutSecs', type: 'uint32' }] },
        primaryType: 'Request',
        message: { message: JSON.stringify(message), timeoutSecs: 600 },
      },
    },
    preview: { summary: 'Plain words. Risk notice.' },
    ...extra,
  };
}

const create = { type: 'agent_create', name: 'Wakeless desk', owner: evm, policy };
const createIntent = (p = policy, preview = policy) => generated('agent_create', { owner: evm, policy: p }, { preview: { summary: 'Create it.', policy: preview } });

test('samePolicy accepts equal forms and refuses any changed rule', () => {
  assert.ok(samePolicy(structuredClone(policy), policy).ok);
  const equal = { ...structuredClone(policy), budget: { daily_usd: '150.00', weekly_usd: null, monthly_usd: null }, native: ALL_OFF, schedule: undefined };
  equal.destinations.list.reverse();
  equal.destinations.list[0].address = '0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  assert.ok(samePolicy(equal, policy).ok, 'budget form, all-off native, list order and address case');
  const changed = [
    ['an extra destination', (p) => p.destinations.list.push({ action: 'withdraw', chain: 'base', address: OTHER, memo: null })],
    ['native signing', (p) => (p.native = { ...ALL_OFF, evm: { ...ALL_OFF.evm, sign_transaction: true } })],
    ['transfers', (p) => p.actions.push('transfer')],
    ['a bigger per-swap cap', (p) => (p.limits.per_transaction[SELL] = '5')],
    ['a new field', (p) => (p.approvers = ['x'])],
    ['a bigger budget', (p) => (p.budget.daily_usd = '151')],
    ['a memo', (p) => (p.destinations.list[0].memo = 'm')],
  ];
  for (const [label, change] of changed) {
    const p = structuredClone(policy);
    change(p);
    assert.equal(samePolicy(p, policy).ok, false, label);
  }
  assert.equal(nativePower(undefined), false);
  assert.equal(nativePower(ALL_OFF), false);
  assert.equal(nativePower({ near: { sign_message: ['a.near'] } }), true);
});

test('an agent_create intent is signed only with the policy built here', () => {
  const ok = checkOwnerIntent(create, createIntent(), { owner: OWNER });
  assert.deepEqual(ok, { ok: true, summary: 'Create it.' });
  const bad = structuredClone(policy);
  bad.destinations.list[1].address = OTHER;
  const refusals = [
    ['policy in the preview', createIntent(policy, bad), /destinations/],
    ['policy in the message', createIntent(bad, policy), /destinations/],
    ['native in the message', createIntent({ ...policy, native: { evm: { sign_transaction: true } } }, policy), /native/],
    ['no policy anywhere', generated('agent_create', { owner: evm }), /no policy/],
    ['type', { ...createIntent(), type: 'policy_update' }, /policy_update intent/],
    ['signer', { ...createIntent(), signer: { ...evm, address: OTHER } }, /another signer/],
    ['owner key', { ...createIntent(), signer: { ...evm, public_key: `0x${'5c'.repeat(64)}` } }, /owner's key/],
    ['owner in the message', generated('agent_create', { owner: { ...evm, address: OTHER }, policy }, { preview: { summary: '', policy } }), /another owner/],
  ];
  for (const [label, g, why] of refusals) {
    const r = checkOwnerIntent(create, g, { owner: OWNER });
    assert.equal(r.ok, false, label);
    assert.match(r.reason, why, label);
  }
  const chained = createIntent();
  chained.intent.payload.domain.chainId = 1;
  assert.match(checkOwnerIntent(create, chained, { owner: OWNER }).reason, /domain/);
  const renamed = createIntent();
  renamed.intent.payload.primaryType = 'PolicyUpdate';
  renamed.intent.payload.types.PolicyUpdate = [];
  assert.match(checkOwnerIntent(create, renamed, { owner: OWNER }).reason, /policy_update/);
});

test("a grant intent must carry this tab's credential and expiry, for this agent", () => {
  const expires = new Date(Date.UTC(2026, 10, 8, 12, 0, 0)).toISOString();
  const request = { type: 'grant_issue', agent_id: AGENT, label: 'wakeless-web', credential: 'c0'.repeat(32), expires_at: expires };
  const message = { domain: 'near-intents-agent-api.agent-grant.v6', owner: evm, agent_id: AGENT, label: 'wakeless-web', credential: 'c0'.repeat(32), network: 'mainnet', issued_at_ms: Date.parse(expires) - 7_200_000, expires_at_ms: Date.parse(expires) };
  assert.ok(checkOwnerIntent(request, generated('grant_issue', message), { owner: OWNER }).ok);
  const refusals = [
    ['credential', { ...message, credential: 'ff'.repeat(32) }, /credential/],
    ['a year', { ...message, expires_at_ms: Date.parse(expires) + 365 * 86_400_000 }, /later expiry/],
    ['no expiry', { ...message, expires_at_ms: undefined }, /expiry/],
    ['agent', { ...message, agent_id: 'cd'.repeat(32) }, /another agent/],
    ['owner', { ...message, owner: { ...evm, address: OTHER } }, /another owner/],
  ];
  for (const [label, m, why] of refusals) {
    const r = checkOwnerIntent(request, generated('grant_issue', m), { owner: OWNER });
    assert.equal(r.ok, false, label);
    assert.match(r.reason, why, label);
  }
  assert.match(checkOwnerIntent(request, { ...generated('grant_issue', message), agent_id: 'cd'.repeat(32) }, { owner: OWNER }).reason, /another agent/);
});

test('a freeze can not be swapped for an unfreeze or a delete', () => {
  const request = { type: 'agent_freeze', agent_id: AGENT };
  assert.ok(checkOwnerIntent(request, generated('agent_freeze', { action: 'agent_freeze', agent_id: AGENT }), { owner: OWNER }).ok);
  assert.match(checkOwnerIntent(request, generated('agent_freeze', { action: 'agent_unfreeze', agent_id: AGENT }), { owner: OWNER }).reason, /agent_unfreeze/);
  assert.match(checkOwnerIntent(request, generated('agent_freeze', { action: 'AgentDelete', agent_id: AGENT }), { owner: OWNER }).reason, /agent_delete/);
  assert.match(checkOwnerIntent({ type: 'policy_update', agent_id: AGENT }, generated('policy_update', {}), { owner: OWNER }).reason, /does not sign policy_update/);
});

test('the policy read back must be applied and exactly the one built', () => {
  assert.equal(checkAppliedPolicy({ status: 'SIGNED', policy }, policy).pending, true);
  const frozen = checkAppliedPolicy({ status: 'APPLIED', revision: 2, policy: { ...policy, frozen: true } }, policy);
  assert.deepEqual(frozen, { ok: true, frozen: true, revision: 2 });
  const extra = structuredClone(policy);
  extra.destinations.list.push({ action: 'withdraw', chain: 'base', address: OTHER, memo: null });
  assert.match(checkAppliedPolicy({ status: 'APPLIED', policy: extra }, policy).reason, /destinations/);
});

test("a loaded wallet's policy pays out only to the file's addresses, within the order's limits", () => {
  const expect = { assetId: SELL, perSwap: 4n, perDay: 10n, destinations, maxBudgetUsd: 150 };
  assert.ok(checkWalletPolicy({ policy }, expect).ok);
  const other = destinationsFor({ chain: 'sol', address: SOL }, { chain: 'base', address: OTHER });
  assert.match(checkWalletPolicy({ policy }, { ...expect, destinations: other }).reason, /elsewhere/);
  assert.match(checkWalletPolicy({ policy }, { ...expect, perSwap: 3n }).reason, /limits/);
  assert.match(checkWalletPolicy({ policy: { ...policy, native: { evm: { sign_message: true } } } }, expect).reason, /native/);
  assert.match(checkWalletPolicy({ policy: { ...policy, budget: { daily_usd: '500' } } }, expect).reason, /budget/);
  assert.match(checkWalletPolicy({ policy: { ...policy, actions: ['swap', 'transfer'] } }, expect).reason, /more than/);
});

test("a deposit answer counts only if it fits the request and credits this agent", () => {
  // The fields of a real confidential deposit answer from the Agent API, with fake values.
  const want = { chain: 'base', assetId: SELL, amount: '10000', nearAccount: 'ab'.repeat(32) };
  const details = {
    action: 'cross_chain_deposit',
    amount: '10000',
    min_amount: '10000',
    request: JSON.stringify({ origin_asset: SELL, amount: '10000', confidential: true }),
    refund_to: 'ab'.repeat(32),
    confidential: 'true',
    deposit_address: `0x${'de'.repeat(20)}`,
    near_account_id: 'ab'.repeat(32),
  };
  assert.deepEqual(checkDepositAnswer(details, want), { ok: true });
  const reason = (patch) => checkDepositAnswer({ ...details, ...patch }, want).reason;
  assert.match(reason({ deposit_address: 'not-an-address' }), /chain/);
  assert.match(reason({ near_account_id: 'cd'.repeat(32) }), /credit/);
  assert.match(reason({ refund_to: 'cd'.repeat(32) }), /refunded elsewhere/);
  assert.match(reason({ amount: '1', min_amount: '1' }), /amount/);
  assert.match(reason({ confidential: 'false' }), /confidential/);
  assert.match(reason({ request: JSON.stringify({ origin_asset: BUY }) }), /asset/);
  assert.equal(checkDepositAnswer(details, { ...want, nearAccount: null }).ok, false);
  assert.equal(checkDepositAnswer(null, want).ok, false);
});

test('token decimals must agree with the 1Click list', () => {
  const agent = { assetId: SELL, symbol: 'ETH', blockchain: 'base', decimals: 18 };
  assert.ok(checkToken(agent, { ...agent, contractAddress: null }).ok);
  assert.match(checkToken(agent, { ...agent, decimals: 6 }).reason, /disagree/);
  assert.match(checkToken(agent, undefined).reason, /not in the 1Click/);
});

test('a wallet file is read as a pointer with a strict shape', () => {
  const order = { sell: 'eth:base', buy: 'sol:sol', amount: '0.01', slices: 4, horizonMinutes: 10, maxAdverseBps: 50 };
  const file = { agent_id: AGENT, owner: OWNER, receive: { chain: 'sol', address: SOL }, refund: { chain: 'base', address: OWNER }, order, deposit: { address: OTHER, amount: '1000000000000000000' } };
  const ok = parseWalletFile(JSON.stringify(file));
  assert.equal(ok.ok, true);
  assert.equal(ok.agentId, AGENT);
  assert.equal('deposit' in ok, false, 'a deposit in the file is ignored');
  const bad = [
    ['not json', '{'],
    ['agent id', JSON.stringify({ ...file, agent_id: 'xyz' })],
    ['owner', JSON.stringify({ ...file, owner: 'me' })],
    ['receive', JSON.stringify({ ...file, receive: { chain: 'sol', address: OWNER } })],
    ['amount', JSON.stringify({ ...file, order: { ...order, amount: '1e18' } })],
    ['slices', JSON.stringify({ ...file, order: { ...order, slices: 1 } })],
    ['order', JSON.stringify({ ...file, order: null })],
  ];
  for (const [label, text] of bad) assert.equal(parseWalletFile(text).ok, false, label);
});
