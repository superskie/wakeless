// The connected EVM wallet, used as the agent's owner. It signs one sign-in
// message (so the page can read its public key) and the owner's EIP-712
// intents, and can send the deposit. Plain EIP-1193 calls, wallets found
// through EIP-6963 with window.ethereum as the fallback.
import { bytesToHex, erc20TransferData, utf8 } from '../src/evm.mjs';

/** EVM chains a deposit can be sent on, by 1Click blockchain code. */
export const EVM_CHAIN = {
  eth: { id: 1, name: 'Ethereum', explorer: 'https://etherscan.io', rpc: 'https://ethereum-rpc.publicnode.com', currency: 'ETH' },
  arb: { id: 42161, name: 'Arbitrum One', explorer: 'https://arbiscan.io', rpc: 'https://arb1.arbitrum.io/rpc', currency: 'ETH' },
  base: { id: 8453, name: 'Base', explorer: 'https://basescan.org', rpc: 'https://mainnet.base.org', currency: 'ETH' },
  op: { id: 10, name: 'OP Mainnet', explorer: 'https://optimistic.etherscan.io', rpc: 'https://mainnet.optimism.io', currency: 'ETH' },
  pol: { id: 137, name: 'Polygon', explorer: 'https://polygonscan.com', rpc: 'https://polygon-rpc.com', currency: 'POL' },
  bsc: { id: 56, name: 'BNB Smart Chain', explorer: 'https://bscscan.com', rpc: 'https://bsc-dataseed.bnbchain.org', currency: 'BNB' },
  avax: { id: 43114, name: 'Avalanche C-Chain', explorer: 'https://snowtrace.io', rpc: 'https://api.avax.network/ext/bc/C/rpc', currency: 'AVAX' },
};

/** Wallets that announce themselves (EIP-6963), plus window.ethereum when none do. */
export async function discoverWallets(waitMs = 350) {
  const found = new Map();
  const onAnnounce = (event) => {
    const { info, provider } = event.detail ?? {};
    if (info?.uuid && provider && !found.has(info.uuid)) found.set(info.uuid, { info, provider });
  };
  window.addEventListener('eip6963:announceProvider', onAnnounce);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  window.removeEventListener('eip6963:announceProvider', onAnnounce);
  const list = [...found.values()];
  if (!list.length && window.ethereum) list.push({ info: { uuid: 'injected', name: 'Browser wallet', icon: '', rdns: 'injected' }, provider: window.ethereum });
  return list;
}

/** A wallet's refusal (code 4001) reads as such, not as a failure. */
export function walletMessage(err) {
  if (err?.code === 4001 || /user rejected|denied/i.test(err?.message ?? '')) return 'You declined in the wallet. Nothing was signed or sent.';
  return err?.message ?? String(err);
}

export function wallet(provider) {
  const request = (method, params) => provider.request({ method, ...(params ? { params } : {}) });
  return {
    provider,
    async connect() {
      const [account] = await request('eth_requestAccounts');
      if (!account) throw new Error('the wallet returned no account');
      return account.toLowerCase();
    },
    async chainId() {
      return Number.parseInt(await request('eth_chainId'), 16);
    },
    personalSign: (address, message) => request('personal_sign', [bytesToHex(utf8(message)), address]),
    /** The owner's intents come as complete EIP-712 v4 payloads (no chain id in the domain). */
    signTypedData: (address, payload) => request('eth_signTypedData_v4', [address, JSON.stringify(payload)]),
    async switchTo(chain) {
      const c = EVM_CHAIN[chain];
      if (!c) throw new Error(`no EVM chain ${chain}`);
      if ((await this.chainId()) === c.id) return;
      const hex = `0x${c.id.toString(16)}`;
      try {
        await request('wallet_switchEthereumChain', [{ chainId: hex }]);
      } catch (err) {
        if (err?.code !== 4902) throw err;
        await request('wallet_addEthereumChain', [{
          chainId: hex,
          chainName: c.name,
          nativeCurrency: { name: c.currency, symbol: c.currency, decimals: 18 },
          rpcUrls: [c.rpc],
          blockExplorerUrls: [c.explorer],
        }]);
      }
      if ((await this.chainId()) !== c.id) throw new Error(`switch the wallet to ${c.name} and try again`);
    },
    /** Native coin when `token` is null, otherwise an ERC-20 transfer. Returns the transaction hash. */
    async send({ from, chain, to, amount, token }) {
      await this.switchTo(chain);
      const value = BigInt(amount);
      const tx = token
        ? { from, to: token, data: erc20TransferData(to, value), value: '0x0' }
        : { from, to, value: `0x${value.toString(16)}` };
      return request('eth_sendTransaction', [tx]);
    },
    on(event, handler) {
      provider.on?.(event, handler);
    },
  };
}
