// Seeded randomness so every schedule can be replayed from its journal.

/** FNV-1a 32-bit hash of a string, used to turn an order id into a seed. */
export function seedFrom(input) {
  let hash = 0x811c9dc5;
  for (const ch of String(input)) {
    hash ^= ch.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * mulberry32: small, fast PRNG with a 32-bit state. Not for keys or secrets;
 * it only decides slice timing and sizes, which are private to the desk anyway.
 * @param {number} seed
 * @returns {() => number} uniform in [0, 1)
 */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
