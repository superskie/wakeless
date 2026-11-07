// The few EVM pieces the browser needs to make a connected wallet the owner
// of an agent: keccak-256, the public key behind a `personal_sign` signature,
// addresses, and the calldata of an ERC-20 transfer. No dependencies, so the
// page loads no third-party code next to a wallet.
//
// Nothing secret passes through here: recovery reads a public key out of a
// signature the wallet already made. The result is checked against the
// connected address before anything uses it, so a wrong key can only stop the
// flow, never sign for it.

// ---------- hex and bytes ----------

const HEX = /^0x[0-9a-fA-F]*$/;

export function bytesToHex(bytes) {
  let out = '0x';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(hex) {
  if (typeof hex !== 'string' || !HEX.test(hex) || hex.length % 2) throw new Error(`not an even-length 0x hex string: ${hex}`);
  const out = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}

export const utf8 = (text) => new TextEncoder().encode(text);

const bytesToBigInt = (bytes) => (bytes.length ? BigInt(bytesToHex(bytes)) : 0n);
const bigIntToHex32 = (n) => n.toString(16).padStart(64, '0');

// ---------- keccak-256 (the pre-standard padding Ethereum uses) ----------

const MASK = (1n << 64n) - 1n;
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
// Rotation offset of each lane (index x + 5y), from the standard (x, y) walk.
const ROT = (() => {
  const r = new Array(25).fill(0);
  let x = 1;
  let y = 0;
  for (let t = 0; t < 24; t++) {
    r[x + 5 * y] = (((t + 1) * (t + 2)) / 2) % 64;
    [x, y] = [y, (2 * x + 3 * y) % 5];
  }
  return r.map(BigInt);
})();

const rotl = (v, n) => (n === 0n ? v : ((v << n) | (v >> (64n - n))) & MASK);

function keccakF(A) {
  const C = new Array(5);
  const B = new Array(25);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
    for (let x = 0; x < 5; x++) {
      const d = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1n);
      for (let y = 0; y < 25; y += 5) A[x + y] ^= d;
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], ROT[x + 5 * y]);
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) A[x + y] = B[x + y] ^ (~B[((x + 1) % 5) + y] & MASK & B[((x + 2) % 5) + y]);
    }
    A[0] ^= RC[round];
  }
}

/** keccak-256 of bytes (or a UTF-8 string), as 32 bytes. */
export function keccak256(input) {
  const data = typeof input === 'string' ? utf8(input) : input;
  const rate = 136;
  const padded = new Uint8Array(Math.floor(data.length / rate) * rate + rate);
  padded.set(data);
  padded[data.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const A = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
      A[i] ^= lane;
    }
    keccakF(A);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    for (let b = 0; b < 8; b++) out[i * 8 + b] = Number((A[i] >> BigInt(8 * b)) & 0xffn);
  }
  return out;
}

// ---------- secp256k1 public key recovery ----------

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = [
  0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
  1n,
];

const mod = (a, m = P) => {
  const r = a % m;
  return r < 0n ? r + m : r;
};

function pow(base, exp, m) {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

const inv = (a, m) => pow(a, m - 2n, m);

// Jacobian coordinates (X, Y, Z): x = X / Z^2, y = Y / Z^3. Z = 0 is the point at infinity.
function double([X, Y, Z]) {
  if (Z === 0n || Y === 0n) return [0n, 1n, 0n];
  const YY = mod(Y * Y);
  const S = mod(4n * X * YY);
  const M = mod(3n * X * X);
  const X3 = mod(M * M - 2n * S);
  return [X3, mod(M * (S - X3) - 8n * YY * YY), mod(2n * Y * Z)];
}

function add(p1, p2) {
  if (p1[2] === 0n) return p2;
  if (p2[2] === 0n) return p1;
  const [X1, Y1, Z1] = p1;
  const [X2, Y2, Z2] = p2;
  const Z1Z1 = mod(Z1 * Z1);
  const Z2Z2 = mod(Z2 * Z2);
  const U1 = mod(X1 * Z2Z2);
  const U2 = mod(X2 * Z1Z1);
  const S1 = mod(Y1 * Z2 * Z2Z2);
  const S2 = mod(Y2 * Z1 * Z1Z1);
  if (U1 === U2) return S1 === S2 ? double(p1) : [0n, 1n, 0n];
  const H = mod(U2 - U1);
  const R = mod(S2 - S1);
  const HH = mod(H * H);
  const HHH = mod(H * HH);
  const X3 = mod(R * R - HHH - 2n * U1 * HH);
  return [X3, mod(R * (U1 * HH - X3) - S1 * HHH), mod(H * Z1 * Z2)];
}

function multiply(point, scalar) {
  let result = [0n, 1n, 0n];
  for (let i = BigInt(scalar.toString(2).length - 1); i >= 0n; i--) {
    result = double(result);
    if ((scalar >> i) & 1n) result = add(result, point);
  }
  return result;
}

function toAffine([X, Y, Z]) {
  if (Z === 0n) throw new Error('point at infinity');
  const zi = inv(Z, P);
  const zi2 = mod(zi * zi);
  return [mod(X * zi2), mod(Y * zi2 * zi)];
}

/**
 * The uncompressed public key (x and y, 64 bytes) that made `signature` over
 * the 32-byte `hash`. Accepts v as 27/28 or 0/1.
 */
export function recoverPublicKey(hash, signature) {
  const sig = typeof signature === 'string' ? hexToBytes(signature) : signature;
  if (sig.length !== 65) throw new Error(`expected a 65-byte signature, got ${sig.length} bytes`);
  if (hash.length !== 32) throw new Error('expected a 32-byte hash');
  const r = bytesToBigInt(sig.slice(0, 32));
  const s = bytesToBigInt(sig.slice(32, 64));
  const v = sig[64];
  const recovery = v >= 27 ? v - 27 : v;
  if (recovery !== 0 && recovery !== 1) throw new Error(`unsupported recovery id ${v}`);
  if (r <= 0n || r >= N || s <= 0n || s >= N) throw new Error('signature r or s is out of range');
  const alpha = mod(r * r * r + 7n);
  let y = pow(alpha, (P + 1n) / 4n, P);
  if (mod(y * y) !== alpha) throw new Error('signature r is not on the curve');
  if (Number(y & 1n) !== recovery) y = P - y;
  const e = mod(bytesToBigInt(hash), N);
  const rInv = inv(r, N);
  const u1 = mod(-e * rInv, N);
  const u2 = mod(s * rInv, N);
  const [x, yq] = toAffine(add(multiply(G, u1), multiply([r, y, 1n], u2)));
  return hexToBytes(`0x${bigIntToHex32(x)}${bigIntToHex32(yq)}`);
}

// ---------- addresses and messages ----------

/** The lowercase address of a 64-byte public key. */
export function publicKeyToAddress(publicKey) {
  const key = typeof publicKey === 'string' ? hexToBytes(publicKey) : publicKey;
  if (key.length !== 64) throw new Error('expected a 64-byte public key');
  return bytesToHex(keccak256(key).slice(12));
}

export const isEvmAddress = (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);

/** EIP-55 mixed-case form, the one wallets show. */
export function toChecksumAddress(address) {
  if (!isEvmAddress(address)) throw new Error(`not an EVM address: ${address}`);
  const lower = address.slice(2).toLowerCase();
  const hash = bytesToHex(keccak256(lower)).slice(2);
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out;
}

/** Mixed case must match its checksum; all lower or all upper case carries none. */
export function hasValidChecksum(address) {
  if (!isEvmAddress(address)) return false;
  const body = address.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  return toChecksumAddress(address) === address;
}

/** The hash `personal_sign` signs (EIP-191 version 0x45). */
export function hashPersonalMessage(message) {
  const body = typeof message === 'string' ? utf8(message) : message;
  const prefix = utf8(`\x19Ethereum Signed Message:\n${body.length}`);
  const all = new Uint8Array(prefix.length + body.length);
  all.set(prefix);
  all.set(body, prefix.length);
  return keccak256(all);
}

/**
 * Who signed `message` with `personal_sign`: the address and the public key
 * in the form the Agent API takes for an EVM owner (0x plus 128 hex digits).
 */
export function recoverPersonalSigner(message, signature) {
  const key = recoverPublicKey(hashPersonalMessage(message), signature);
  return { address: publicKeyToAddress(key), publicKey: bytesToHex(key) };
}

/** Calldata for ERC-20 `transfer(address,uint256)`. */
export function erc20TransferData(to, amount) {
  if (!isEvmAddress(to)) throw new Error(`not an EVM address: ${to}`);
  const value = BigInt(amount);
  if (value < 0n || value >= 1n << 256n) throw new Error('amount out of range');
  return `0xa9059cbb${to.slice(2).toLowerCase().padStart(64, '0')}${value.toString(16).padStart(64, '0')}`;
}
