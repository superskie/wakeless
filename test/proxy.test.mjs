import test from 'node:test';
import assert from 'node:assert/strict';
import { agentProxy } from '../src/agent/proxy.mjs';
import { destinationsFor, hostedPolicy } from '../src/agent/hosted.mjs';

const ETH_BASE = 'nep141:base.omft.near';
const AGENT = 'a'.repeat(64);
const GRANT = `ngt_${'x'.repeat(43)}`;

function harness() {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    if (u.pathname === '/v1/tokens') return Response.json([{ asset_id: ETH_BASE, price: 2500, decimals: 18 }]);
    return Response.json({ ok: true, path: u.pathname }, { status: 202 });
  };
  const handle = agentProxy({ apiKey: 'partner-key', upstream: 'https://upstream.test', fetch });
  const send = (method, path, { body, headers = {}, client = '203.0.113.7' } = {}) =>
    handle(new Request(`https://site.test/api/agent${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), { path: path.split('?')[0], client });
  return { calls, send };
}

const code = async (res) => (await res.clone().json()).errors?.[0]?.code;

test('only the calls the desk makes are forwarded, with the partner key added', async () => {
  const { calls, send } = harness();
  const res = await send('GET', '/v1/agents');
  assert.equal(res.status, 404);
  assert.equal(await code(res), 'not_proxied');
  assert.equal((await send('DELETE', `/v1/agents/${AGENT}`)).status, 404);
  assert.equal(calls.length, 0);
  const ok = await send('GET', '/v1/tokens', { headers: { cookie: 'session=1', 'x-api-key': 'visitor-key' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.equal(calls[0].headers['x-api-key'], 'partner-key');
  assert.equal(calls[0].headers.cookie, undefined);
});

test('query strings are narrowed: long polls capped, unknown names dropped', async () => {
  const { calls, send } = harness();
  await send('GET', '/v1/status?correlation_id=op_1&wait_ms=900000&evil=1');
  assert.deepEqual(calls[0].query, { correlation_id: 'op_1', wait_ms: '30000' });
  assert.equal((await send('GET', `/v1/agents/${AGENT}/balances?source=everything`)).status, 400);
});

test('swaps need the grant header and the confidential form', async () => {
  const { calls, send } = harness();
  const body = { origin_asset: ETH_BASE, destination_asset: 'nep141:sol.omft.near', amount: '1', confidential: true };
  assert.equal(await code(await send('POST', `/v1/agents/${AGENT}/swap`, { body })), 'grant_required');
  assert.equal(await code(await send('POST', `/v1/agents/${AGENT}/swap`, { body: { ...body, confidential: false }, headers: { 'x-grant-token': GRANT } })), 'confidential_required');
  const res = await send('POST', `/v1/agents/${AGENT}/swap`, { body, headers: { 'x-grant-token': GRANT, 'idempotency-key': 'wakeless-run-1-0' } });
  assert.equal(res.status, 202);
  const call = calls.at(-1);
  assert.equal(call.headers['x-grant-token'], GRANT);
  assert.equal(call.headers['idempotency-key'], 'wakeless-run-1-0');
  assert.deepEqual(JSON.parse(call.body), body);
});

test('owner intents are checked against the hosted rules before the API builds them', async () => {
  const { calls, send } = harness();
  const owner = { type: 'evm', address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', chain_id: 1, public_key: `0x${'ab'.repeat(64)}` };
  const destinations = destinationsFor({ chain: 'base', address: owner.address });
  const big = hostedPolicy({ sellAssetId: ETH_BASE, perSwap: 10n ** 17n, perDay: 10n ** 18n, destinations });
  const res = await send('POST', '/v1/generate-intent', { body: { type: 'agent_create', name: 'Wakeless desk', owner, policy: big } });
  assert.equal(res.status, 422);
  assert.match((await res.json()).errors[0].detail, /capped at \$50/);
  assert.ok(!calls.some((c) => c.path === '/v1/generate-intent'));
  const small = hostedPolicy({ sellAssetId: ETH_BASE, perSwap: 4n * 10n ** 15n, perDay: 10n ** 16n, destinations });
  assert.equal((await send('POST', '/v1/generate-intent', { body: { type: 'agent_create', name: 'Wakeless desk', owner, policy: small } })).status, 202);
  assert.equal(calls.filter((c) => c.path === '/v1/generate-intent').length, 1);
});

test('each address may create a few wallets an hour', async () => {
  const { send } = harness();
  const body = { type: 'agent_create', name: 'x', owner: { type: 'evm' }, policy: {} };
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await send('POST', '/v1/generate-intent', { body })).status);
  assert.deepEqual(statuses, [422, 422, 422, 422, 422, 429]);
  assert.equal((await send('POST', '/v1/generate-intent', { body, client: '198.51.100.1' })).status, 422);
});

test('without a key the proxy says so instead of calling upstream', async () => {
  const handle = agentProxy({ apiKey: undefined, fetch: () => assert.fail('no upstream call') });
  const res = await handle(new Request('https://site.test/api/agent/v1/tokens'), { path: '/v1/tokens', client: 'x' });
  assert.equal(res.status, 503);
});
