// Exact conversions between human amounts and integer base units.
// Amounts that move money are always bigint; floats are only used for rates.

/**
 * Parse a human decimal string ("25000.5") into base units for `decimals`.
 * Rejects more fractional digits than the token supports instead of rounding.
 * @param {string|number} value
 * @param {number} decimals
 * @returns {bigint}
 */
export function toUnits(value, decimals) {
  const text = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`not a positive decimal amount: ${text}`);
  const [whole, frac = ''] = text.split('.');
  if (frac.length > decimals) {
    throw new Error(`${text} has more than ${decimals} decimal places`);
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

/**
 * Format base units as an exact decimal string without trailing zeros.
 * @param {bigint} units
 * @param {number} decimals
 */
export function fromUnits(units, decimals) {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** Base units as a float in human units, for rates and display only. */
export function toNumber(units, decimals) {
  return Number(units) / 10 ** decimals;
}

/** Basis points of `part` relative to `whole` (both plain numbers). */
export function bps(part, whole) {
  return (part / whole) * 10_000;
}
