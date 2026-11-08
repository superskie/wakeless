// Checks the page makes on what comes back through the site's proxy, before
// the owner's wallet signs anything and before any funds go in. Neither the
// proxy nor the Agent API is under the visitor's control, so every owner
// intent is compared with the request that asked for it, the applied policy
// with the policy the page built, and a deposit address with what 1Click
// itself says about it. Pure functions, so every refusal has a test.
import { canonicalAddress, checkAddress } from './hosted.mjs';
import { isEvmAddress } from '../evm.mjs';

/**
 * The EIP-712 domain of owner intents as the live API sends it: name and
 * version only, no chain id, so the wallet never asks to switch networks.
 * Recorded from a real generate-intent response; anything else is refused.
 */
export const OWNER_DOMAIN = Object.freeze({ name: 'NEAR Wallet Contract', version: '1' });

/** Every owner intent type the API knows (GenerateIntentResponse.type in the SDK). */
const OWNER_TYPES = ['agent_create', 'policy_update', 'agent_freeze', 'agent_unfreeze', 'grant_issue', 'grant_revoke', 'execution_cancel', 'agent_archive', 'agent_restore', 'agent_delete', 'approval_vote'];
/** The only ones the desk ever asks the owner to sign. */
const SIGNED_HERE = new Set(['agent_create', 'grant_issue', 'agent_freeze', 'agent_unfreeze']);

const POLICY_KEYS = new Set(['frozen', 'actions', 'confidential', 'owner_approval', 'assets', 'limits', 'max_actions_per_hour', 'destinations', 'budget', 'timelock_ms', 'schedule', 'native']);
const LIMIT_WINDOWS = ['per_transaction', 'hourly', 'daily', 'monthly'];

const refuse = (reason) => ({ ok: false, reason });
const lower = (v) => (typeof v === 'string' ? v.toLowerCase() : v);
const isEmpty = (v) => v == null || v === false || (Array.isArray(v) ? v.length === 0 : typeof v === 'object' && Object.keys(v).length === 0);
const sameSet = (a, b) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

function bigOrNull(v) {
  try {
    return v == null ? null : BigInt(v);
  } catch {
    return null;
  }
}

function sameAmounts(a, b) {
  const ka = Object.keys(a ?? {});
  if (!sameSet(ka, Object.keys(b ?? {}))) return false;
  return ka.every((k) => bigOrNull(a[k]) !== null && bigOrNull(a[k]) === bigOrNull(b[k]));
}

const usd = (v) => (v == null ? null : Number(v));

function destinationKey(d) {
  if (d?.action === 'transfer') return `transfer|${d.address}|${Boolean(d.confidential)}`;
  const address = typeof d?.address === 'string' && typeof d?.chain === 'string' ? canonicalAddress(d.chain, d.address) : d?.address;
  return `${d?.action}|${d?.chain}|${address}|${d?.memo ?? ''}`;
}

/** Does a policy's `native` block let the agent's own keys sign anything? Omitted or all off is no. */
export function nativePower(v) {
  if (v === true) return true;
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === 'object') return Object.values(v).some(nativePower);
  return false;
}

/**
 * Is `actual` the policy the page built? Equal forms are accepted (a budget
 * of "150" or "150.00", a missing `schedule` or an all-off `native`), and any
 * field this page does not know must be empty, so nothing new slips in.
 */
export function samePolicy(actual, built, { ignoreFrozen = false } = {}) {
  if (!actual || typeof actual !== 'object') return refuse('no policy');
  if (!ignoreFrozen && actual.frozen !== built.frozen) return refuse('the frozen flag differs');
  if (!Array.isArray(actual.actions) || !sameSet(actual.actions, built.actions)) return refuse('the allowed actions differ');
  if (actual.confidential !== built.confidential) return refuse('the confidential switch differs');
  if (actual.owner_approval !== built.owner_approval) return refuse('owner approval differs');
  const assetsOk = typeof built.assets === 'string' ? actual.assets === built.assets : Array.isArray(actual.assets) && sameSet(actual.assets, built.assets);
  if (!assetsOk) return refuse('the assets differ');
  for (const w of LIMIT_WINDOWS) if (!sameAmounts(actual.limits?.[w], built.limits?.[w])) return refuse(`the ${w} limits differ`);
  for (const k of Object.keys(actual.limits ?? {})) if (!LIMIT_WINDOWS.includes(k) && !isEmpty(actual.limits[k])) return refuse(`an unknown limit ${k}`);
  if ((actual.max_actions_per_hour ?? null) !== (built.max_actions_per_hour ?? null)) return refuse('the hourly action cap differs');
  const a = actual.destinations;
  const b = built.destinations;
  if (a?.mode !== b.mode || !Array.isArray(a.list) || !sameSet(a.list.map(destinationKey), b.list.map(destinationKey))) return refuse('the withdrawal destinations differ');
  for (const k of ['daily_usd', 'weekly_usd', 'monthly_usd']) if (usd(actual.budget?.[k]) !== usd(built.budget?.[k])) return refuse('the USD budget differs');
  if (Number(actual.timelock_ms ?? 0) !== Number(built.timelock_ms ?? 0)) return refuse('the timelock differs');
  const scheduleOk = built.schedule == null ? isEmpty(actual.schedule) : JSON.stringify(actual.schedule) === JSON.stringify(built.schedule);
  if (!scheduleOk) return refuse('the schedule differs');
  if (nativePower(actual.native) && JSON.stringify(actual.native) !== JSON.stringify(built.native)) return refuse('native signing is switched on');
  for (const k of Object.keys(actual)) if (!POLICY_KEYS.has(k) && !isEmpty(actual[k])) return refuse(`an unknown policy field ${k}`);
  return { ok: true };
}

/** Every key and value in a message, reading JSON text inside strings too, since a message may carry its fields as one JSON string. */
function collect(value, out = { pairs: [], strings: [], objects: [] }, depth = 0) {
  if (depth > 8 || out.pairs.length > 5_000) return out;
  if (typeof value === 'string') {
    out.strings.push(value);
    const t = value.trim();
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try {
        collect(JSON.parse(t), out, depth + 1);
      } catch {
        // plain text, already kept as a string
      }
    }
  } else if (typeof value === 'number') out.strings.push(String(value));
  else if (Array.isArray(value)) for (const v of value) collect(v, out, depth + 1);
  else if (value && typeof value === 'object') {
    out.objects.push(value);
    for (const [k, v] of Object.entries(value)) {
      out.pairs.push([k, v]);
      collect(v, out, depth + 1);
    }
  }
  return out;
}

const snake = (text) => String(text).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[\s-]+/g, '_');

/** The first other owner intent type a text names, so a freeze can not carry an unfreeze or a delete. */
function otherTypeNamed(texts, type) {
  for (const t of texts) {
    const s = snake(t);
    for (const other of OWNER_TYPES) if (other !== type && new RegExp(`(^|[^a-z])${other}($|[^a-z])`).test(s)) return other;
  }
  return null;
}

/** A time in ms from an ISO date or a number in seconds, ms, microseconds or nanoseconds. */
function toMs(v) {
  if (typeof v === 'string') {
    if (/^\d+$/.test(v)) return toMs(Number(v));
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  if (v > 1e17) return v / 1e6;
  if (v > 1e14) return v / 1e3;
  return v > 1e11 ? v : v * 1000;
}

function checkTypedData(payload) {
  if (!payload || typeof payload !== 'object') return 'no typed data';
  const d = payload.domain;
  if (!d || typeof d !== 'object' || Object.keys(d).sort().join(',') !== 'name,version' || d.name !== OWNER_DOMAIN.name || d.version !== OWNER_DOMAIN.version) {
    return 'an unexpected EIP-712 domain';
  }
  const declared = payload.types?.EIP712Domain;
  if (declared !== undefined && JSON.stringify(declared) !== JSON.stringify([{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }])) {
    return 'an unexpected EIP-712 domain type';
  }
  if (typeof payload.primaryType !== 'string' || payload.primaryType === 'EIP712Domain' || !Array.isArray(payload.types?.[payload.primaryType])) return 'no message type';
  if (!payload.message || typeof payload.message !== 'object') return 'no message';
  return null;
}

function checkOwners(facts, owner, publicKey) {
  for (const o of facts.objects) {
    if (typeof o.public_key !== 'string' || (o.type !== 'evm' && typeof o.address !== 'string')) continue;
    if (lower(o.address) !== owner) return 'another owner';
    if (publicKey && lower(o.public_key) !== lower(publicKey)) return "another owner's key";
  }
  return null;
}

function checkCreate(request, generated, facts) {
  const built = request.policy;
  // The preview and the message may each carry the policy; every copy found must be the one built here.
  const copies = facts.objects.filter((o) => 'destinations' in o && ('actions' in o || 'limits' in o));
  if (generated.preview?.policy !== undefined) copies.unshift(generated.preview.policy);
  if (!copies.length) return 'no policy to compare';
  for (const copy of copies) {
    const same = samePolicy(copy, built);
    if (!same.ok) return `a policy that is not the one built here: ${same.reason}`;
  }
  if (facts.pairs.some(([k, v]) => k === 'native' && nativePower(v))) return 'native signing switched on';
  const hash = lower(generated.preview?.policy_hash);
  if (hash && facts.pairs.some(([k, v]) => /policy_?hash/i.test(k) && typeof v === 'string' && lower(v) !== hash)) return 'a policy hash that is not the preview\'s';
  return null;
}

function checkGrant(request, facts) {
  const want = lower(request.credential);
  if (facts.pairs.some(([k, v]) => /credential/i.test(k) && typeof v === 'string' && lower(v) !== want)) return "a credential that is not this tab's";
  if (!facts.strings.some((s) => s.toLowerCase().includes(want))) return "not this tab's credential";
  const expires = Date.parse(request.expires_at);
  const times = facts.pairs.filter(([k]) => /expir|until|deadline/i.test(k)).map(([, v]) => toMs(v)).filter((t) => t != null);
  if (times.some((t) => t > expires + 60_000)) return 'a later expiry than this tab asked for';
  const carried = times.some((t) => Math.abs(t - expires) <= 2_000) || facts.strings.some((s) => s.includes(request.expires_at.slice(0, 19)) || s.includes(String(expires)));
  return carried ? null : 'not the expiry this tab asked for';
}

/**
 * Is the generated intent the one the page asked for, to be signed by `owner`?
 * Checks the type, the agent, the signer, the EIP-712 domain, that the
 * message names no other intent type, and per type: for `agent_create` the
 * policy (in the preview, and in the message wherever it carries one), for
 * `grant_issue` the credential commitment and the expiry.
 * @param {object} request the body sent to `POST /v1/generate-intent`
 * @param {object} generated its response
 * @param {{ owner: string }} p the owner's lowercase EVM address
 */
export function checkOwnerIntent(request, generated, { owner }) {
  const type = request?.type;
  if (!SIGNED_HERE.has(type)) return refuse(`the page does not sign ${type ?? 'these'} intents`);
  if (generated?.type !== type) return refuse(`the API answered with a ${generated?.type ?? 'missing'} intent instead of ${type}`);
  if (type !== 'agent_create' && generated.agent_id !== request.agent_id) return refuse('the intent is for another agent wallet');
  const signer = generated.signer;
  const publicKey = type === 'agent_create' ? request.owner?.public_key : null;
  if (signer?.type !== 'evm' || lower(signer.address) !== lower(owner)) return refuse('the intent is for another signer');
  if (publicKey && lower(signer.public_key) !== lower(publicKey)) return refuse("the intent names another owner's key");
  const intent = generated.intent;
  if (intent?.standard !== 'eip712') return refuse(`expected an EIP-712 intent, got ${intent?.standard}`);
  const shape = checkTypedData(intent.payload);
  if (shape) return refuse(`the typed data has ${shape}`);
  const facts = collect(intent.payload.message);
  const other = otherTypeNamed([intent.payload.primaryType, ...Object.keys(intent.payload.types), ...facts.strings, ...facts.pairs.map(([k]) => k)], type);
  if (other) return refuse(`the typed data is a ${other}, not a ${type}`);
  if (type !== 'agent_create' && facts.pairs.some(([k, v]) => /^agent_?id$/i.test(k) && v !== request.agent_id)) return refuse('the typed data names another agent wallet');
  const problem = checkOwners(facts, lower(owner), publicKey)
    ?? (type === 'agent_create' ? checkCreate(request, generated, facts) : type === 'grant_issue' ? checkGrant(request, facts) : null);
  if (problem) return refuse(`the typed data carries ${problem}`);
  return { ok: true, summary: typeof generated.preview?.summary === 'string' ? generated.preview.summary : null };
}

/** The policy read back after `agent_create`: applied, and exactly the one built. */
export function checkAppliedPolicy(view, built) {
  if (!view?.policy) return { ...refuse('the wallet has no applied policy yet'), pending: true };
  if (view.status && view.status !== 'APPLIED') return { ...refuse(`the policy is ${view.status}`), pending: view.status === 'SIGNED' };
  const same = samePolicy(view.policy, built, { ignoreFrozen: true });
  return same.ok ? { ok: true, frozen: Boolean(view.policy.frozen), revision: view.revision ?? null } : same;
}

/**
 * The policy of a wallet the page did not build in this browser (a loaded
 * file): it may only swap and withdraw, sign nothing natively, pay out only to
 * the two given addresses, and hold the sell asset to the order's limits.
 */
export function checkWalletPolicy(view, { assetId, perSwap, perDay, destinations, maxBudgetUsd }) {
  const p = view?.policy;
  if (!p) return { ...refuse('the wallet has no applied policy'), pending: true };
  if (!Array.isArray(p.actions) || p.actions.some((a) => a !== 'swap' && a !== 'withdraw')) return refuse('the wallet may do more than swap and withdraw');
  if (nativePower(p.native)) return refuse('native signing is switched on');
  const list = p.destinations?.list;
  if (p.destinations?.mode !== 'only' || !Array.isArray(list) || !sameSet(list.map(destinationKey), destinations.map(destinationKey))) {
    return refuse('withdrawals may go elsewhere than the two addresses');
  }
  const per = bigOrNull(p.limits?.per_transaction?.[assetId]);
  const day = bigOrNull(p.limits?.daily?.[assetId]);
  if (per === null || day === null || per !== BigInt(perSwap) || day !== BigInt(perDay)) return refuse("the sell limits are not this order's");
  if (!(Number(p.budget?.daily_usd) <= maxBudgetUsd)) return refuse('the daily budget is above the hosted one');
  return { ok: true, frozen: Boolean(p.frozen), revision: view.revision ?? null };
}

/** Do the Agent API and 1Click describe the same token? Every amount the page signs uses its decimals. */
export function checkToken(agentToken, oneClickToken) {
  if (!oneClickToken) return refuse(`${agentToken.symbol} is not in the 1Click token list`);
  if (oneClickToken.assetId !== agentToken.assetId || oneClickToken.decimals !== agentToken.decimals || oneClickToken.blockchain !== agentToken.blockchain) {
    return refuse(`the Agent API and 1Click disagree about ${agentToken.symbol}`);
  }
  return { ok: true };
}

/**
 * Does the Agent API's deposit answer fit the request: an address on the sold
 * asset's chain, crediting this agent's account, for this asset and amount, in
 * confidential form? 1Click's keyless `GET /v0/status` does not know these
 * addresses (it answers 404 for them), so no second source can confirm the
 * address itself; this catches an answer that does not belong to the request.
 */
export function checkDepositAnswer(details, { chain, assetId, amount, nearAccount }) {
  const d = details ?? {};
  if (typeof d.deposit_address !== 'string' || !checkAddress(chain, d.deposit_address).ok) return refuse('the deposit address is not an address on the sold asset\'s chain');
  if (!nearAccount || d.near_account_id !== nearAccount) return refuse('the deposit does not credit this agent wallet');
  if (d.refund_to != null && d.refund_to !== nearAccount) return refuse('a failed deposit would be refunded elsewhere');
  if (String(d.amount ?? d.min_amount) !== String(amount)) return refuse('the deposit is for another amount');
  if (String(d.confidential) !== 'true') return refuse('the deposit is not confidential');
  let asked = null;
  try {
    asked = typeof d.request === 'string' ? JSON.parse(d.request) : d.request ?? null;
  } catch {
    asked = null;
  }
  if (asked && asked.origin_asset !== assetId) return refuse('the deposit is for another asset');
  return { ok: true };
}

/**
 * A saved wallet-details file, read as a pointer: the agent id, the owner and
 * the order it was made for. Everything else in it is ignored; the page reads
 * the wallet itself from the Agent API and checks it against these.
 */
export function parseWalletFile(text) {
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    return refuse('it is not JSON');
  }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return refuse('it is not a details file');
  if (typeof d.agent_id !== 'string' || !/^[0-9a-f]{64}$/.test(d.agent_id)) return refuse('it has no agent id');
  if (!isEvmAddress(d.owner)) return refuse('it has no owner address');
  const where = {};
  for (const [name, label] of [['receive', 'receive'], ['refund', 'return']]) {
    const a = d[name];
    if (!a || typeof a.chain !== 'string' || typeof a.address !== 'string') return refuse(`it has no ${label} address`);
    const c = checkAddress(a.chain, a.address);
    if (!c.ok) return refuse(`the ${label} address: ${c.reason}`);
    where[name] = { chain: a.chain, address: canonicalAddress(a.chain, a.address) };
  }
  const o = d.order;
  const amount = typeof o?.amount === 'number' ? String(o.amount) : o?.amount;
  const ok = o && typeof o === 'object' && typeof o.sell === 'string' && typeof o.buy === 'string' && typeof amount === 'string' && /^\d{1,30}(\.\d{1,30})?$/.test(amount)
    && Number.isInteger(o.slices) && o.slices >= 2 && o.slices <= 64 && Number.isFinite(o.horizonMinutes) && o.horizonMinutes > 0 && o.horizonMinutes <= 24 * 60
    && Number.isFinite(o.maxAdverseBps) && o.maxAdverseBps >= 0 && o.maxAdverseBps <= 2_000;
  if (!ok) return refuse('it has no valid order');
  return {
    ok: true,
    agentId: d.agent_id,
    owner: d.owner.toLowerCase(),
    receive: where.receive,
    refund: where.refund,
    spec: { sell: o.sell, buy: o.buy, amount, slices: o.slices, horizonMinutes: o.horizonMinutes, maxAdverseBps: o.maxAdverseBps },
  };
}
