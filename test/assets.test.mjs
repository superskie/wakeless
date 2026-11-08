import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAsset, usableTokens } from '../src/assets.mjs';
import { TOKENS } from './helpers.mjs';

// What a renamed or half-filled 1Click entry can look like.
const MALFORMED = [null, { assetId: 'nep141:x.test', symbol: null, blockchain: 'arb', decimals: 6 }, { assetId: 'nep141:y.test', symbol: 'Y', blockchain: null, decimals: 6 }, 'junk'];

test('one malformed token entry does not break every lookup', () => {
  const tokens = [...MALFORMED, ...TOKENS];
  assert.equal(resolveAsset(tokens, 'usdc:arb').assetId, 'nep141:usdc.test');
  assert.equal(resolveAsset(tokens, 'SOL:sol').symbol, 'SOL');
  assert.equal(resolveAsset(tokens, 'nep141:sol.test').decimals, 9);
  assert.throws(() => resolveAsset(tokens, 'usdt:arb'), /not found \(symbols on arb: USDC\)/);
});

test('usableTokens keeps only entries an order can be built from', () => {
  const odd = [
    { assetId: 'nep141:a.test', symbol: 'A', blockchain: 'arb', decimals: 6.5 },
    { assetId: 'nep141:b.test', symbol: 'B', blockchain: 'arb' },
    { assetId: 7, symbol: 'C', blockchain: 'arb', decimals: 6 },
    { assetId: 'nep141:d.test', symbol: 'D', blockchain: 'arb', decimals: -1 },
  ];
  assert.deepEqual(usableTokens([...MALFORMED, ...odd, ...TOKENS]), TOKENS);
  assert.deepEqual(usableTokens({ message: 'Too Many Requests' }), []);
  assert.deepEqual(usableTokens(null), []);
});
