import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { agentHttp, runOwnerIntent } from '../src/agent/http.mjs';
import { GRANT_TOKEN, createGrantCredential, grantCommitment } from '../src/agent/grant.mjs';

function recorder(respond = () => Response.json({ ok: true })) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, ...init });
    return respond(url, init);
  };
  return { calls, fetch };
}

test('requests go to the proxy prefix with the SDK names and headers', async () => {
  const { calls, fetch } = recorder();
  const api = agentHttp({ base: '/api/agent', fetch });
  await api.getStatus('op_1', { waitMs: 30_000 });
  await api.getBalances('agent-1', { source: 'confidential' });
  assert.equal(calls[0].url, '/api/agent/v1/status?correlation_id=op_1&wait_ms=30000');
  assert.equal(calls[1].url, '/api/agent/v1/agents/agent-1/balances?source=confidential');
  assert.equal(calls[0].credentials, 'omit');
  await assert.rejects(api.swap('agent-1', { dry: true }), /needs a grant token/);

  const bot = api.forGrant(`ngt_${'y'.repeat(43)}`);
  await bot.swap('agent-1', { amount: '1', dry: true });
  await bot.swap('agent-1', { amount: '1' }, { idempotencyKey: 'k-1' });
  await bot.withdraw('agent-1', { amount: '1', dry: true });
  const [dry, live, withdraw] = calls.slice(2);
  assert.equal(dry.headers['idempotency-key'], undefined, 'a preview takes no key');
  assert.equal(live.headers['idempotency-key'], 'k-1');
  assert.ok(withdraw.headers['idempotency-key'], 'a withdrawal preview still needs one');
  for (const c of [dry, live, withdraw]) assert.equal(c.headers['x-grant-token'], `ngt_${'y'.repeat(43)}`);
});

test('API errors keep their status and code, like the SDK', async () => {
  const { fetch } = recorder(() => Response.json({ errors: [{ code: 'wallet_frozen', title: 'Conflict', detail: 'The owner froze this agent.' }] }, { status: 409 }));
  const err = await agentHttp({ fetch }).getPolicy('a').catch((e) => e);
  assert.equal(err.status, 409);
  assert.equal(err.code, 'wallet_frozen');
  assert.equal(err.message, 'The owner froze this agent.');
  const down = await agentHttp({ fetch: async () => { throw new TypeError('fetch failed'); } }).getTokens().catch((e) => e);
  assert.equal(down.status, null);
  assert.match(down.message, /not reachable/);
});

test('grant credentials match the SDK format and commitment', async () => {
  const { token, commitment } = await createGrantCredential();
  assert.match(token, GRANT_TOKEN);
  assert.equal(commitment, createHash('sha256').update(token).digest('hex'));
  assert.equal(await grantCommitment(token), commitment);
  await assert.rejects(grantCommitment('ngt_short'), /not a grant token/);
});

// The well-known anvil test account #0; the public key is an obviously fake value.
const OWNER = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const freezeIntent = () => ({
  type: 'agent_freeze',
  agent_id: 'a',
  correlation_id: 'op_9',
  signer: { type: 'evm', address: OWNER, chain_id: 1, public_key: `0x${'4b'.repeat(64)}` },
  intent: { standard: 'eip712', payload: { domain: { name: 'NEAR Wallet Contract', version: '1' }, types: { Request: [{ name: 'message', type: 'string' }] }, primaryType: 'Request', message: { message: '{"agent_id":"a"}' } } },
  preview: { summary: 'Freeze the agent.' },
});

test('an owner intent is checked, signed as-is by the wallet, submitted and followed', async () => {
  const seen = [];
  const statuses = ['PROCESSING', 'SUCCESS'];
  const generated = freezeIntent();
  const api = {
    generateIntent: async (req) => (seen.push(['generate', req.type]), generated),
    submitIntent: async (body) => seen.push(['submit', body]),
    getStatus: async (id) => ({ correlation_id: id, status: statuses.shift() }),
  };
  const sign = async (p) => (seen.push(['sign', p]), '0xsig');
  const result = await runOwnerIntent(api, sign, { type: 'agent_freeze', agent_id: 'a' }, { owner: OWNER, onGenerated: (_g, summary) => seen.push(['summary', summary]) });
  assert.equal(result.status, 'SUCCESS');
  assert.deepEqual(seen.map(([step]) => step), ['generate', 'summary', 'sign', 'submit']);
  assert.equal(seen[1][1], 'Freeze the agent.', 'the API summary is handed to the page before the wallet opens');
  assert.equal(seen[2][1], generated.intent.payload, 'the wallet signs the payload unchanged');
  assert.deepEqual(seen[3][1], { type: 'agent_freeze', correlation_id: 'op_9', signed_data: { ...generated.intent, signature: '0xsig' } });
  await assert.rejects(runOwnerIntent(api, sign, { type: 'agent_freeze', agent_id: 'a' }), /owner address/);
});

test('an owner intent that is not the one asked for never reaches the wallet', async () => {
  const changes = [
    ['type', (g) => (g.type = 'agent_unfreeze')],
    ['agent', (g) => (g.agent_id = 'b')],
    ['signer', (g) => (g.signer.address = `0x${'12'.repeat(20)}`)],
    ['domain', (g) => (g.intent.payload.domain.chainId = 1)],
    ['standard', (g) => (g.intent = { standard: 'nep413', payload: {} })],
    ['message', (g) => (g.intent.payload.message.message = '{"action":"agent_delete","agent_id":"a"}')],
  ];
  for (const [label, change] of changes) {
    const generated = freezeIntent();
    change(generated);
    let signed = 0;
    const api = { generateIntent: async () => generated, submitIntent: async () => assert.fail('submitted'), getStatus: async () => assert.fail('polled') };
    const err = await runOwnerIntent(api, async () => (signed++, '0xsig'), { type: 'agent_freeze', agent_id: 'a' }, { owner: OWNER }).catch((e) => e);
    assert.equal(err?.name, 'OwnerIntentError', label);
    assert.match(err.message, /not asked to sign/, label);
    assert.equal(signed, 0, `${label}: nothing was signed`);
  }
});
