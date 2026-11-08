// Is a withdrawal address fresh? Reads the public chain through a public RPC,
// so the owner can see what a withdrawal to it would link the order to before
// signing the policy that allows it.

export const EVM_RPC = Object.freeze({
  base: 'https://mainnet.base.org',
  eth: 'https://ethereum-rpc.publicnode.com',
  arb: 'https://arb1.arbitrum.io/rpc',
});

/** Chains whose addresses are EVM addresses, in the Agent API's spellings and the short ones above. */
const EVM_CHAINS = new Set(['ethereum', 'eth', 'base', 'arbitrum', 'arb', 'optimism', 'polygon', 'bsc', 'avalanche', 'hyperevm', 'hood']);

/**
 * Why `address` can not be an exit on `chain`, or null. Only the shape is
 * checked here (0x and 40 hex digits); the caller checks the EIP-55 checksum.
 */
export function exitAddressProblem(chain, address) {
  if (EVM_CHAINS.has(String(chain).toLowerCase()) && !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return `${address} is not an EVM address (0x and 40 hex digits)`;
  }
  return null;
}

/**
 * @param {object} p
 * @param {string} p.chain Agent API chain id (base, eth, arb)
 * @param {string} p.address
 * @param {typeof fetch} [p.fetchImpl]
 * @param {string} [p.rpc] overrides the public RPC for the chain
 */
export async function exitAddressHistory({ chain, address, fetchImpl = globalThis.fetch, rpc = EVM_RPC[chain] }) {
  if (!rpc) return { checked: false, reason: `no public RPC is set up for chain "${chain}"` };
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return { checked: false, reason: 'not an EVM address' };
  const call = (id, method) => ({ jsonrpc: '2.0', id, method, params: [address, 'latest'] });
  let replies;
  try {
    const res = await fetchImpl(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([call(1, 'eth_getTransactionCount'), call(2, 'eth_getBalance'), call(3, 'eth_getCode')]),
      signal: AbortSignal.timeout(15_000),
    });
    replies = await res.json();
  } catch (err) {
    return { checked: false, reason: `the RPC did not answer (${err.message})` };
  }
  const byId = new Map((Array.isArray(replies) ? replies : []).map((r) => [r.id, r.result]));
  if (![1, 2, 3].every((id) => typeof byId.get(id) === 'string')) {
    return { checked: false, reason: 'the RPC answer was incomplete' };
  }
  return {
    checked: true,
    chain,
    sent: Number(BigInt(byId.get(1))),
    balanceWei: BigInt(byId.get(2)),
    isContract: byId.get(3) !== '0x',
  };
}

/** One plain sentence for the owner. Never blocks: the owner decides. */
export function describeExit(history) {
  if (!history.checked) return `Exit address not checked: ${history.reason}.`;
  const where = `on ${history.chain}`;
  if (history.isContract) {
    return `This address is a contract ${where}. Withdrawals to it are public calls into that contract.`;
  }
  if (history.sent > 0) {
    return (
      `This address has sent ${history.sent} transaction${history.sent === 1 ? '' : 's'} ${where}. ` +
      'A withdrawal to it ties this order to that history. An address with no history keeps the way out unlinked by address; ' +
      'its amount and time can still be matched to the deposit.'
    );
  }
  if (history.balanceWei > 0n) {
    return `This address has sent nothing ${where} but holds ETH, so it has received funds before. Whoever sent them is linked to it.`;
  }
  return (
    `No outgoing transactions and no ETH ${where}: no history the RPC can see. ` +
    '(Incoming token transfers are not visible this way; check an explorer if the address was ever shared.)'
  );
}
