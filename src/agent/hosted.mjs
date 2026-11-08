// Rules for live orders placed from the hosted site. The browser builds the
// agent's policy with them, and the site's proxy refuses any owner intent that
// breaks them, so a modified page can not use the site's partner key to make a
// bigger wallet. These are mainnet funds on unaudited code: small on purpose.
import { hasValidChecksum, isEvmAddress, publicKeyToAddress } from '../evm.mjs';
import { largestPossibleSlice } from '../schedule.mjs';

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

/** How old the Agent API token price behind the proxy's order check may be. */
export const PRICE_MAX_AGE_MS = 5 * 60_000;

/**
 * The hard bound the proxy enforces: it refuses a wallet whose daily limit on
 * the sold asset is worth more than this at the Agent API's token price, read
 * up to PRICE_MAX_AGE_MS earlier. The slack absorbs drift between the 1Click
 * price behind the ticket and that check, so a $50 ticket may be up to $62.50
 * there. Whatever the limits miss (an owner who sends the bought asset in and
 * sells it back) stays inside the daily USD budget.
 */
export const MAX_CHECKED_ORDER_USD = HOSTED.maxOrderUsd * HOSTED.priceSlack;

/**
 * The desk's size jitter (DEFAULTS.sizeJitter in src/order.mjs; a test keeps
 * them equal). With HOSTED.minSlices it sets the largest per-swap limit the
 * proxy accepts: the biggest slice any seed can draw from such an order.
 */
export const HOSTED_SIZE_JITTER = 0.3;

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
 * `buyAssetId` lists the order's two assets as the only ones the wallet may
 * spend (the bought one so it can be withdrawn); without it the policy says
 * `assets: 'any'`, which the proxy refuses. The proxy rebuilds this object
 * from the request and refuses any difference, so every field here is a rule.
 */
export function hostedPolicy({ sellAssetId, buyAssetId, perSwap, perDay, destinations, budgetUsd = HOSTED.budgetUsd, maxActionsPerHour = HOSTED.maxActionsPerHour }) {
  return {
    frozen: false,
    actions: ['swap', 'withdraw'],
    confidential: true,
    owner_approval: false,
    assets: buyAssetId ? [sellAssetId, buyAssetId] : 'any',
    limits: {
      per_transaction: { [sellAssetId]: BigInt(perSwap).toString() },
      daily: { [sellAssetId]: BigInt(perDay).toString() },
    },
    max_actions_per_hour: maxActionsPerHour,
    destinations: { mode: 'only', list: destinations },
    budget: { daily_usd: String(budgetUsd), weekly_usd: null, monthly_usd: null },
    timelock_ms: 0,
  };
}

const refuse = (reason) => ({ ok: false, reason });
const isUnits = (v) => typeof v === 'string' && /^[0-9]{1,40}$/.test(v);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isHex64 = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const isLabel = (v) => typeof v === 'string' && /^[\x20-\x7e]{1,64}$/.test(v);
// The Agent API's own form for USD amounts: no leading zeros, at most two decimals.
const USD = /^(0|[1-9][0-9]{0,8})(\.[0-9]{1,2})?$/;

/**
 * Where `actual` first differs from `expected`, or null when both are the same
 * JSON value with the same keys at every level. `extra` marks a key that
 * `expected` does not have.
 */
function firstDifference(actual, expected, where = '') {
  const at = (key) => (where ? `${where}.${key}` : key);
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return { where };
    for (let i = 0; i < expected.length; i++) {
      const d = firstDifference(actual[i], expected[i], `${where}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (isObject(expected)) {
    if (!isObject(actual)) return { where };
    const extra = Object.keys(actual).find((k) => !Object.hasOwn(expected, k));
    if (extra !== undefined) return { where: at(extra), extra: true };
    for (const k of Object.keys(expected)) {
      const d = Object.hasOwn(actual, k) ? firstDifference(actual[k], expected[k], at(k)) : { where: at(k) };
      if (d) return d;
    }
    return null;
  }
  return actual === expected ? null : { where };
}

/** Refuses `request` unless it is exactly `expected`: no field added, dropped or changed. */
function pinned(request, expected) {
  const d = firstDifference(request, expected);
  if (!d) return null;
  const where = d.where || 'the intent';
  return refuse(d.extra ? `${where} is not allowed in a hosted intent` : `${where} is not what the hosted rules set`);
}

/** The field checks give a precise reason; the pin in checkHostedIntent then refuses anything they do not name. */
function checkPolicy(policy, priceOf) {
  if (!isObject(policy)) return refuse('missing policy');
  if (policy.frozen !== false) return refuse('a new wallet starts unfrozen');
  const actions = policy.actions;
  if (!Array.isArray(actions) || !actions.includes('swap') || actions.some((a) => a !== 'swap' && a !== 'withdraw')) {
    return refuse('the wallet may only swap and withdraw');
  }
  if (policy.confidential !== true) return refuse('the confidential form must be allowed');
  if (policy.owner_approval !== false) return refuse('owner approval per action is not used here');
  const perHour = policy.max_actions_per_hour;
  if (!Number.isInteger(perHour) || perHour < 1 || perHour > HOSTED.maxActionsPerHour) {
    return refuse(`at most ${HOSTED.maxActionsPerHour} actions an hour`);
  }
  if (policy.timelock_ms !== 0) return refuse('no timelock');
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
  if (!isObject(b) || typeof b.daily_usd !== 'string' || !USD.test(b.daily_usd) || Number(b.daily_usd) > HOSTED.budgetUsd) {
    return refuse(`a daily budget of at most $${HOSTED.budgetUsd}`);
  }
  const per = Object.entries(policy.limits?.per_transaction ?? {});
  const daily = Object.entries(policy.limits?.daily ?? {});
  if (per.length !== 1 || daily.length !== 1 || per[0][0] !== daily[0][0]) return refuse('one sell asset with a per-swap and a daily limit');
  const [assetId, perSwap] = per[0];
  const perDay = daily[0][1];
  if (!isUnits(perSwap) || !isUnits(perDay) || BigInt(perSwap) <= 0n || BigInt(perSwap) >= BigInt(perDay)) {
    return refuse('the per-swap limit must be below the daily one');
  }
  // No order the desk can place draws a bigger slice than this, so no larger cap is needed.
  const largest = largestPossibleSlice({ total: BigInt(perDay), slices: HOSTED.minSlices, sizeJitter: HOSTED_SIZE_JITTER });
  if (BigInt(perSwap) > largest) return refuse(`the per-swap limit must not exceed the largest slice of a ${HOSTED.minSlices}-slice order`);
  // The limits only bind the asset they name, so that asset is the one sold,
  // and the only other asset the wallet may spend is the one bought.
  const assets = policy.assets;
  if (!Array.isArray(assets) || assets.length !== 2 || assets[0] !== assetId || typeof assets[1] !== 'string' || !assets[1] || assets[1] === assetId) {
    return refuse("the wallet may spend only the order's two assets: the sold one, which the limits name, then the bought one");
  }
  const token = priceOf(assetId);
  if (!token || !(token.price > 0) || !Number.isInteger(token.decimals)) return refuse(`no price for ${assetId}`);
  if (!priceOf(assets[1])) return refuse(`no price for ${assets[1]}`);
  const usd = (Number(BigInt(perDay)) / 10 ** token.decimals) * token.price;
  if (usd > MAX_CHECKED_ORDER_USD) return refuse(`hosted orders are capped at $${HOSTED.maxOrderUsd}; this one is about $${usd.toFixed(2)}`);
  const expected = hostedPolicy({
    sellAssetId: assetId,
    buyAssetId: assets[1],
    perSwap,
    perDay,
    destinations: destinationsFor(...d.list),
    budgetUsd: Number(b.daily_usd),
    maxActionsPerHour: perHour,
  });
  return { ok: true, assetId, usd, expected };
}

/**
 * Checks an owner intent before the proxy generates it. Each allowed type is
 * pinned whole: the request must equal the intent rebuilt from its checked
 * values, so a field this file does not model (native signing, a schedule,
 * another limit window, an external user id) is refused rather than passed on.
 * @param {object} request the body of `POST /v1/generate-intent`
 * @param {{ priceOf: (assetId: string) => ({ price: number, decimals: number } | null), now?: number }} p
 */
export function checkHostedIntent(request, { priceOf, now = Date.now() }) {
  switch (isObject(request) ? request.type : undefined) {
    case 'agent_create': {
      const o = request.owner;
      if (!isObject(o) || o.type !== 'evm' || typeof o.address !== 'string' || !/^0x[0-9a-f]{40}$/.test(o.address) || typeof o.public_key !== 'string' || !/^0x[0-9a-f]{128}$/.test(o.public_key)) {
        return refuse('the owner is an EVM wallet with its public key, both in lowercase hex');
      }
      if (publicKeyToAddress(o.public_key) !== o.address) return refuse('the owner public key belongs to another address');
      if (!Number.isSafeInteger(o.chain_id) || o.chain_id < 1) return refuse('the owner names an EVM chain id');
      if (!isLabel(request.name)) return refuse('name the wallet in 64 characters or fewer');
      const verdict = checkPolicy(request.policy, priceOf);
      if (!verdict.ok) return verdict;
      const owner = { type: 'evm', address: o.address, chain_id: o.chain_id, public_key: o.public_key };
      return pinned(request, { type: 'agent_create', name: request.name, owner, policy: verdict.expected }) ?? { ok: true, assetId: verdict.assetId, usd: verdict.usd };
    }
    case 'grant_issue': {
      if (!isHex64(request.agent_id) || !isHex64(request.credential)) return refuse('a grant needs an agent id and a credential commitment');
      if (!isLabel(request.label)) return refuse('label the grant in 64 characters or fewer');
      // The exact form toISOString gives, so the API reads the same instant this check did.
      const expires = typeof request.expires_at === 'string' ? Date.parse(request.expires_at) : NaN;
      const exact = Number.isFinite(expires) && new Date(expires).toISOString() === request.expires_at;
      if (!exact || expires <= now || expires > now + HOSTED.maxGrantHours * 3_600_000 + 60_000) {
        return refuse(`a grant expires within ${HOSTED.maxGrantHours} hours`);
      }
      const { agent_id, label, credential, expires_at } = request;
      return pinned(request, { type: 'grant_issue', agent_id, label, credential, expires_at }) ?? { ok: true };
    }
    case 'agent_freeze':
    case 'agent_unfreeze':
      if (!isHex64(request.agent_id)) return refuse('freeze and unfreeze need an agent id');
      return pinned(request, { type: request.type, agent_id: request.agent_id }) ?? { ok: true };
    default:
      return refuse(`the site does not sign ${typeof request?.type === 'string' ? request.type.slice(0, 40) : 'these'} intents`);
  }
}
