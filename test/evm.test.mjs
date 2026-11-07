import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  bytesToHex,
  erc20TransferData,
  hasValidChecksum,
  hexToBytes,
  keccak256,
  publicKeyToAddress,
  recoverPersonalSigner,
  toChecksumAddress,
} from '../src/evm.mjs';

// Values made by viem from random keys (see the note in the file).
const vectors = JSON.parse(fs.readFileSync(new URL('./evm-vectors.json', import.meta.url), 'utf8'));

test('keccak-256 matches known hashes, across the 136-byte block edge', () => {
  assert.equal(bytesToHex(keccak256(new Uint8Array())), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(bytesToHex(keccak256('abc')), '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  for (const v of vectors.keccak) assert.equal(bytesToHex(keccak256(hexToBytes(v.hex))), v.hash, `length ${(v.hex.length - 2) / 2}`);
});

test('personal_sign recovery returns the signer and its public key', () => {
  for (const v of vectors.recover) {
    const got = recoverPersonalSigner(v.message, v.signature);
    assert.equal(got.address, v.address.toLowerCase());
    assert.equal(got.publicKey, v.publicKey);
    assert.equal(publicKeyToAddress(got.publicKey), got.address);
  }
});

test('recovery accepts v as 0 or 1 and refuses what is not a signature', () => {
  const v = vectors.recover[0];
  const low = v.signature.slice(0, 130) + (parseInt(v.signature.slice(130), 16) - 27).toString(16).padStart(2, '0');
  assert.equal(recoverPersonalSigner(v.message, low).address, v.address.toLowerCase());
  assert.throws(() => recoverPersonalSigner(v.message, v.signature.slice(0, 130)), /65-byte/);
  assert.throws(() => recoverPersonalSigner(v.message, `${v.signature.slice(0, 130)}1f`), /recovery id/);
  assert.throws(() => recoverPersonalSigner(v.message, `0x${'00'.repeat(64)}1b`), /out of range/);
});

test('a signature over another message names someone else', () => {
  const v = vectors.recover[1];
  assert.notEqual(recoverPersonalSigner(`${v.message}!`, v.signature).address, v.address.toLowerCase());
});

test('EIP-55 checksums', () => {
  for (const v of vectors.recover) {
    assert.equal(toChecksumAddress(v.address.toLowerCase()), v.address);
    assert.ok(hasValidChecksum(v.address));
  }
  const good = vectors.recover[0].address;
  const flipped = good.slice(0, 2) + [...good.slice(2)].map((c) => (/[a-f]/.test(c) ? c.toUpperCase() : /[A-F]/.test(c) ? c.toLowerCase() : c)).join('');
  assert.ok(!hasValidChecksum(flipped));
  assert.ok(hasValidChecksum(good.toLowerCase()));
  assert.ok(!hasValidChecksum('0x1234'));
});

test('ERC-20 transfer calldata', () => {
  assert.equal(erc20TransferData(vectors.erc20.to, vectors.erc20.amount), vectors.erc20.data);
  assert.throws(() => erc20TransferData('0x12', 1n), /not an EVM address/);
  assert.throws(() => erc20TransferData(vectors.erc20.to, -1n), /out of range/);
});
