// Resolve short asset references ("usdc:arb") against the 1Click token list.

/**
 * Accepts a full asset id ("nep141:...") or "symbol:chain" ("usdc:arb", "sol:sol").
 * @param {object[]} tokens response of GET /v0/tokens
 * @param {string} ref
 */
export function resolveAsset(tokens, ref) {
  const text = String(ref).trim();
  let match;
  if (/^nep(141|245):/.test(text)) {
    match = tokens.find((t) => t.assetId === text);
  } else {
    const [symbol, chain] = text.split(':');
    if (!symbol || !chain) throw new Error(`asset "${text}" must look like usdc:arb or a full nep141 id`);
    match = tokens.find((t) => t.symbol.toLowerCase() === symbol.toLowerCase() && t.blockchain === chain.toLowerCase());
    if (!match) {
      const onChain = tokens.filter((t) => t.blockchain === chain.toLowerCase()).map((t) => t.symbol);
      const hint = onChain.length ? `symbols on ${chain}: ${onChain.slice(0, 20).join(', ')}` : `unknown chain "${chain}"`;
      throw new Error(`asset "${text}" not found (${hint})`);
    }
  }
  if (!match) throw new Error(`asset "${text}" not found`);
  return {
    ref: text,
    assetId: match.assetId,
    symbol: match.symbol,
    blockchain: match.blockchain,
    decimals: match.decimals,
    price: match.price ?? null,
    priceUpdatedAt: match.priceUpdatedAt ?? null,
  };
}
