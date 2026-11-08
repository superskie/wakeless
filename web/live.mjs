// Live mode of the web desk. The visitor's own wallet owns a NEAR Intents
// agent wallet that can only swap within the order's slice cap and withdraw to
// the addresses the visitor named. Funds go in by a plain transfer to the
// agent's confidential deposit address, and this tab works the slices with
// the same engine, executor and quote client as the command line.
//
// Nothing that comes back through the site's proxy is taken on trust: every
// owner intent is checked against the request before the wallet sees it, the
// wallet's rules are read back before any deposit address is shown, and the
// deposit address is confirmed with 1Click itself (src/agent/verify.mjs).
//
// Kept in localStorage: the agent id, the owner's address, the order, the two
// addresses, the signed policy and the deposit with any transfer sent to it.
// None of them can move funds, but the agent id lets anyone read the wallet
// through the site, so the details file is private. The grant token lives
// only in memory: after a reload the owner signs a new grant.
import { agentHttp, runOwnerIntent } from '../src/agent/http.mjs';
import { createGrantCredential } from '../src/agent/grant.mjs';
import { HOSTED, RECEIVE_CHAINS, canonicalAddress, checkAddress, destinationsFor, hostedPolicy, isEvmChain } from '../src/agent/hosted.mjs';
import { capFor, checkSliceCap } from '../src/agent/cap.mjs';
import { agentQuoteClient, priceBook } from '../src/agent/quotes.mjs';
import { checkAppliedPolicy, checkDepositAnswer, checkToken, checkWalletPolicy, parseWalletFile } from '../src/agent/verify.mjs';
import { agentExecutor } from '../src/executors/agent.mjs';
import { waitForStatus } from '../src/agent/status.mjs';
import { prepareOrder } from '../src/order.mjs';
import { scheduleFor } from '../src/engine.mjs';
import { largestPossibleSlice } from '../src/schedule.mjs';
import { mulberry32 } from '../src/rng.mjs';
import { fromUnits, toNumber } from '../src/units.mjs';
import { publicKeyToAddress, recoverPersonalSigner } from '../src/evm.mjs';
import { EVM_CHAIN, discoverWallets, wallet, walletMessage } from './wallet.mjs';

const STORE = 'wakeless.live.v1';
/** Every agent id this browser made or loaded, never pruned, so a replaced wallet can still be found. */
const AGENTS = 'wakeless.live.agents.v1';
const ONE_CLICK = 'https://1click.chaindefuser.com';
const CHAIN_NAME = { eth: 'Ethereum', arb: 'Arbitrum', base: 'Base', op: 'Optimism', pol: 'Polygon', bsc: 'BNB Chain', avax: 'Avalanche', sol: 'Solana', near: 'NEAR' };
export const LIVE_ASSETS = ['eth:base', 'usdc:base', 'eth:arb', 'usdc:arb', 'eth:eth', 'usdc:eth', 'sol:sol', 'usdc:sol', 'wnear:near'];

/** Window codes: the wallet would let the withdrawal through later, so a return stops politely instead of failing. */
const HELD_CODES = new Set(['policy_limit_exceeded', 'spend_budget_exceeded', 'policy_action_limit_exceeded']);
const DEPOSIT_TEXT = {
  PENDING_DEPOSIT: 'Waiting for the transfer to arrive.',
  KNOWN_DEPOSIT_TX: 'Transfer seen; settling.',
  PROCESSING: 'Transfer seen; settling.',
  QUEUED: 'Transfer seen; settling.',
  INCOMPLETE_DEPOSIT: 'Less than the amount has arrived so far.',
  SUCCESS: 'The deposit has arrived.',
  FAILED: 'The deposit failed; anything sent is refunded into the agent wallet.',
  REFUNDED: 'The deposit was refunded into the agent wallet.',
};
const DEPOSIT_FINAL = new Set(['SUCCESS', 'FAILED', 'REFUNDED']);

const $ = (selector) => document.querySelector(selector);
const short = (a) => (a && a.length > 14 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a ?? '');
const chainName = (c) => CHAIN_NAME[c] ?? c;
const newSeed = () => crypto.getRandomValues(new Uint32Array(1))[0] >>> 1;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isoSeconds = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString();
const utcTime = (iso) => (iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : '-');
const pick = (t) => ({ assetId: t.assetId, symbol: t.symbol, blockchain: t.blockchain, decimals: t.decimals });
const evmOnNear = (chain, value) => chain === 'near' && /^0x/i.test(value);
const grantHours = (minutes) => Math.min(HOSTED.maxGrantHours, Math.max(1, Math.ceil(Number(minutes ?? 30) / 60) + 1));

function bigOrNull(v) {
  try {
    return v == null ? null : BigInt(v);
  } catch {
    return null;
  }
}

function txLink(chain, hash) {
  if (!hash) return null;
  if (EVM_CHAIN[chain]) return `${EVM_CHAIN[chain].explorer}/tx/${hash}`;
  if (chain === 'sol') return `https://solscan.io/tx/${hash}`;
  if (chain === 'near') return `https://nearblocks.io/txns/${hash}`;
  return null;
}

function node(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') el.textContent = v;
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c != null) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

function loadSaved() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE));
    return s && typeof s.agentId === 'string' && typeof s.owner?.address === 'string' ? s : null;
  } catch {
    return null;
  }
}

/** The order a hosted run uses, from the ticket's fields. */
export function liveSpec(ticket, deskAccount) {
  return {
    id: `web-live-${Date.now().toString(36)}`,
    sell: ticket.sell,
    buy: ticket.buy,
    amount: ticket.amount,
    slices: ticket.slices,
    horizonMinutes: ticket.horizonMinutes,
    maxAdverseBps: ticket.maxAdverseBps,
    maxDefers: 2,
    minSliceUsd: 0.5,
    deskAccount: deskAccount ?? 'dry-run.wakeless.near',
  };
}

/** prepareOrder, except that a missing USD price only drops the dust guard: what a wallet holds never depends on a price. */
function resolveOrder(spec, tokens) {
  try {
    return prepareOrder(spec, tokens);
  } catch (err) {
    if (!/no USD price/.test(err.message)) throw err;
    return prepareOrder({ ...spec, minSliceUsd: 0 }, tokens);
  }
}

/**
 * Parts of at most `perTx` each, as equal as possible: the Agent API applies a
 * per-asset per-transaction limit to withdrawals too, so a return of more than
 * one slice must go out in several.
 */
export function planChunks(amount, perTx) {
  if (amount <= 0n) return [];
  if (perTx == null || perTx <= 0n || amount <= perTx) return [amount];
  const n = (amount + perTx - 1n) / perTx;
  const base = amount / n;
  const extra = amount % n;
  return Array.from({ length: Number(n) }, (_, i) => base + (BigInt(i) < extra ? 1n : 0n));
}

/**
 * The order a funded wallet can still work: its live balance, at most the
 * signed daily limit, in slices that each fit the signed per-swap cap. A first
 * run of a fully funded wallet is the saved order itself.
 */
export function planRemainder({ spec, tokens, balance, perSwap, perDay, deskAccount }) {
  const full = resolveOrder(liveSpec(spec, deskAccount), tokens);
  const amount = balance < perDay ? balance : perDay;
  if (amount <= 0n || perSwap <= 0n) return null;
  if (amount === full.totalUnits) return full;
  const ratio = Number(amount) / Number(full.totalUnits);
  for (let slices = Math.max(HOSTED.minSlices, Math.ceil(spec.slices * ratio)); slices <= HOSTED.maxSlices; slices++) {
    if (largestPossibleSlice({ total: amount, slices, sizeJitter: full.sizeJitter }) > perSwap) continue;
    const horizonMinutes = Math.max(1, Math.round((spec.horizonMinutes * slices) / spec.slices));
    return resolveOrder({ ...liveSpec(spec, deskAccount), amount: fromUnits(amount, full.sell.decimals), slices, horizonMinutes }, tokens);
  }
  return null;
}

class StoppedError extends Error {
  constructor() {
    super('Stopped before the next slice.');
    this.name = 'StoppedError';
  }
}

/**
 * @param {object} p
 * @param {() => object} p.ticket the ticket's current order fields
 * @param {(assetId: string) => string | null | undefined} p.contractOf EVM token contract, null for a native coin, undefined when not in the 1Click list
 * @param {(spec: object | null) => void} p.lockTicket
 * @param {(run: object) => Promise<object[]>} p.workOrder runs the engine in the desk's monitor
 * @param {() => object[] | null} [p.oneClickTokens] the 1Click token list the desk already holds; fetched here when missing
 */
export function createLive({ ticket, contractOf, lockTicket, workOrder, oneClickTokens }) {
  const api = agentHttp();
  const prices = priceBook(api, { ttlMs: 60_000 });
  const mem = {
    w: null,
    account: null,
    off: null,
    grant: null,
    busy: false,
    connecting: false,
    freezing: false,
    running: false,
    stop: false,
    balances: null,
    publicBalances: null,
    tokens: null,
    oneClick: null,
    wallets: [],
    policyView: null,
    policyCheck: null,
    depositCheck: null,
    depositStatus: null,
    autofill: { receive: null, refund: null },
    lastRun: null,
    pollTimer: null,
  };
  let saved = loadSaved();

  const store = () => (saved ? localStorage.setItem(STORE, JSON.stringify(saved)) : localStorage.removeItem(STORE));
  const setError = (text) => {
    $('#live-error').textContent = text ?? '';
  };
  const owner = () => saved?.owner?.address ?? null;
  const isOwner = () => Boolean(mem.w && saved?.owner && mem.account === saved.owner.address);
  const grantValid = (aheadMs = 0) => Boolean(mem.grant && Date.parse(mem.grant.expiresAt) > Date.now() + aheadMs);

  function remember(how) {
    try {
      const list = JSON.parse(localStorage.getItem(AGENTS) ?? '[]');
      const all = Array.isArray(list) ? list : [];
      if (!all.some((e) => e?.agentId === saved.agentId)) all.push({ agentId: saved.agentId, owner: saved.owner.address, at: new Date().toISOString(), how });
      localStorage.setItem(AGENTS, JSON.stringify(all));
    } catch {
      // a full or blocked storage still keeps the current wallet
    }
  }
  if (saved) remember('saved');

  /** The ticket's order before a wallet exists, checked against the hosted cap at today's price. */
  function ticketOrder() {
    if (!mem.tokens) return { error: 'Loading the Agent API token list.' };
    const spec = liveSpec(ticket());
    let order;
    try {
      order = prepareOrder(spec, mem.tokens);
    } catch (err) {
      return { error: err.message };
    }
    if (!(order.sell.price > 0)) return { error: `No USD price for ${order.sell.symbol} right now.` };
    const usd = toNumber(order.totalUnits, order.sell.decimals) * order.sell.price;
    if (usd > HOSTED.maxOrderUsd) return { error: `Live orders are capped at $${HOSTED.maxOrderUsd}; this one is about $${usd.toFixed(2)}.` };
    if (order.slices < HOSTED.minSlices) return { error: 'A live order needs at least 2 slices.' };
    if (!RECEIVE_CHAINS.has(order.buy.blockchain)) return { error: `Withdrawals to ${chainName(order.buy.blockchain)} are not supported.` };
    try {
      return { order, spec, usd, cap: capFor(order) };
    } catch (err) {
      return { error: err.message };
    }
  }

  /** The saved order once the wallet exists: no price and no cap check, since its signed rules already fix it. */
  function walletOrder() {
    if (!mem.tokens) return { error: 'Loading the Agent API token list.' };
    try {
      const order = resolveOrder(liveSpec(saved.spec), mem.tokens);
      return { order, cap: capFor(order) };
    } catch (err) {
      return { error: err.message };
    }
  }

  /** The wallet's two assets, resolved once and kept, so the exits work even without a token list. */
  function walletAssets() {
    if (!saved.assets) {
      const w = walletOrder();
      if (!w.order) return null;
      saved.assets = { sell: pick(w.order.sell), buy: pick(w.order.buy) };
      store();
    }
    return saved.assets;
  }

  function holdings(assets, list = mem.balances) {
    const out = { buy: 0n, sell: 0n };
    if (!list || !assets) return out;
    for (const b of list) {
      const v = bigOrNull(b.available_raw ?? b.balance_raw) ?? 0n;
      if (b.asset_id === assets.buy.assetId) out.buy = v;
      if (b.asset_id === assets.sell.assetId) out.sell = v;
    }
    return out;
  }

  /** Funding is still owed: less than the order is in, and nothing has been worked or bought yet. */
  function owesFunding(assets) {
    const w = walletOrder();
    if (!w.order || !mem.balances) return false;
    const h = holdings(assets);
    return h.sell < w.order.totalUnits && h.buy === 0n && !saved.runs;
  }

  // ---------- rendering ----------

  function renderWhere(buy, sell, made) {
    const receive = $('#live-receive');
    const refund = $('#live-refund');
    if (buy) $('#live-receive-label').textContent = `Receive ${buy.symbol} on ${chainName(buy.blockchain)} at`;
    if (sell) $('#live-refund-label').textContent = `Send anything unsold, ${sell.symbol} on ${chainName(sell.blockchain)}, back to`;
    if (made) {
      receive.value = saved.receive.address;
      refund.value = saved.refund?.address ?? '';
    } else {
      autofill(receive, 'receive', buy?.blockchain);
      autofill(refund, 'refund', sell?.blockchain);
    }
    receive.disabled = made;
    refund.disabled = made;
    const check = (input, chain) => (!chain ? { ok: false, reason: '' } : input.value.trim() ? checkAddress(chain, input.value.trim()) : { ok: false, reason: '' });
    const rc = check(receive, buy?.blockchain);
    const fc = check(refund, sell?.blockchain);
    const nearNote = 'An 0x name on NEAR is an account only an EVM wallet can use. Make sure that is what you want.';
    $('#live-receive-hint').textContent = !rc.ok ? rc.reason : evmOnNear(buy.blockchain, receive.value.trim()) ? nearNote : 'The only place the bought asset can go. Check it against your wallet popup.';
    $('#live-refund-hint').textContent = !fc.ok ? fc.reason : evmOnNear(sell.blockchain, refund.value.trim()) ? nearNote : 'Used only if a slice can not fill. It may be another wallet than the one that pays in.';
    $('#ls-where').dataset.state = made || (rc.ok && fc.ok) ? 'done' : 'todo';
    return { rc, fc };
  }

  /** Fill in the connected account on EVM chains, and take it back out when the chain or the account changes. */
  function autofill(input, key, chain) {
    const filled = mem.autofill[key];
    if (filled && input.value === filled.value && (filled.chain !== chain || filled.value !== mem.account)) {
      input.value = '';
      mem.autofill[key] = null;
    }
    if (!input.value && mem.account && chain && isEvmChain(chain)) {
      input.value = mem.account;
      mem.autofill[key] = { chain, value: mem.account };
    }
  }

  function ruleLines(cap, sell, spec) {
    const u = (v) => `${fromUnits(v, sell.decimals)} ${sell.symbol}`;
    const about = (v) => `${Number(toNumber(v, sell.decimals).toPrecision(4))} ${sell.symbol}`;
    return [
      node('li', { text: `Swaps only, never more than about ${about(cap.perSwap)} at once (the largest slice this order can draw) and ${u(cap.perDay)} a day.` }),
      node('li', { text: `Withdrawals only to the two addresses above. Every swap in confidential form, a $${HOSTED.budgetUsd} daily budget.` }),
      node('li', { text: `This tab may trade for ${grantHours(spec.horizonMinutes)} hours. Your wallet can freeze it at any time.` }),
    ];
  }

  function policyLine() {
    const c = mem.policyCheck;
    if (!c) return node('li', { text: "Reading the wallet's rules back from the Agent API." });
    if (c.ok) return node('li', { text: 'Read back from the wallet itself: these are the rules it holds.' });
    if (c.pending) return node('li', { text: `Waiting for the wallet's rules: ${c.reason}.` });
    return node('li', { class: 'bad', text: `The wallet's rules are not the ones signed here (${c.reason}). Do not fund it.` });
  }

  function render() {
    const panel = $('#live');
    if (panel.hidden) return;
    const made = Boolean(saved?.agentId);
    const t = made ? null : ticketOrder();
    const w = made ? walletOrder() : null;
    const assets = made ? walletAssets() : null;
    const sell = assets?.sell ?? t?.order?.sell;
    const buy = assets?.buy ?? t?.order?.buy;
    const ownerNow = isOwner();
    const frozen = Boolean(saved?.frozen);
    const policyOk = Boolean(mem.policyCheck?.ok);
    const hold = holdings(assets);

    // 1. wallet
    $('#ls-wallet').dataset.state = mem.account ? 'done' : 'todo';
    $('#live-account').textContent = !mem.account
      ? made ? `Owner ${short(owner())}. Connect it to continue.` : 'Any EVM wallet. It signs the rules and pays no gas.'
      : made && !ownerNow ? `${short(mem.account)} connected, not the owner ${short(owner())}. Switch accounts in the wallet to sign.` : `${short(mem.account)} connected`;
    $('#live-connect').textContent = mem.account ? 'Switch wallet' : 'Connect wallet';
    $('#live-connect').disabled = mem.connecting;

    // 2. where the funds go
    const { rc, fc } = renderWhere(buy, sell, made);

    // 3. the agent wallet and its rules
    const rules = $('#live-rules');
    rules.textContent = '';
    const error = made ? w.error : t.error;
    if (error) rules.append(node('li', { class: 'bad', text: error }));
    else rules.append(...ruleLines(made ? w.cap : t.cap, sell, made ? saved.spec : t.spec));
    if (made) rules.append(policyLine());
    $('#ls-create').dataset.state = made ? 'done' : 'todo';
    $('#live-create').hidden = made;
    $('#live-create').disabled = mem.busy || !mem.account || !rc.ok || !fc.ok || Boolean(t?.error);
    $('#live-made').hidden = !made;
    if (made) {
      const grant = grantValid() ? ` This tab may trade until ${utcTime(mem.grant.expiresAt).slice(11)}.` : ' This tab has no grant: sign one to trade or withdraw.';
      const who = mem.account && !ownerNow ? ` Grants need the owner account ${short(owner())}.` : '';
      $('#live-made').textContent = `Agent wallet ${short(saved.agentId)}, owned by ${short(owner())}.${grant}${who}`;
    }
    $('#live-regrant').hidden = !made || !mem.account || grantValid(10 * 60_000);
    $('#live-regrant').disabled = mem.busy || !ownerNow;

    // 4. funding
    renderFunding(made && policyOk && Boolean(assets), assets, hold);

    // 5. run
    const ready = made && policyOk && !frozen && hold.sell > 0n;
    $('#ls-run').dataset.state = mem.running ? 'todo' : !ready ? (saved?.runs && hold.sell === 0n ? 'done' : 'off') : 'todo';
    $('#live-run').disabled = !ready || mem.busy || mem.running || (!grantValid() && !ownerNow);
    $('#live-stop').hidden = !mem.running;
    $('#live-stop').disabled = mem.stop;
    $('#live-stop').textContent = mem.stop ? 'Stopping' : 'Stop';
    $('#live-run-hint').textContent = runHint({ made, ready, frozen, policyOk, assets, hold, ownerNow });

    // 6. out
    renderOut(made, assets, hold, frozen);

    // footer
    $('#live-freeze').hidden = !made;
    $('#live-freeze').disabled = mem.freezing || !ownerNow;
    $('#live-freeze').textContent = mem.freezing ? 'Waiting for the wallet' : frozen ? 'Unfreeze the wallet' : 'Freeze the wallet';
    $('#live-foot-hint').textContent = made && !ownerNow ? `Freeze needs the owner wallet, ${short(owner())}, connected.` : '';
    $('#live-save').hidden = !made;
    $('#live-forget').hidden = !made;
    lockTicket(made ? saved.spec : null);
  }

  function runHint({ made, ready, frozen, policyOk, assets, hold, ownerNow }) {
    if (mem.running) return mem.stop ? 'Stopping: no new slice starts.' : 'Working. Stop ends the run before the next slice; Freeze also stops the wallet itself.';
    const last = mem.lastRun ? `${mem.lastRun} ` : '';
    if (!made) return 'Opens once the wallet is funded.';
    if (frozen) return `${last}Frozen: the wallet runs no swap and no withdrawal until you unfreeze it.`;
    if (!policyOk) return "Opens once the wallet's rules are confirmed.";
    if (!ready) return hold.buy > 0n ? `${last}Nothing left to sell. Withdraw the result below.` : saved.deposit?.sent ? 'Opens once the deposit has arrived.' : 'Opens once the wallet is funded.';
    if (!grantValid() && !ownerNow) return `${last}Connect the owner wallet: it signs a grant for this tab first.`;
    const plan = planFor(assets, hold.sell);
    const what = plan ? `Works ${fromUnits(plan.totalUnits, assets.sell.decimals)} ${assets.sell.symbol} in ${plan.slices} slices, in real time over about ${Math.round(plan.horizonMs / 60_000)} minutes.` : 'Works what the wallet holds.';
    const grant = grantValid(plan ? plan.horizonMs + 10 * 60_000 : 0) ? '' : ' Your wallet first signs a grant that lasts the run.';
    return `${last}${what}${grant} Keep this tab open; if it closes, the rest waits in the agent wallet.`;
  }

  function planFor(assets, balance) {
    const limits = mem.policyView?.policy?.limits;
    const perSwap = bigOrNull(limits?.per_transaction?.[assets.sell.assetId]);
    const perDay = bigOrNull(limits?.daily?.[assets.sell.assetId]);
    if (!mem.tokens || !perSwap || !perDay) return null;
    try {
      return planRemainder({ spec: saved.spec, tokens: mem.tokens, balance, perSwap, perDay });
    } catch {
      return null;
    }
  }

  function renderFunding(fundOn, assets, hold) {
    const w = fundOn ? walletOrder() : null;
    const funded = fundOn && Boolean(w?.order) && (hold.sell >= w.order.totalUnits || hold.buy > 0n || Boolean(saved.runs));
    $('#ls-fund').dataset.state = !fundOn ? 'off' : funded ? 'done' : 'todo';
    $('#live-fund').hidden = !fundOn;
    if (!fundOn) {
      for (const id of ['#live-send-wallet', '#live-send-again', '#live-get-deposit', '#live-copy']) $(id).hidden = true;
      $('#live-deposit').textContent = '';
      return;
    }
    const dep = saved.deposit;
    const check = mem.depositCheck;
    const expired = Boolean(dep?.expiresAt && Date.parse(dep.expiresAt) < Date.now());
    const show = Boolean(dep && check?.ok && !funded && !expired);
    const owes = owesFunding(assets);
    let text = '';
    if (funded) text = '';
    else if (!dep) text = owes ? 'No deposit address yet.' : '';
    else if (expired) text = 'This deposit address has expired. Get a new one before sending anything.';
    else if (!check || (!check.ok && check.retry)) text = 'Checking the deposit address.';
    else if (!check.ok) text = `This deposit address is not checked (${check.reason}). Get a new one before sending anything.`;
    else text = `Send exactly ${fromUnits(BigInt(dep.amount), assets.sell.decimals)} ${assets.sell.symbol} on ${chainName(assets.sell.blockchain)}, from any wallet or exchange, to:`;
    $('#live-send').textContent = text;
    $('#live-deposit').textContent = show ? dep.address : '';
    $('#live-memo').textContent = show && dep.memo ? `With this memo, or the deposit is lost: ${dep.memo}` : '';
    $('#live-copy').hidden = !show;
    const canSend = show && !dep.memo && mem.account && isEvmChain(assets.sell.blockchain) && EVM_CHAIN[assets.sell.blockchain] && contractOf(assets.sell.assetId) !== undefined;
    $('#live-send-wallet').hidden = !canSend || Boolean(dep.sent);
    $('#live-send-again').hidden = !canSend || !dep.sent;
    for (const id of ['#live-send-wallet', '#live-send-again']) $(id).disabled = mem.busy;
    const ended = mem.depositStatus === 'FAILED' || mem.depositStatus === 'REFUNDED';
    const retry = !funded && owes && (!dep || expired || ended || (check && !check.ok && !check.retry));
    $('#live-get-deposit').hidden = !retry;
    $('#live-get-deposit').disabled = mem.busy;
    $('#live-get-deposit').textContent = dep ? 'Get a new deposit address' : 'Get the deposit address';

    const sent = $('#live-sent');
    sent.textContent = '';
    if (dep?.sent && !funded) {
      const link = txLink(assets.sell.blockchain, dep.sent.txHash);
      sent.append('Sent: ', link ? node('a', { href: link, target: '_blank', rel: 'noopener', text: short(dep.sent.txHash) }) : short(dep.sent.txHash), '. ');
    }
    if (dep && !funded && mem.depositStatus) sent.append(DEPOSIT_TEXT[mem.depositStatus] ?? `Deposit status: ${mem.depositStatus}.`);
    $('#live-balance').textContent = balanceLine(assets, hold, w, dep);
    $('#live-public').textContent = publicLine(assets);
  }

  function balanceLine(assets, hold, w, dep) {
    if (!mem.balances) return 'Reading the agent wallet balance.';
    const u = (v) => `${fromUnits(v, assets.sell.decimals)} ${assets.sell.symbol}`;
    if (hold.buy > 0n || saved.runs) return `The wallet holds ${u(hold.sell)} unsold.`;
    if (w?.order && hold.sell >= w.order.totalUnits) return `Funded: ${u(hold.sell)} in confidential form.`;
    if (!dep || !w?.order) return hold.sell > 0n ? `The wallet holds ${u(hold.sell)}.` : '';
    return `Arrived so far: ${u(hold.sell)} of ${u(w.order.totalUnits)}. The address stays valid until ${utcTime(dep.expiresAt)}.`;
  }

  function publicLine(assets) {
    const parts = [];
    for (const t of [assets.sell, assets.buy]) {
      const v = holdings({ sell: t, buy: t }, mem.publicBalances ?? []).sell;
      if (v > 0n) parts.push(`${fromUnits(v, t.decimals)} ${t.symbol}`);
    }
    if (!parts.length) return '';
    return `The agent wallet also holds ${parts.join(' and ')} in public form, where a failed or late deposit is refunded. This site moves only the confidential balance, so that part stays in the wallet for now.`;
  }

  function renderOut(made, assets, hold, frozen) {
    const anything = hold.buy > 0n || hold.sell > 0n;
    $('#ls-out').dataset.state = !made ? 'off' : anything ? 'todo' : saved.runs ? 'done' : 'off';
    const withdraw = $('#live-withdraw');
    const back = $('#live-return');
    withdraw.hidden = !(hold.buy > 0n);
    back.hidden = !(hold.sell > 0n) || !saved?.refund;
    if (hold.buy > 0n) withdraw.textContent = `Withdraw ${fromUnits(hold.buy, assets.buy.decimals)} ${assets.buy.symbol} to ${short(saved.receive.address)}`;
    if (hold.sell > 0n) {
      const perTx = bigOrNull(mem.policyView?.policy?.limits?.per_transaction?.[assets.sell.assetId]);
      const parts = planChunks(hold.sell, perTx).length;
      back.textContent = `Return ${fromUnits(hold.sell, assets.sell.decimals)} ${assets.sell.symbol} to ${short(saved.refund?.address)}${parts > 1 ? ` in ${parts} parts` : ''}`;
    }
    for (const b of [withdraw, back]) b.disabled = mem.busy || mem.running || !grantValid() || frozen;
    $('#live-out-hint').textContent = !anything || mem.busy || mem.running ? '' : frozen ? 'Unfreeze the wallet to take funds out.' : !grantValid() ? 'Withdrawals need a grant for this tab: sign one above.' : '';
  }

  // ---------- actions ----------

  /** Money and creation steps, one at a time. Freeze, Stop and Connect stay outside this lock. */
  async function act(fn) {
    if (mem.busy) return;
    mem.busy = true;
    setError('');
    render();
    try {
      await fn();
    } catch (err) {
      setError(walletMessage(err));
    } finally {
      mem.busy = false;
      render();
    }
  }

  async function chooseWallet() {
    mem.wallets = await discoverWallets();
    const list = $('#live-wallets');
    list.textContent = '';
    if (!mem.wallets.length) {
      throw new Error('No browser wallet found. Install one (MetaMask, Rabby, Coinbase Wallet), or open this page in a wallet app.');
    }
    if (mem.wallets.length === 1) return mem.wallets[0];
    return new Promise((resolve) => {
      for (const entry of mem.wallets) {
        const btn = node('button', { class: 'btn ghost small', type: 'button' }, [entry.info.icon ? node('img', { src: entry.info.icon, alt: '', width: '16', height: '16' }) : null, entry.info.name]);
        btn.addEventListener('click', () => {
          list.textContent = '';
          resolve(entry);
        });
        list.append(btn);
      }
    });
  }

  async function connect() {
    if (mem.connecting) return;
    mem.connecting = true;
    setError('');
    render();
    try {
      const entry = await chooseWallet();
      const w = wallet(entry.provider);
      const account = await w.connect();
      if (saved?.owner && saved.owner.address !== account) {
        throw new Error(`This order's agent wallet is owned by ${short(saved.owner.address)}. Switch to that account in the wallet.`);
      }
      mem.off?.();
      mem.w = w;
      mem.account = account;
      mem.off = w.on('accountsChanged', (accounts) => {
        if (mem.w !== w) return;
        mem.account = accounts?.[0]?.toLowerCase() ?? null;
        render();
      });
    } catch (err) {
      setError(walletMessage(err));
    } finally {
      mem.connecting = false;
      render();
    }
  }

  /** Every signature is made as one pinned account; a wallet that switched accounts midway stops the step. */
  async function assertAccount(address) {
    const active = mem.w ? ((await mem.w.accounts().catch(() => null))?.[0] ?? mem.account) : null;
    if (!mem.w || !address || active !== address || mem.account !== address) {
      throw new Error(`The wallet is on ${short(active ?? mem.account) || 'no account'}, not ${short(address) || 'the owner'}. Switch back and try again; nothing was signed.`);
    }
  }

  const signAs = (address) => async (payload) => {
    await assertAccount(address);
    return mem.w.signTypedData(address, payload);
  };

  const showSummary = (_generated, summary) => {
    $('#live-summary').textContent = summary ?? '';
  };

  function signStep(i, text, state) {
    const list = $('#live-sigs');
    let li = list.children[i];
    if (!li) li = list.appendChild(node('li'));
    li.textContent = text;
    li.dataset.state = state;
  }

  async function oneClickList() {
    const given = oneClickTokens?.();
    if (Array.isArray(given) && given.length) return given;
    if (!mem.oneClick) {
      let res;
      try {
        res = await fetch(`${ONE_CLICK}/v0/tokens`, { cache: 'no-store', credentials: 'omit' });
      } catch {
        throw new Error('1Click is not reachable to check the token list. Try again in a moment.');
      }
      if (!res.ok) throw new Error(`1Click did not send its token list (HTTP ${res.status}). Try again in a moment.`);
      mem.oneClick = await res.json();
    }
    return mem.oneClick;
  }

  /** The decimals behind every amount the page signs or pays come from the proxy: 1Click must agree. */
  async function checkAssets(order) {
    const list = await oneClickList();
    for (const t of [order.sell, order.buy]) {
      const c = checkToken(t, list.find((x) => x.assetId === t.assetId));
      if (!c.ok) throw new Error(`${c.reason[0].toUpperCase()}${c.reason.slice(1)}, so the page will not size this order.`);
    }
  }

  async function issueGrant(minutes) {
    const by = owner();
    await assertAccount(by);
    const credential = await createGrantCredential();
    const expiresAt = isoSeconds(Date.now() + grantHours(minutes) * 3_600_000);
    const request = { type: 'grant_issue', agent_id: saved.agentId, label: 'wakeless-web', credential: credential.commitment, expires_at: expiresAt };
    const status = await runOwnerIntent(api, signAs(by), request, { owner: by, onGenerated: showSummary });
    if (status.status !== 'SUCCESS') throw new Error(`The grant ended ${status.status}${status.failure_code ? ` (${status.failure_code})` : ''}.`);
    mem.grant = { token: credential.token, expiresAt };
  }

  async function readPolicy() {
    const view = await api.getPolicy(saved.agentId);
    mem.policyView = view;
    if (view?.policy) {
      saved.frozen = Boolean(view.policy.frozen);
      store();
    }
    mem.policyCheck = policyCheckFor(view);
    return view;
  }

  function policyCheckFor(view) {
    if (saved.policy) return checkAppliedPolicy(view, saved.policy);
    const w = walletOrder();
    if (!w.order) return { ok: false, pending: true, reason: w.error };
    return checkWalletPolicy(view, { assetId: w.order.sell.assetId, perSwap: w.cap.perSwap, perDay: w.cap.perDay, destinations: destinationsFor(saved.receive, saved.refund), maxBudgetUsd: HOSTED.budgetUsd });
  }

  async function fillNearAccount() {
    const agent = await api.getAgent(saved.agentId);
    const near = agent?.wallet?.near_account_id;
    if (near) {
      saved.nearAccount = near;
      store();
    }
  }

  async function refreshBalances() {
    if (!saved?.agentId) return;
    const [conf, pub] = await Promise.all([
      api.getBalances(saved.agentId, { source: 'confidential' }),
      api.getBalances(saved.agentId, { source: 'public' }).catch(() => null),
    ]);
    mem.balances = conf?.balances ?? [];
    mem.publicBalances = pub?.balances ?? null;
  }

  async function requestDeposit() {
    const assets = walletAssets();
    const w = walletOrder();
    if (!w.order) throw new Error(w.error);
    if (!mem.policyCheck?.ok) throw new Error("The wallet's rules are not confirmed yet, so the page asks for no deposit address.");
    await checkAssets(w.order);
    await refreshBalances();
    const need = w.order.totalUnits - holdings(assets).sell;
    if (need <= 0n) return;
    if (!saved.nearAccount) await fillNearAccount();
    const dep = await api.deposit(saved.agentId, { origin_asset: w.order.sell.assetId, amount: need.toString(), confidential: true });
    const d = dep?.details ?? {};
    if (!d.deposit_address) throw new Error('The Agent API returned no deposit address.');
    const fit = checkDepositAnswer(d, { chain: w.order.sell.blockchain, assetId: w.order.sell.assetId, amount: need.toString(), nearAccount: saved.nearAccount });
    if (!fit.ok) throw new Error(`The deposit answer does not fit this order (${fit.reason}). Nothing was saved; do not send to it.`);
    saved.deposit = { address: d.deposit_address, memo: d.memo ?? null, amount: need.toString(), assetId: w.order.sell.assetId, expiresAt: d.expires_at ?? null, correlationId: dep.correlation_id ?? null, createdAt: new Date().toISOString(), sent: null, checked: true };
    store();
    mem.depositCheck = null;
    mem.depositStatus = null;
    await verifyDeposit();
  }

  /**
   * A deposit address is shown only if the Agent API's answer fit the request
   * when it was saved (checkDepositAnswer). 1Click does not know these
   * addresses, so nothing outside the Agent API can confirm one; an address
   * saved before the page checked answers gets a fresh one instead.
   */
  async function verifyDeposit() {
    const dep = saved?.deposit;
    if (!dep) return;
    mem.depositCheck = dep.checked ? { ok: true, retry: false } : { ok: false, retry: false, reason: 'it was saved before the page checked deposit answers' };
  }

  async function refreshDeposit() {
    const dep = saved?.deposit;
    if (!dep) return;
    if (!mem.depositCheck || (!mem.depositCheck.ok && mem.depositCheck.retry)) await verifyDeposit();
    if (dep.correlationId && !DEPOSIT_FINAL.has(mem.depositStatus)) {
      const s = await api.getStatus(dep.correlationId);
      mem.depositStatus = s?.status ?? null;
    }
  }

  async function create() {
    const t = ticketOrder();
    if (t.error) throw new Error(t.error);
    const { order } = t;
    const by = mem.account;
    if (!by) throw new Error('Connect a wallet first.');
    await assertAccount(by);
    const receive = { chain: order.buy.blockchain, address: $('#live-receive').value.trim() };
    const refund = { chain: order.sell.blockchain, address: $('#live-refund').value.trim() };
    for (const [label, a] of [['receive', receive], ['return', refund]]) {
      const c = checkAddress(a.chain, a.address);
      if (!c.ok) throw new Error(`The ${label} address: ${c.reason}.`);
      if (evmOnNear(a.chain, a.address) && !window.confirm(`The ${label} address is an 0x account on NEAR, which only an EVM wallet can use. Use it anyway?`)) return;
    }
    await checkAssets(order);
    $('#live-sigs').textContent = '';
    $('#live-summary').textContent = '';
    signStep(0, 'Sign in, so the page can read your public key', 'now');
    signStep(1, 'Create the agent wallet with the rules above', 'wait');
    signStep(2, 'Let this tab work the order', 'wait');

    const message = [
      'Wakeless sign-in',
      '',
      'This proves you hold this wallet, so it can own a new NEAR Intents agent wallet.',
      'It moves no funds and costs no gas.',
      '',
      `Address: ${by}`,
      `Nonce: ${crypto.randomUUID()}`,
    ].join('\n');
    await assertAccount(by);
    const signer = recoverPersonalSigner(message, await mem.w.personalSign(by, message));
    if (signer.address !== by) throw new Error('The sign-in signature belongs to another account. Nothing was created.');
    signStep(0, 'Signed in', 'done');
    signStep(1, 'Create the agent wallet: confirm in your wallet', 'now');

    const destinations = destinationsFor(receive, refund);
    const policy = hostedPolicy({ sellAssetId: order.sell.assetId, buyAssetId: order.buy.assetId, perSwap: t.cap.perSwap, perDay: t.cap.perDay, destinations });
    const request = { type: 'agent_create', name: 'Wakeless desk', owner: { type: 'evm', address: signer.address, chain_id: 1, public_key: signer.publicKey }, policy };
    const created = await runOwnerIntent(api, signAs(by), request, { owner: by, onGenerated: showSummary });
    if (created.status !== 'SUCCESS' || !created.agent_id) throw new Error(`Creating the wallet ended ${created.status}${created.failure_code ? ` (${created.failure_code})` : ''}.`);
    // Saved at once: the wallet exists now, whatever fails next.
    saved = {
      v: 1,
      agentId: created.agent_id,
      nearAccount: null,
      owner: { address: by, publicKey: signer.publicKey },
      spec: t.spec,
      assets: { sell: pick(order.sell), buy: pick(order.buy) },
      policy,
      receive: { chain: receive.chain, address: canonicalAddress(receive.chain, receive.address) },
      refund: { chain: refund.chain, address: canonicalAddress(refund.chain, refund.address) },
      createdAt: new Date().toISOString(),
      runs: 0,
      frozen: false,
      deposit: null,
    };
    store();
    remember('created');
    signStep(1, `Agent wallet ${short(saved.agentId)} created`, 'done');
    await fillNearAccount().catch(() => {});
    await confirmPolicy();
    signStep(2, 'Let this tab work the order: confirm in your wallet', 'now');
    await issueGrant(t.spec.horizonMinutes);
    signStep(2, `This tab may trade until ${utcTime(mem.grant.expiresAt).slice(11)}`, 'done');
    await requestDeposit();
    await refreshBalances();
  }

  /** The rules read back from the new wallet must be the ones just signed, before a deposit address is asked for. */
  async function confirmPolicy() {
    for (let i = 0; i < 5; i++) {
      await readPolicy();
      if (mem.policyCheck.ok || !mem.policyCheck.pending) break;
      await sleep(2_000);
    }
    if (mem.policyCheck.ok) return;
    if (mem.policyCheck.pending) throw new Error("The wallet's rules are not applied yet. The page asks for a deposit address once they are.");
    throw new Error(`The wallet's rules are not the ones you signed (${mem.policyCheck.reason}). Do not fund it: freeze it and start over.`);
  }

  async function sendFromWallet(again = false) {
    const dep = saved?.deposit;
    if (!dep || !mem.depositCheck?.ok) throw new Error('The deposit address is not confirmed yet; nothing was sent.');
    const assets = walletAssets();
    if (dep.assetId !== assets.sell.assetId) throw new Error('This deposit address is for another asset; nothing was sent.');
    if (dep.memo) throw new Error('This deposit address needs a memo, which a plain transfer can not carry. Send from a wallet that adds it.');
    if (dep.sent && !again) throw new Error('This deposit was already sent from this page.');
    if (!mem.w || !mem.account) throw new Error('Connect a wallet first.');
    const chain = assets.sell.blockchain;
    const token = contractOf(assets.sell.assetId);
    if (token === undefined || !EVM_CHAIN[chain]) throw new Error('The page can not send this asset; send it from your wallet.');
    const hash = await mem.w.send({ from: mem.account, chain, to: dep.address, amount: dep.amount, token });
    dep.sent = { txHash: hash, chainId: EVM_CHAIN[chain].id, time: new Date().toISOString() };
    store();
  }

  // Stop: the engine halts at its next quote or swap, so a slice already sent finishes and no new one starts.
  const stoppableClient = (client) => ({
    ...client,
    async quote(body) {
      if (mem.stop) throw new StoppedError();
      return client.quote(body);
    },
  });
  const stoppableExecutor = (executor) => ({
    ...executor,
    async execute(args) {
      if (mem.stop) throw new StoppedError();
      return executor.execute(args);
    },
  });

  function runEnd(events) {
    const last = [...(events ?? [])].reverse().find((e) => e.type === 'halt' || e.type === 'abort' || e.type === 'done');
    if (!last) return null;
    if (last.type === 'done') return 'Order worked.';
    const why = String(last.message ?? last.reason ?? last.status ?? 'no reason given').replace(/\.$/, '');
    return last.type === 'abort' ? `The run did not start: ${why}.` : `The run stopped: ${why}.`;
  }

  async function work() {
    const assets = walletAssets();
    if (!assets) throw new Error('Loading the Agent API token list.');
    const view = await readPolicy();
    if (saved.frozen) throw new Error('The wallet is frozen. Unfreeze it first.');
    if (!mem.policyCheck?.ok) throw new Error(`The wallet's rules are not confirmed (${mem.policyCheck?.reason}).`);
    await refreshBalances();
    const have = holdings(assets).sell;
    if (have <= 0n) throw new Error(`The wallet holds no ${assets.sell.symbol} to work.`);
    const perSwap = bigOrNull(view.policy?.limits?.per_transaction?.[assets.sell.assetId]);
    const perDay = bigOrNull(view.policy?.limits?.daily?.[assets.sell.assetId]);
    if (!perSwap || !perDay) throw new Error(`The wallet has no per-swap cap on ${assets.sell.symbol}, so the page will not work it.`);
    const order = planRemainder({ spec: saved.spec, tokens: await prices.tokens(), balance: have, perSwap, perDay, deskAccount: saved.nearAccount ?? undefined });
    if (!order) throw new Error('What the wallet holds does not fit the signed limits as slices. Return it instead.');
    await checkAssets(order);
    const seed = newSeed();
    const cap = checkSliceCap(view.policy, { assetId: order.sell.assetId, schedule: scheduleFor(order, mulberry32(seed)), total: order.totalUnits });
    // A run that sells the whole balance is bounded by that balance, even where
    // the signed limits (made for the first order) are larger than this run.
    const wholeBalance = order.totalUnits === have && (cap.reason === 'cap_allows_whole_order' || cap.reason === 'daily_above_order');
    if (!cap.ok && !wholeBalance) throw new Error(`The signed policy does not hold this run to its slices (${cap.reason}).`);
    // The grant must outlast the run, or its last slices would be refused.
    if (!grantValid(order.horizonMs + 10 * 60_000)) await issueGrant(Math.ceil(order.horizonMs / 60_000));
    const bot = api.forGrant(mem.grant.token);
    mem.running = true;
    mem.stop = false;
    mem.lastRun = null;
    render();
    try {
      const events = await workOrder({
        order,
        seed,
        label: 'Working the order live',
        client: stoppableClient(agentQuoteClient({ bot, agentId: saved.agentId, prices, confidential: true })),
        executor: stoppableExecutor(agentExecutor({ api, bot, agentId: saved.agentId, mode: 'live', confidential: true })),
        walletCap: { revision: view.revision, reason: cap.reason, perSwap: cap.perSwap?.toString() ?? null, perDay: cap.perDay?.toString() ?? null, largestSlice: cap.largest.toString() },
      });
      mem.lastRun = runEnd(events);
    } catch (err) {
      if (err?.name !== 'StoppedError') throw err;
      mem.lastRun = 'Stopped before the next slice; the rest stays in the agent wallet.';
    } finally {
      mem.running = false;
      mem.stop = false;
      saved.runs = (saved.runs ?? 0) + 1;
      store();
      await refreshBalances().catch(() => {});
    }
  }

  /** A preview's warnings that only say "later": a window limit or the budget, with when and how much. */
  function heldBy(warnings) {
    if (!warnings?.length || !warnings.every((x) => HELD_CODES.has(x?.code))) return null;
    const amounts = warnings.map((x) => bigOrNull(x.available_amount)).filter((v) => v !== null);
    const times = warnings.map((x) => x.available_at).filter(Boolean).sort();
    return { amount: amounts.length ? amounts.reduce((a, b) => (b < a ? b : a)) : null, at: times.at(-1) ?? null };
  }

  async function takeOut(kind) {
    const assets = walletAssets();
    if (!assets) throw new Error('Loading the Agent API token list.');
    const asset = assets[kind];
    const dest = kind === 'buy' ? saved.receive : saved.refund;
    const view = await readPolicy();
    if (saved.frozen) throw new Error('The wallet is frozen. Unfreeze it first.');
    if (!grantValid()) throw new Error('This tab has no grant. Sign one first.');
    await refreshBalances();
    let left = holdings(assets)[kind];
    if (left <= 0n) throw new Error('Nothing to withdraw.');
    const perTx = bigOrNull(view.policy?.limits?.per_transaction?.[asset.assetId]);
    const bot = api.forGrant(mem.grant.token);
    const out = $('#live-out');
    const u = (v) => `${fromUnits(v, asset.decimals)} ${asset.symbol}`;
    const body = (amount) => ({ asset: asset.assetId, amount: amount.toString(), chain: dest.chain, recipient: dest.address, confidential: true });
    let moved = 0n;
    for (let i = 0; left > 0n && i < 64; i++) {
      const count = i + planChunks(left, perTx).length;
      let part = planChunks(left, perTx)[0];
      // Each part is previewed on its own (with its own idempotency key) before it is sent.
      let preview = await bot.withdraw(saved.agentId, { ...body(part), dry: true });
      let held = heldBy(preview.warnings);
      if (held?.amount && held.amount > 0n && held.amount < part) {
        part = held.amount;
        preview = await bot.withdraw(saved.agentId, { ...body(part), dry: true });
        held = heldBy(preview.warnings);
      }
      const codes = (preview.warnings ?? []).map((x) => x?.code ?? String(x));
      if (codes.length) {
        const so = moved > 0n ? `Withdrawn so far: ${u(moved)}. ` : '';
        if (held) {
          out.textContent = `${so}The wallet's limits hold the rest (${codes.join(', ')}) ${held.at ? `until ${utcTime(held.at)}` : 'for now'}; withdraw again then.`;
          break;
        }
        throw new Error(`${so}The wallet would refuse ${moved > 0n ? 'the rest' : 'this withdrawal'} (${codes.join(', ')}); nothing more was sent.`);
      }
      const fee = preview.fee?.amount_usd ? `, fee about $${Number(preview.fee.amount_usd).toFixed(2)}` : '';
      out.textContent = `Withdrawing ${count > 1 ? `part ${i + 1} of ${count}, ` : ''}${u(part)} to ${short(dest.address)} on ${chainName(dest.chain)}${fee}.`;
      const started = await bot.withdraw(saved.agentId, { ...body(part), async: true });
      const final = await waitForStatus(api, started.correlation_id, 900_000);
      const d = final.details ?? {};
      const hash = d.destination_tx_hash ?? d.tx_hash ?? null;
      const link = txLink(dest.chain, hash);
      out.textContent = '';
      if (final.status !== 'SUCCESS') {
        out.append(`The withdrawal ended ${final.status}${final.failure_code ? ` (${final.failure_code})` : ''}. `, link ? node('a', { href: link, target: '_blank', rel: 'noopener', text: `Transaction ${short(hash)}` }) : '');
        break;
      }
      moved += part;
      left -= part;
      out.append(`Withdrawn: ${u(moved)}${left > 0n ? `, ${u(left)} to go` : ''}. `, link ? node('a', { href: link, target: '_blank', rel: 'noopener', text: `Transaction ${short(hash)}` }) : '');
    }
    await refreshBalances();
  }

  /** Freeze has its own flag, so it works while an order runs; the intent follows the wallet's state read just now. */
  async function toggleFreeze() {
    if (mem.freezing || !saved?.agentId) return;
    mem.freezing = true;
    setError('');
    render();
    try {
      const by = owner();
      await assertAccount(by);
      const view = await readPolicy();
      const type = view.policy?.frozen ? 'agent_unfreeze' : 'agent_freeze';
      const status = await runOwnerIntent(api, signAs(by), { type, agent_id: saved.agentId }, { owner: by, onGenerated: showSummary });
      if (status.status !== 'SUCCESS') throw new Error(`${type} ended ${status.status}${status.failure_code ? ` (${status.failure_code})` : ''}.`);
      // A frozen wallet refuses the next swap anyway; stop asking for one.
      if (type === 'agent_freeze' && mem.running) mem.stop = true;
      await readPolicy();
    } catch (err) {
      setError(walletMessage(err));
    } finally {
      mem.freezing = false;
      render();
    }
  }

  function download() {
    const details = {
      about: 'Wakeless agent wallet details. Keep this file private: with the agent id anyone can read the wallet through the site, although only the owner wallet can change or move anything. To come back, open the desk, choose Live, connect the owner wallet and load this file.',
      version: 2,
      agent_id: saved.agentId,
      owner: saved.owner.address,
      receive: saved.receive,
      refund: saved.refund,
      order: saved.spec,
      created_at: saved.createdAt ?? null,
      site: location.origin,
    };
    const a = node('a', { href: URL.createObjectURL(new Blob([`${JSON.stringify(details, null, 2)}\n`], { type: 'application/json' })), download: `wakeless-wallet-${saved.agentId.slice(0, 8)}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2_000);
  }

  /**
   * A details file is only a pointer: the wallet is read from the Agent API,
   * and its owner, destinations and limits must match the file and the
   * connected account. No deposit address or amount is ever taken from it.
   */
  async function load(file) {
    if (file.size > 65_536) throw new Error('Not a Wakeless wallet file.');
    const f = parseWalletFile(await file.text());
    if (!f.ok) throw new Error(`Not a Wakeless wallet file: ${f.reason}.`);
    if (!mem.account) throw new Error('Connect the owner wallet first, then load the file.');
    if (f.owner !== mem.account) throw new Error(`This wallet is owned by ${short(f.owner)}. Connect that account, then load the file.`);
    if (saved?.agentId && saved.agentId !== f.agentId) {
      const ok = window.confirm(`Replace the agent wallet ${short(saved.agentId)} saved in this browser? Any funds stay in it. Save its details first if you want to come back to it.`);
      if (!ok) return;
    }
    const agent = await api.getAgent(f.agentId);
    const o = agent?.owner;
    if (o?.type !== 'evm' || o.address?.toLowerCase() !== mem.account) throw new Error('The Agent API names another owner for this wallet. Nothing was loaded.');
    if (typeof o.public_key !== 'string' || publicKeyToAddress(o.public_key) !== mem.account) throw new Error("The owner's public key is not the connected account's. Nothing was loaded.");
    const tokens = await prices.tokens();
    mem.tokens ??= tokens;
    let order;
    try {
      order = resolveOrder(liveSpec(f.spec), tokens);
    } catch (err) {
      throw new Error(`The file's order: ${err.message}`);
    }
    const cap = capFor(order);
    const view = await api.getPolicy(f.agentId);
    const check = checkWalletPolicy(view, { assetId: order.sell.assetId, perSwap: cap.perSwap, perDay: cap.perDay, destinations: destinationsFor(f.receive, f.refund), maxBudgetUsd: HOSTED.budgetUsd });
    if (!check.ok) throw new Error(`The wallet's rules do not match the file (${check.reason}). Nothing was loaded.`);
    saved = {
      v: 1,
      agentId: f.agentId,
      nearAccount: agent.wallet?.near_account_id ?? null,
      owner: { address: mem.account, publicKey: o.public_key },
      spec: liveSpec(f.spec),
      assets: { sell: pick(order.sell), buy: pick(order.buy) },
      receive: f.receive,
      refund: f.refund,
      createdAt: null,
      runs: 0,
      frozen: check.frozen,
      deposit: null,
    };
    store();
    remember('loaded');
    Object.assign(mem, { grant: null, policyView: view, policyCheck: check, depositCheck: null, depositStatus: null, lastRun: null });
    await refreshBalances();
  }

  function forget() {
    const ok = window.confirm('Forget this agent wallet in this browser? Any funds stay in it. Save the wallet details first if you want to come back.');
    if (!ok) return;
    saved = null;
    Object.assign(mem, { grant: null, balances: null, publicBalances: null, policyView: null, policyCheck: null, depositCheck: null, depositStatus: null, lastRun: null });
    store();
    for (const id of ['#live-sigs', '#live-summary', '#live-out', '#live-sent']) $(id).textContent = '';
  }

  /** One poll: the wallet's rules and frozen flag, balances, the agent account and the deposit. */
  async function tick() {
    if (!saved?.agentId) return;
    const jobs = [readPolicy()];
    if (!mem.running) jobs.push(refreshBalances(), refreshDeposit());
    if (!saved.nearAccount) jobs.push(fillNearAccount());
    await Promise.allSettled(jobs);
  }

  function startPolling() {
    clearInterval(mem.pollTimer);
    mem.pollTimer = setInterval(async () => {
      if (document.hidden || !saved?.agentId || $('#live').hidden) return;
      await tick();
      render();
    }, 10_000);
  }

  // ---------- wiring ----------

  $('#live-connect').addEventListener('click', connect);
  $('#live-create').addEventListener('click', () => act(create));
  $('#live-regrant').addEventListener('click', () => act(async () => {
    await issueGrant(saved.spec.horizonMinutes);
    if (!saved.deposit && mem.policyCheck?.ok && owesFunding(walletAssets())) await requestDeposit();
    await refreshBalances();
  }));
  $('#live-get-deposit').addEventListener('click', () => act(async () => {
    if (!mem.policyCheck?.ok) await readPolicy();
    await requestDeposit();
  }));
  $('#live-copy').addEventListener('click', () => navigator.clipboard?.writeText(saved?.deposit?.address ?? ''));
  $('#live-send-wallet').addEventListener('click', () => act(() => sendFromWallet(false)));
  $('#live-send-again').addEventListener('click', () => {
    const ok = window.confirm('This address expects the amount once. Send again only if the first transfer failed on chain. Send again?');
    if (ok) act(() => sendFromWallet(true));
  });
  $('#live-run').addEventListener('click', () => act(work));
  $('#live-stop').addEventListener('click', () => {
    if (!mem.running) return;
    mem.stop = true;
    render();
  });
  $('#live-withdraw').addEventListener('click', () => act(() => takeOut('buy')));
  $('#live-return').addEventListener('click', () => act(() => takeOut('sell')));
  $('#live-freeze').addEventListener('click', toggleFreeze);
  $('#live-save').addEventListener('click', download);
  $('#live-load').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) act(() => load(file));
    e.target.value = '';
  });
  $('#live-forget').addEventListener('click', () => {
    forget();
    render();
  });
  for (const id of ['#live-receive', '#live-refund']) $(id).addEventListener('input', render);

  return {
    async show() {
      $('#live').hidden = false;
      if (!mem.tokens) {
        try {
          mem.tokens = await prices.tokens();
        } catch (err) {
          setError(`The Agent API is not reachable from this site right now (${err.message}).`);
        }
      }
      render();
      if (saved?.agentId) await tick();
      startPolling();
      render();
    },
    hide() {
      $('#live').hidden = true;
      clearInterval(mem.pollTimer);
      lockTicket(null);
    },
    render,
    get running() {
      return mem.running;
    },
  };
}
