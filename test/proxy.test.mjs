import test from 'node:test';
import assert from 'node:assert/strict';
import { agentProxy, clientKey, windowLimiter } from '../src/agent/proxy.mjs';
import { destinationsFor, hostedPolicy } from '../src/agent/hosted.mjs';

const ETH_BASE = 'nep141:base.omft.near';
const SOL_ID = 'nep141:sol.omft.near';
const AGENT = 'a'.repeat(64);
const GRANT = `ngt_${'x'.repeat(43)}`;
const SITE = 'https://site.test';
// The well-known anvil test account #0 and its public key (a public test key, never funded).
const OWNER = {
  type: 'evm',
  address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  chain_id: 1,
  public_key: '0x8318535b54105d4a7aae60c08fc45f9687181b4fdfc625bd1a753fa7397fed753547f11ca8696646f2f3acb08e31016afac23e630c5d11f59f61fef57b0d2aa5',
};
// What the desk's own fetch sends with every POST.
const DESK_POST = { 'content-type': 'application/json', origin: SITE };

/** `answer(url, init)` replaces upstream's default 202 for calls other than the token list. */
function harness({ answer } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body, signal: init.signal });
    if (u.pathname === '/v1/tokens') return Response.json([{ asset_id: ETH_BASE, price: 2500, decimals: 18 }, { asset_id: SOL_ID, price: 150, decimals: 9 }]);
    if (answer) return answer(u, init);
    return Response.json({ ok: true, path: u.pathname }, { status: 202 });
  };
  const handle = agentProxy({ apiKey: 'partner-key', upstream: 'https://upstream.test', fetch });
  // POSTs carry the desk's headers unless `bare`; `raw` sends the body text as is.
  const send = (method, path, { body, raw, headers = {}, bare = false, client = '203.0.113.7' } = {}) =>
    handle(
      new Request(`${SITE}/api/agent${path}`, {
        method,
        headers: { ...(method === 'POST' && !bare ? DESK_POST : {}), ...headers },
        body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
      }),
      { path: path.split('?')[0], client },
    );
  return { calls, send, handle };
}

const smallPolicy = () =>
  hostedPolicy({ sellAssetId: ETH_BASE, buyAssetId: SOL_ID, perSwap: 4n * 10n ** 15n, perDay: 10n ** 16n, destinations: destinationsFor({ chain: 'base', address: OWNER.address }) });

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
  const owner = OWNER;
  const destinations = destinationsFor({ chain: 'base', address: owner.address });
  const big = hostedPolicy({ sellAssetId: ETH_BASE, buyAssetId: SOL_ID, perSwap: 10n ** 17n, perDay: 10n ** 18n, destinations });
  const res = await send('POST', '/v1/generate-intent', { body: { type: 'agent_create', name: 'Wakeless desk', owner, policy: big } });
  assert.equal(res.status, 422);
  assert.match((await res.json()).errors[0].detail, /capped at \$50/);
  assert.ok(!calls.some((c) => c.path === '/v1/generate-intent'));
  const small = smallPolicy();
  assert.equal((await send('POST', '/v1/generate-intent', { body: { type: 'agent_create', name: 'Wakeless desk', owner, policy: small } })).status, 202);
  assert.equal(calls.filter((c) => c.path === '/v1/generate-intent').length, 1);
  const tokenRead = calls.find((c) => c.path === '/v1/tokens');
  assert.ok(tokenRead.signal instanceof AbortSignal, 'the price read can not hang an owner intent');
  const sneaky = await send('POST', '/v1/generate-intent', { body: { type: 'agent_create', name: 'Wakeless desk', owner, policy: { ...small, native: { evm: { sign_message: true } } } } });
  assert.equal(sneaky.status, 422);
  assert.match((await sneaky.json()).errors[0].detail, /policy\.native is not allowed/);
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

test('odd spellings of a route are never forwarded', async () => {
  const { calls, send } = harness();
  const paths = ['/v1/Tokens', '/V1/tokens', '/v1/tokens/', '//v1/tokens', '/v1//tokens', '/v1/./tokens', '/v1/x/../tokens', '/v1/%74okens', '/v1/tokens%2f', '/v1/tokens;x', '/v1/tokens%00', `/v1/agents/${AGENT}/../policy`, `/v1/agents/${AGENT}%2fpolicy`, `/v1/agents/${AGENT}/POLICY`];
  for (const p of paths) assert.equal((await send('GET', p)).status, 404, p);
  assert.equal(calls.length, 0);
});

const SAFE_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
  'cache-control': 'no-store',
};
const assertSafe = (res, label) => {
  for (const [name, value] of Object.entries(SAFE_HEADERS)) assert.equal(res.headers.get(name), value, `${label}: ${name}`);
};

test('every answer is JSON that can not run as a page, whatever upstream sends', async () => {
  const html = harness({ answer: () => new Response('<script>alert(document.domain)</script>', { status: 400, headers: { 'content-type': 'text/html' } }) });
  const res = await html.send('GET', `/v1/agents/${AGENT}`);
  assert.equal(res.status, 502);
  assert.equal(await code(res), 'upstream_not_json');
  assert.doesNotMatch(await res.text(), /script/);
  assertSafe(res, 'html upstream');
  const { send } = harness();
  assertSafe(await send('GET', '/v1/tokens'), 'forwarded');
  assertSafe(await send('GET', '/v1/unknown'), 'problem');
  const conflict = harness({ answer: () => new Response('{"errors":[]}', { status: 429, headers: { 'content-type': 'application/problem+json', 'retry-after': '7', 'set-cookie': 'a=1', location: 'https://evil.test' } }) });
  const limited = await conflict.send('GET', `/v1/agents/${AGENT}`);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '7', 'the desk backs off for as long as upstream asks');
  assert.equal(limited.headers.get('set-cookie'), null);
  assert.equal(limited.headers.get('location'), null);
  assertSafe(limited, 'problem+json upstream');
});

test('bodiless upstream answers pass through; impossible statuses become a 502', async () => {
  const bare = (status) => harness({ answer: () => ({ status, headers: new Headers(), body: null, text: async () => '' }) });
  for (const status of [204, 205, 304]) {
    const res = await bare(status).send('GET', `/v1/agents/${AGENT}`);
    assert.equal(res.status, status);
    assert.equal(await res.text(), '');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  }
  const res = await bare(101).send('GET', `/v1/agents/${AGENT}`);
  assert.equal(res.status, 502);
  assert.equal(await code(res), 'upstream_bad_status');
});

test('a failure inside the handler is a JSON 500, never a thrown error', async () => {
  const { handle } = harness();
  const broken = { method: 'GET', url: `${SITE}/api/agent/v1/tokens`, headers: { get: () => { throw new TypeError('boom'); } } };
  const res = await handle(broken, { path: '/v1/tokens', client: 'x' });
  assert.equal(res.status, 500);
  assert.equal(await code(res), 'proxy_failed');
  assertSafe(res, 'handler failure');
});

test('bodies are JSON objects, and upstream gets exactly what was checked', async () => {
  const { calls, send } = harness();
  for (const raw of ['null', '1', '"x"', 'true', '[]', '[{"confidential":true}]', '', '{']) {
    assert.equal(await code(await send('POST', `/v1/agents/${AGENT}/deposit`, { raw })), 'bad_json', `deposit ${raw}`);
    assert.equal(await code(await send('POST', `/v1/agents/${AGENT}/swap`, { raw, headers: { 'x-grant-token': GRANT } })), 'bad_json', `swap ${raw}`);
  }
  // A number JSON.stringify would write differently is refused rather than changed.
  for (const amount of ['12345678901234567890', '1.0', '1e3', '-0']) {
    assert.equal(await code(await send('POST', `/v1/agents/${AGENT}/deposit`, { raw: `{"confidential":true,"amount":${amount}}` })), 'bad_json', amount);
  }
  assert.equal(calls.length, 0);
  // Two keys of one name: the proxy checks the last, so upstream must see only that one.
  const deposit = '{"asset":"nep141:base.omft.near","confidential":false,"amount":"1",  "confidential":true}';
  assert.equal((await send('POST', `/v1/agents/${AGENT}/deposit`, { raw: deposit })).status, 202);
  assert.equal(calls.at(-1).body, '{"asset":"nep141:base.omft.near","confidential":true,"amount":"1"}');
  const policy = smallPolicy();
  const evil = { ...policy, native: { evm: { sign_message: true, sign_transaction: true } } };
  const intent = `{"type":"agent_create","name":"Wakeless desk","owner":${JSON.stringify(OWNER)},"policy":${JSON.stringify(evil)},"policy":${JSON.stringify(policy)}}`;
  assert.equal((await send('POST', '/v1/generate-intent', { raw: intent })).status, 202);
  const forwarded = calls.at(-1);
  assert.equal(forwarded.path, '/v1/generate-intent');
  assert.equal(forwarded.body, JSON.stringify({ type: 'agent_create', name: 'Wakeless desk', owner: OWNER, policy }));
  assert.doesNotMatch(forwarded.body, /native/);
  const submit = '{ "intent_id": "intent_1", "signed_data": {"payload": {"b": 2, "a": [1, "x"]}, "signature": "0x00"}, "intent_id": "intent_2" }';
  assert.equal((await send('POST', '/v1/submit-intent', { raw: submit })).status, 202);
  assert.equal(calls.at(-1).body, '{"intent_id":"intent_2","signed_data":{"payload":{"b":2,"a":[1,"x"]},"signature":"0x00"}}');
});

test('posts must be JSON from the desk itself', async () => {
  const { calls, send } = harness();
  const body = { confidential: true, asset: ETH_BASE };
  const path = `/v1/agents/${AGENT}/deposit`;
  const cases = [
    ['no content type', { bare: true, headers: { origin: SITE } }, 415],
    ['text/plain, as a no-cors post sends', { bare: true, headers: { origin: SITE, 'content-type': 'text/plain' } }, 415],
    ['a form post', { bare: true, headers: { origin: SITE, 'content-type': 'application/x-www-form-urlencoded' } }, 415],
    ['json lookalike', { headers: { 'content-type': 'application/jsonp' } }, 415],
    ['another origin', { headers: { origin: 'https://evil.test' } }, 403],
    ['an opaque origin', { headers: { origin: 'null' } }, 403],
    ['the same host over http', { headers: { origin: 'http://site.test' } }, 403],
    ['a cross-site fetch without origin', { bare: true, headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' } }, 403],
    ['a same-site subdomain', { headers: { 'sec-fetch-site': 'same-site' } }, 403],
    ['no origin and no fetch metadata', { bare: true, headers: { 'content-type': 'application/json' } }, 403],
  ];
  for (const [label, opts, status] of cases) assert.equal((await send('POST', path, { body, ...opts })).status, status, label);
  assert.equal(calls.length, 0);
  assert.equal((await send('POST', path, { body })).status, 202, 'the desk');
  assert.equal((await send('POST', path, { body, bare: true, headers: { 'content-type': 'application/json; charset=utf-8', 'sec-fetch-site': 'same-origin' } })).status, 202, 'same origin, no Origin header');
  // A page elsewhere can not spend a visitor's limits with reads either.
  assert.equal((await send('GET', '/v1/tokens', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await send('GET', '/v1/tokens', { headers: { 'sec-fetch-site': 'same-origin' } })).status, 200);
});

test('a large body is refused before it is read in full', async () => {
  const { calls, send, handle } = harness();
  const declared = await send('POST', `/v1/agents/${AGENT}/deposit`, { raw: '{}', headers: { 'content-length': String(64 * 1024) } });
  assert.equal(declared.status, 413);
  let pulled = 0;
  const endless = new ReadableStream({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(16 * 1024).fill(32));
    },
  });
  const path = `/v1/agents/${AGENT}/deposit`;
  const res = await handle(new Request(`${SITE}/api/agent${path}`, { method: 'POST', headers: DESK_POST, body: endless, duplex: 'half' }), { path, client: 'x' });
  assert.equal(res.status, 413);
  assert.ok(pulled <= 5, `read ${pulled} chunks of an endless body`);
  assert.equal(calls.length, 0);
});

test('IPv6 clients are counted by their /64, IPv4-mapped ones by the IPv4 address', async () => {
  const keys = [
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:DB8:1:2::ffff', '2001:db8:1:2::/64'],
    ['2001:0db8:0001:0002:aaaa::1%eth0', '2001:db8:1:2::/64'],
    ['2001:db8:1:3::1', '2001:db8:1:3::/64'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['203.0.113.7', '203.0.113.7'],
    ['::1', '0:0:0:0::/64'],
    [undefined, 'unknown'],
    ['not:an:address', 'not:an:address'],
  ];
  for (const [address, key] of keys) assert.equal(clientKey(address), key, String(address));
  const { send } = harness();
  const body = { type: 'agent_create', name: 'x', owner: { type: 'evm' }, policy: {} };
  const statuses = [];
  for (let i = 1; i <= 6; i++) statuses.push((await send('POST', '/v1/generate-intent', { body, client: `2001:db8:5:6::${i.toString(16)}` })).status);
  assert.deepEqual(statuses, [422, 422, 422, 422, 422, 429], 'one /64 shares the wallet-creation limit');
  assert.equal((await send('POST', '/v1/generate-intent', { body, client: '2001:db8:5:7::1' })).status, 422);
});

test('a full limiter drops its oldest entries, not every client', () => {
  const limiter = windowLimiter({ now: () => 0, maxKeys: 3 });
  assert.equal(limiter.allow('a', 1, 1000), true);
  assert.equal(limiter.allow('a', 1, 1000), false);
  assert.equal(limiter.allow('b', 1, 1000), true);
  assert.equal(limiter.allow('b', 1, 1000), false);
  assert.equal(limiter.allow('c', 1, 1000), true);
  assert.equal(limiter.allow('d', 1, 1000), true, 'full: the oldest entry makes room');
  assert.equal(limiter.allow('b', 1, 1000), false, 'b is still counted');
  assert.equal(limiter.allow('a', 1, 1000), true, 'a was the oldest');
  let t = 0;
  const timed = windowLimiter({ now: () => t, maxKeys: 2 });
  timed.allow('x', 1, 1000);
  t = 500;
  timed.allow('y', 1, 1000);
  assert.equal(timed.allow('y', 1, 1000), false);
  t = 1200;
  assert.equal(timed.allow('z', 1, 1000), true, 'the expired x makes room');
  assert.equal(timed.allow('y', 1, 1000), false, 'y keeps its window');
  t = 1500;
  assert.equal(timed.allow('y', 1, 1000), true, 'a window ends on time');
});

test('status polls hold at most two waits per client', async () => {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const { send } = harness({
    answer: async (u) => {
      if (u.pathname === '/v1/status' && u.searchParams.get('wait_ms') !== '0') await held;
      return Response.json({ status: 'PENDING' });
    },
  });
  const poll = (wait = 30_000) => send('GET', `/v1/status?correlation_id=op_1&wait_ms=${wait}`);
  const first = poll();
  const second = poll();
  const third = await poll();
  assert.equal(third.status, 429);
  assert.equal(await code(third), 'too_many_waits');
  assert.equal(third.headers.get('retry-after'), '2');
  assert.equal((await poll(0)).status, 200, 'a read that does not wait is not held back');
  const other = send('GET', '/v1/status?correlation_id=op_2&wait_ms=5000', { client: '198.51.100.2' });
  release();
  assert.equal((await other).status, 200, 'another client waits on its own');
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  assert.equal((await poll()).status, 200, 'a finished wait frees its place');
});

test('status polls have their own bucket, so they can not starve swaps and balances', async () => {
  const { send } = harness();
  for (let i = 0; i < 600; i++) assert.equal((await send('GET', '/v1/status?correlation_id=op_1&wait_ms=0')).status, 202);
  assert.equal((await send('GET', '/v1/status?correlation_id=op_1&wait_ms=0')).status, 429);
  assert.equal((await send('GET', `/v1/agents/${AGENT}/balances?source=confidential`)).status, 202);
  const swap = { origin_asset: ETH_BASE, destination_asset: SOL_ID, amount: '1', confidential: true };
  assert.equal((await send('POST', `/v1/agents/${AGENT}/swap`, { body: swap, headers: { 'x-grant-token': GRANT } })).status, 202);
});

test('misses count against the client like any other call', async () => {
  const { send } = harness();
  for (let i = 0; i < 600; i++) assert.equal((await send('GET', `/v1/nothing/${i}`)).status, 404);
  assert.equal((await send('GET', '/v1/nothing/more')).status, 429);
  assert.equal((await send('GET', '/v1/tokens', { client: '198.51.100.9' })).status, 200);
});
