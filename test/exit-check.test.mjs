import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeExit, exitAddressHistory } from '../live/exit-check.mjs';

const ADDRESS = '0x1111111111111111111111111111111111111234';

/** A JSON-RPC endpoint that answers the three reads with fixed values. */
function fakeRpc({ nonce = '0x0', balance = '0x0', code = '0x' } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const batch = JSON.parse(init.body);
    calls.push({ url, batch });
    const result = { eth_getTransactionCount: nonce, eth_getBalance: balance, eth_getCode: code };
    return { json: async () => batch.map((c) => ({ jsonrpc: '2.0', id: c.id, result: result[c.method] })) };
  };
  return { calls, fetchImpl };
}

test('a fresh address is reported as having no visible history', async () => {
  const rpc = fakeRpc();
  const h = await exitAddressHistory({ chain: 'base', address: ADDRESS, fetchImpl: rpc.fetchImpl });
  assert.deepEqual(h, { checked: true, chain: 'base', sent: 0, balanceWei: 0n, isContract: false });
  assert.equal(rpc.calls[0].url, 'https://mainnet.base.org');
  assert.deepEqual(
    rpc.calls[0].batch.map((c) => [c.method, c.params[0]]),
    [
      ['eth_getTransactionCount', ADDRESS],
      ['eth_getBalance', ADDRESS],
      ['eth_getCode', ADDRESS],
    ],
  );
  assert.match(describeExit(h), /^No outgoing transactions and no ETH on base/);
});

test('the wallet that paid in is flagged, because it has sent transactions', async () => {
  const rpc = fakeRpc({ nonce: '0x2a', balance: '0x1' });
  const h = await exitAddressHistory({ chain: 'base', address: ADDRESS, fetchImpl: rpc.fetchImpl });
  assert.equal(h.sent, 42);
  assert.match(describeExit(h), /^This address has sent 42 transactions on base\. A withdrawal to it ties this order to that history/);
});

test('an address that only received ETH is flagged too', async () => {
  const rpc = fakeRpc({ balance: '0xde0b6b3a7640000' });
  const h = await exitAddressHistory({ chain: 'eth', address: ADDRESS, fetchImpl: rpc.fetchImpl });
  assert.match(describeExit(h), /holds ETH, so it has received funds before/);
});

test('a contract is named as a contract', async () => {
  const rpc = fakeRpc({ code: '0x6080' });
  const h = await exitAddressHistory({ chain: 'arb', address: ADDRESS, fetchImpl: rpc.fetchImpl });
  assert.match(describeExit(h), /is a contract on arb/);
});

test('chains without an RPC, bad addresses and dead RPCs are reported, not guessed', async () => {
  assert.match(describeExit(await exitAddressHistory({ chain: 'sol', address: ADDRESS })), /no public RPC is set up for chain "sol"/);
  assert.match(describeExit(await exitAddressHistory({ chain: 'base', address: 'not-an-address' })), /not an EVM address/);
  const dead = async () => {
    throw new Error('connect ECONNREFUSED');
  };
  assert.match(describeExit(await exitAddressHistory({ chain: 'base', address: ADDRESS, fetchImpl: dead })), /the RPC did not answer \(connect ECONNREFUSED\)/);
  const partial = async () => ({ json: async () => [{ id: 1, result: '0x0' }] });
  assert.match(describeExit(await exitAddressHistory({ chain: 'base', address: ADDRESS, fetchImpl: partial })), /incomplete/);
});
