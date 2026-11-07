// Rules for live orders placed from the hosted site. The browser builds the
// agent's policy with them, and the site's proxy refuses any owner intent that
// breaks them, so a modified page can not use the site's partner key to make a
// bigger wallet. These are mainnet funds on unaudited code: small on purpose.
import { hasValidChecksum, isEvmAddress } from '../evm.mjs';

export const HOSTED = {
  /** The largest order, valued at the Agent API's token price. */
  maxOrderUsd: 50,
  /** The proxy allows this much price drift between the ticket and its check. */
  priceSlack: 1.25,
  /** The wallet's daily USD budget counts swaps and withdrawals, so it holds about three orders. */
  budgetUsd: 150,
  maxActionsPerHour: 120,
  minSlices: 2,
  maxSlices: 32,
  maxGrantHours: 24,
  /** Where funds may leave to: the receive address, and a refund address on the sell chain. */
  maxDestinations: 2,
};

// Withdrawal destinations name the chain by its 1Click blockchain code (the
// Agent API refuses `solana` or `ethereum` as "not canonical", checked 8 Nov).
const EVM_CHAINS = new Set(['eth', 'arb', 'base', 'op', 'pol', 'bsc', 'avax']);
export const RECEIVE_CHAINS = new Set([...EVM_CHAINS, 'sol', 'near']);
export const isEvmChain = (chain) => EVM_CHAINS.has(chain);

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Decoded length of a base58 string, or -1 when it is not base58. */
function base58Length(text) {
  let n = 0n;
  for (const c of text) {
    const i = B58.indexOf(c);
    if (i < 0) return -1;
    n = n * 58n + BigInt(i);
  }
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros++;
  return zeros + (n === 0n ? 0 : Math.ceil(n.toString(16).length / 2));
}

const NEAR_NAMED = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** Is `address` a valid recipient on the Agent API chain `chain`? */
export function checkAddress(chain, address) {
  if (typeof address !== 'string' || !address) return { ok: false, reason: 'enter an address' };
  if (isEvmChain(chain)) {
    if (!isEvmAddress(address)) return { ok: false, reason: 'an EVM address is 0x and 40 hex digits' };
    if (!hasValidChecksum(address)) return { ok: false, reason: 'the mixed-case checksum does not match; copy the address again' };
    return { ok: true };
  }
  if (chain === 'sol') {
    if (address.length < 32 || address.length > 44 || base58Length(address) !== 32) return { ok: false, reason: 'a Solana address is 32 bytes in base58' };
    return { ok: true };
  }
  if (chain === 'near') {
    if (/^[0-9a-f]{64}$/.test(address) || NEAR_NAMED.test(address)) return { ok: true };
    return { ok: false, reason: 'not a NEAR account id' };
  }
  return { ok: false, reason: `withdrawals to ${chain} are not supported` };
}

/** The form a destination takes: EVM addresses in lowercase, as the Agent API requires. */
export const canonicalAddress = (chain, address) => (isEvmChain(chain) ? address.toLowerCase() : address);

/** One withdrawal destination per distinct chain and address. */
export function destinationsFor(...entries) {
  const seen = new Set();
  const list = [];
  for (const e of entries) {
    if (!e?.chain || !e?.address) continue;
    const address = canonicalAddress(e.chain, e.address);
    const key = `${e.chain}:${address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ action: 'withdraw', chain: e.chain, address, memo: null });
  }
  return list;
}

/**
 * The policy a hosted order's wallet is created with: swap and withdraw only,
 * confidential form allowed, no swap of the sell asset above one slice, no
 * more than the order sold in a day, withdrawals only to the listed addresses.
 */
export function hostedPolicy({ sellAssetId, perSwap, perDay, destinations }) {
  return {
    frozen: false,
    actions: ['swap', 'withdraw'],
    confidential: true,
    owner_approval: false,
    assets: 'any',
    limits: {
      per_transaction: { [sellAssetId]: BigInt(perSwap).toString() },
      daily: { [sellAssetId]: BigInt(perDay).toString() },
    },
    max_actions_per_hour: HOSTED.maxActionsPerHour,
    destinations: { mode: 'only', list: destinations },
    budget: { daily_usd: String(HOSTED.budgetUsd), weekly_usd: null, monthly_usd: null },
    timelock_ms: 0,
  };
}

const refuse = (reason) => ({ ok: false, reason });
const isUnits = (v) => typeof v === 'string' && /^[0-9]{1,40}$/.test(v);
const usdAtMost = (v, max) => v != null && /^[0-9]+(\.[0-9]+)?$/.test(String(v)) && Number(v) <= max;

function checkPolicy(policy, priceOf) {
  if (!policy || typeof policy !== 'object') return refuse('missing policy');
  if (policy.frozen !== false) return refuse('a new wallet starts unfrozen');
  const actions = policy.actions;
  if (!Array.isArray(actions) || !actions.includes('swap') || actions.some((a) => a !== 'swap' && a !== 'withdraw')) {
    return refuse('the wallet may only swap and withdraw');
  }
  if (policy.confidential !== true) return refuse('the confidential form must be allowed');
  if (policy.owner_approval !== false) return refuse('owner approval per action is not used here');
  if (!Number.isInteger(policy.max_actions_per_hour) || policy.max_actions_per_hour < 1 || policy.max_actions_per_hour > HOSTED.maxActionsPerHour) {
    return refuse(`at most ${HOSTED.maxActionsPerHour} actions an hour`);
  }
  if (policy.timelock_ms != null && policy.timelock_ms !== 0) return refuse('no timelock');
  const d = policy.destinations;
  if (d?.mode !== 'only' || !Array.isArray(d.list) || d.list.length < 1 || d.list.length > HOSTED.maxDestinations) {
    return refuse(`withdrawals go to 1 or ${HOSTED.maxDestinations} listed addresses`);
  }
  for (const entry of d.list) {
    if (entry?.action !== 'withdraw') return refuse('destinations are for withdrawals only');
    const check = checkAddress(entry.chain, entry.address);
    if (!check.ok) return refuse(`destination ${entry.chain}: ${check.reason}`);
  }
  const b = policy.budget;
  if (!b || !usdAtMost(b.daily_usd, HOSTED.budgetUsd)) return refuse(`a daily budget of at most $${HOSTED.budgetUsd}`);
  if ((b.weekly_usd != null && !usdAtMost(b.weekly_usd, HOSTED.budgetUsd * 7)) || (b.monthly_usd != null && !usdAtMost(b.monthly_usd, HOSTED.budgetUsd * 30))) {
    return refuse('weekly and monthly budgets must stay within the daily one');
  }
  const per = Object.entries(policy.limits?.per_transaction ?? {});
  const daily = Object.entries(policy.limits?.daily ?? {});
  if (per.length !== 1 || daily.length !== 1 || per[0][0] !== daily[0][0]) return refuse('one sell asset with a per-swap and a daily limit');
  const [assetId, perSwap] = per[0];
  const perDay = daily[0][1];
  if (!isUnits(perSwap) || !isUnits(perDay) || BigInt(perSwap) <= 0n || BigInt(perSwap) >= BigInt(perDay)) {
    return refuse('the per-swap limit must be below the daily one');
  }
  const token = priceOf(assetId);
  if (!token || !(token.price > 0) || !Number.isInteger(token.decimals)) return refuse(`no price for ${assetId}`);
  const usd = (Number(BigInt(perDay)) / 10 ** token.decimals) * token.price;
  if (usd > HOSTED.maxOrderUsd * HOSTED.priceSlack) return refuse(`hosted orders are capped at $${HOSTED.maxOrderUsd}; this one is about $${usd.toFixed(2)}`);
  return { ok: true, assetId, usd };
}

/**
 * Checks an owner intent before the proxy generates it.
 * @param {object} request the body of `POST /v1/generate-intent`
 * @param {{ priceOf: (assetId: string) => ({ price: number, decimals: number } | null), now?: number }} p
 */
export function checkHostedIntent(request, { priceOf, now = Date.now() }) {
  switch (request?.type) {
    case 'agent_create': {
      const o = request.owner;
      if (o?.type !== 'evm' || !isEvmAddress(o.address) || !/^0x[0-9a-fA-F]{128}$/.test(o.public_key ?? '')) {
        return refuse('the owner is an EVM wallet with its public key');
      }
      if (typeof request.name !== 'string' || request.name.length > 64) return refuse('name the wallet in 64 characters or fewer');
      return checkPolicy(request.policy, priceOf);
    }
    case 'grant_issue': {
      if (typeof request.agent_id !== 'string' || !/^[0-9a-f]{64}$/.test(request.credential ?? '')) return refuse('a grant needs an agent and a credential commitment');
      const expires = Date.parse(request.expires_at ?? '');
      if (!Number.isFinite(expires) || expires <= now || expires > now + HOSTED.maxGrantHours * 3_600_000 + 60_000) {
        return refuse(`a grant expires within ${HOSTED.maxGrantHours} hours`);
      }
      return { ok: true };
    }
    case 'agent_freeze':
    case 'agent_unfreeze':
      return typeof request.agent_id === 'string' ? { ok: true } : refuse('freeze and unfreeze need an agent');
    default:
      return refuse(`the site does not sign ${request?.type ?? 'this'} intents`);
  }
}
