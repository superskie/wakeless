// Live mode of the web desk. The visitor's own wallet owns a NEAR Intents
// agent wallet that can only swap within the order's slice cap and withdraw to
// the addresses the visitor named. Funds go in by a plain transfer to the
// agent's confidential deposit address, and this tab works the slices with
// the same engine, executor and quote client as the command line.
//
// Kept in localStorage: the agent id, the owner's address, the order and the
// two addresses, none of them secret. The grant token lives only in memory, so
// after a reload the owner signs a new grant before the tab can trade again.
import { agentHttp, runOwnerIntent } from '../src/agent/http.mjs';
import { createGrantCredential } from '../src/agent/grant.mjs';
import { HOSTED, RECEIVE_CHAINS, canonicalAddress, checkAddress, destinationsFor, hostedPolicy, isEvmChain } from '../src/agent/hosted.mjs';
import { capFor, checkSliceCap } from '../src/agent/cap.mjs';
import { agentQuoteClient, priceBook } from '../src/agent/quotes.mjs';
import { agentExecutor } from '../src/executors/agent.mjs';
import { waitForStatus } from '../src/agent/status.mjs';
import { prepareOrder } from '../src/order.mjs';
import { scheduleFor } from '../src/engine.mjs';
import { mulberry32 } from '../src/rng.mjs';
import { fromUnits, toNumber } from '../src/units.mjs';
import { recoverPersonalSigner } from '../src/evm.mjs';
import { EVM_CHAIN, discoverWallets, wallet, walletMessage } from './wallet.mjs';

const STORE = 'wakeless.live.v1';
const CHAIN_NAME = { eth: 'Ethereum', arb: 'Arbitrum', base: 'Base', op: 'Optimism', pol: 'Polygon', bsc: 'BNB Chain', avax: 'Avalanche', sol: 'Solana', near: 'NEAR' };
export const LIVE_ASSETS = ['eth:base', 'usdc:base', 'eth:arb', 'usdc:arb', 'eth:eth', 'usdc:eth', 'sol:sol', 'usdc:sol', 'wnear:near'];

const $ = (selector) => document.querySelector(selector);
const short = (a) => (a && a.length > 14 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a ?? '');
const chainName = (c) => CHAIN_NAME[c] ?? c;
const newSeed = () => crypto.getRandomValues(new Uint32Array(1))[0] >>> 1;

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
    return s && typeof s.agentId === 'string' ? s : null;
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

/**
 * @param {object} p
 * @param {() => object} p.ticket the ticket's current order fields
 * @param {(assetId: string) => string | null} p.contractOf EVM token contract, null for a native coin
 * @param {(locked: boolean) => void} p.lockTicket
 * @param {(run: object) => Promise<object[]>} p.workOrder runs the engine in the desk's monitor
 */
export function createLive({ ticket, contractOf, lockTicket, workOrder }) {
  const api = agentHttp();
  const prices = priceBook(api, { ttlMs: 60_000 });
  const mem = { w: null, account: null, grant: null, busy: false, balances: null, tokens: null, wallets: [], running: false, pollTimer: null };
  let saved = loadSaved();

  const store = () => (saved ? localStorage.setItem(STORE, JSON.stringify(saved)) : localStorage.removeItem(STORE));
  const setError = (text) => {
    $('#live-error').textContent = text ?? '';
  };
  const tokenOf = (ref) => mem.tokens?.find((t) => `${t.symbol.toLowerCase()}:${t.blockchain}` === ref.toLowerCase()) ?? null;

  /** The order under the ticket (or the saved one, once the wallet is made), checked against the hosted cap. */
  function currentOrder() {
    if (!mem.tokens) return { error: 'Loading the Agent API token list.' };
    const spec = liveSpec(saved?.spec ?? ticket());
    let order;
    try {
      order = prepareOrder(spec, mem.tokens);
    } catch (err) {
      return { error: err.message };
    }
    const usd = toNumber(order.totalUnits, order.sell.decimals) * order.sell.price;
    if (!(order.sell.price > 0)) return { error: `No USD price for ${order.sell.symbol} right now.` };
    if (usd > HOSTED.maxOrderUsd) return { error: `Live orders are capped at $${HOSTED.maxOrderUsd}; this one is about $${usd.toFixed(2)}.` };
    if (order.slices < HOSTED.minSlices) return { error: 'A live order needs at least 2 slices.' };
    if (!RECEIVE_CHAINS.has(order.buy.blockchain)) return { error: `Withdrawals to ${chainName(order.buy.blockchain)} are not supported.` };
    return { order, spec, usd, cap: capFor(order) };
  }

  function addressCheck(input, chain) {
    const value = input.value.trim();
    if (!value) return { ok: false, reason: '' };
    return checkAddress(chain, value);
  }

  // ---------- rendering ----------

  function render() {
    const panel = $('#live');
    if (panel.hidden) return;
    const o = currentOrder();
    const sell = o.order?.sell;
    const buy = o.order?.buy;
    const made = Boolean(saved?.agentId);

    // 1. wallet
    $('#ls-wallet').dataset.state = mem.account ? 'done' : 'todo';
    $('#live-account').textContent = mem.account ? `${short(mem.account)} connected` : made ? `Owner ${short(saved.owner.address)}. Connect it to continue.` : 'Any EVM wallet. It signs the rules and pays no gas.';
    $('#live-connect').textContent = mem.account ? 'Switch wallet' : 'Connect wallet';

    // 2. where the funds go
    const receive = $('#live-receive');
    const refund = $('#live-refund');
    if (buy) $('#live-receive-label').textContent = `Receive ${buy.symbol} on ${chainName(buy.blockchain)} at`;
    if (sell) $('#live-refund-label').textContent = `Send anything unsold, ${sell.symbol} on ${chainName(sell.blockchain)}, back to`;
    if (made) {
      receive.value = saved.receive.address;
      refund.value = saved.refund?.address ?? '';
    } else if (mem.account) {
      if (buy && isEvmChain(buy.blockchain) && !receive.value) receive.value = mem.account;
      if (sell && isEvmChain(sell.blockchain) && !refund.value) refund.value = mem.account;
    }
    receive.disabled = made;
    refund.disabled = made;
    const rc = buy ? addressCheck(receive, buy.blockchain) : { ok: false, reason: '' };
    const fc = sell ? addressCheck(refund, sell.blockchain) : { ok: false, reason: '' };
    $('#live-receive-hint').textContent = rc.ok ? 'The only place the bought asset can go. Check it against your wallet popup.' : rc.reason;
    $('#live-refund-hint').textContent = fc.ok ? 'Used only if a slice can not fill. It may be another wallet than the one that pays in.' : fc.reason;
    $('#ls-where').dataset.state = made || (rc.ok && fc.ok) ? 'done' : 'todo';

    // 3. the agent wallet and its rules
    const rules = $('#live-rules');
    rules.textContent = '';
    if (o.error) rules.append(node('li', { class: 'bad', text: o.error }));
    else {
      const u = (v) => `${fromUnits(v, sell.decimals)} ${sell.symbol}`;
      const about = (v) => `${Number(toNumber(v, sell.decimals).toPrecision(4))} ${sell.symbol}`;
      rules.append(
        node('li', { text: `Swaps only, never more than about ${about(o.cap.perSwap)} at once (the largest slice this order can draw) and ${u(o.cap.perDay)} a day.` }),
        node('li', { text: `Withdrawals only to the two addresses above. Every swap in confidential form, a $${HOSTED.budgetUsd} daily budget.` }),
        node('li', { text: `This tab may trade for ${grantHours(o.spec)} hours. Your wallet can freeze it at any time.` }),
      );
    }
    $('#ls-create').dataset.state = made ? 'done' : 'todo';
    $('#live-create').hidden = made;
    $('#live-create').disabled = mem.busy || !mem.account || !rc.ok || !fc.ok || Boolean(o.error);
    $('#live-made').hidden = !made;
    if (made) $('#live-made').textContent = `Agent wallet ${short(saved.agentId)}, owned by ${short(saved.owner.address)}.${mem.grant ? '' : ' This tab has no grant yet: connect the owner wallet and sign one.'}`;
    $('#live-regrant').hidden = !made || Boolean(mem.grant) || !mem.account;
    $('#live-regrant').disabled = mem.busy;

    // 4. funding
    const fundOn = made && !o.error;
    $('#ls-fund').dataset.state = !fundOn ? 'off' : funded(o) ? 'done' : 'todo';
    $('#live-fund').hidden = !fundOn;
    if (fundOn) {
      const dep = saved.deposit;
      $('#live-send').textContent = dep
        ? `Send exactly ${fromUnits(BigInt(dep.amount), sell.decimals)} ${sell.symbol} on ${chainName(sell.blockchain)}, from any wallet or exchange, to:`
        : 'Getting a deposit address.';
      $('#live-deposit').textContent = dep?.address ?? '';
      $('#live-copy').disabled = !dep;
      const canSend = dep && mem.account && isEvmChain(sell.blockchain) && EVM_CHAIN[sell.blockchain];
      $('#live-send-wallet').hidden = !canSend;
      $('#live-send-wallet').disabled = mem.busy;
      $('#live-balance').textContent = balanceLine(o);
    }

    // 5. run
    const ready = fundOn && funded(o);
    $('#ls-run').dataset.state = !ready ? 'off' : saved.runs ? 'done' : 'todo';
    $('#live-run').disabled = !ready || mem.busy || mem.running || !mem.grant;
    $('#live-run-hint').textContent = saved?.frozen
      ? 'Frozen: the wallet runs no swap and no withdrawal until you unfreeze it.'
      : !ready
        ? 'Opens once the deposit has arrived.'
      : !mem.grant
        ? 'Connect the owner wallet and sign a grant first.'
        : `Real time: about ${o.spec.horizonMinutes} minutes. Keep this tab open; if it closes, the funds wait in the agent wallet.`;

    // 6. out
    const holding = holdings(o);
    $('#ls-out').dataset.state = !made ? 'off' : holding.buy > 0n || holding.sell > 0n ? 'todo' : saved.runs ? 'done' : 'off';
    $('#live-withdraw').hidden = !(holding.buy > 0n);
    $('#live-withdraw').textContent = holding.buy > 0n ? `Withdraw ${fromUnits(holding.buy, buy.decimals)} ${buy.symbol} to ${short(saved.receive.address)}` : 'Withdraw';
    $('#live-return').hidden = !(holding.sell > 0n) || !saved.refund;
    $('#live-return').textContent = holding.sell > 0n ? `Return ${fromUnits(holding.sell, sell.decimals)} ${sell.symbol} to ${short(saved.refund?.address)}` : 'Return';
    for (const id of ['#live-withdraw', '#live-return']) $(id).disabled = mem.busy || mem.running || !mem.grant;

    // footer
    $('#live-freeze').hidden = !made;
    $('#live-freeze').disabled = mem.busy || !mem.account;
    $('#live-freeze').textContent = saved?.frozen ? 'Unfreeze the wallet' : 'Freeze the wallet';
    $('#live-save').hidden = !made;
    $('#live-forget').hidden = !made;
    lockTicket(made ? saved.spec : null);
  }

  const grantHours = (spec) => Math.min(HOSTED.maxGrantHours, Math.max(1, Math.ceil(Number(spec?.horizonMinutes ?? 30) / 60) + 1));

  function holdings(o) {
    const out = { buy: 0n, sell: 0n };
    if (!mem.balances || !o.order) return out;
    for (const b of mem.balances) {
      if (b.asset_id === o.order.buy.assetId) out.buy = BigInt(b.available_raw ?? 0);
      if (b.asset_id === o.order.sell.assetId) out.sell = BigInt(b.available_raw ?? 0);
    }
    return out;
  }

  const funded = (o) => o.order && holdings(o).sell >= o.order.totalUnits && !saved?.runs;

  function balanceLine(o) {
    if (!mem.balances) return 'Reading the agent wallet balance.';
    const have = holdings(o).sell;
    const need = o.order.totalUnits;
    const u = (v) => `${fromUnits(v, o.order.sell.decimals)} ${o.order.sell.symbol}`;
    if (saved.runs) return `Order worked. The wallet holds ${u(have)} unsold.`;
    if (have >= need) return `Funded: ${u(have)} in confidential form.`;
    return `Waiting for the deposit: ${u(have)} of ${u(need)} so far. The address stays valid until ${saved.deposit?.expiresAt?.slice(0, 16).replace('T', ' ') ?? '-'} UTC.`;
  }

  // ---------- actions ----------

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
    const entry = await chooseWallet();
    const w = wallet(entry.provider);
    const account = await w.connect();
    if (saved?.owner && saved.owner.address !== account) {
      throw new Error(`This order's agent wallet is owned by ${short(saved.owner.address)}. Switch to that account in the wallet.`);
    }
    mem.w = w;
    mem.account = account;
    w.on('accountsChanged', (accounts) => {
      mem.account = accounts?.[0]?.toLowerCase() ?? null;
      if (saved?.owner && mem.account !== saved.owner.address) mem.grant = null;
      render();
    });
  }

  const sign = (payload) => mem.w.signTypedData(mem.account, payload);

  function signStep(i, text, state) {
    const list = $('#live-sigs');
    let li = list.children[i];
    if (!li) li = list.appendChild(node('li'));
    li.textContent = text;
    li.dataset.state = state;
  }

  async function issueGrant() {
    const credential = await createGrantCredential();
    const hours = grantHours(saved.spec);
    const expiresAt = new Date(Date.now() + hours * 3_600_000).toISOString();
    const status = await runOwnerIntent(api, sign, { type: 'grant_issue', agent_id: saved.agentId, label: 'wakeless-web', credential: credential.commitment, expires_at: expiresAt });
    if (status.status !== 'SUCCESS') throw new Error(`The grant ended ${status.status}${status.failure_code ? ` (${status.failure_code})` : ''}.`);
    mem.grant = { token: credential.token, expiresAt };
  }

  async function requestDeposit(order) {
    const dep = await api.deposit(saved.agentId, { origin_asset: order.sell.assetId, amount: order.totalUnits.toString(), confidential: true });
    const d = dep.details ?? {};
    if (!d.deposit_address) throw new Error('The Agent API returned no deposit address.');
    saved.deposit = { address: d.deposit_address, memo: d.memo ?? null, amount: order.totalUnits.toString(), assetId: order.sell.assetId, expiresAt: d.expires_at ?? null, correlationId: dep.correlation_id };
    store();
  }

  async function create() {
    const o = currentOrder();
    if (o.error) throw new Error(o.error);
    const { order } = o;
    const receive = { chain: order.buy.blockchain, address: $('#live-receive').value.trim() };
    const refund = { chain: order.sell.blockchain, address: $('#live-refund').value.trim() };
    for (const [label, a] of [['receive', receive], ['return', refund]]) {
      const c = checkAddress(a.chain, a.address);
      if (!c.ok) throw new Error(`The ${label} address: ${c.reason}.`);
    }
    $('#live-sigs').textContent = '';
    signStep(0, 'Sign in, so the page can read your public key', 'now');
    signStep(1, 'Create the agent wallet with the rules above', 'wait');
    signStep(2, 'Let this tab work the order', 'wait');

    const message = [
      'Wakeless sign-in',
      '',
      'This proves you hold this wallet, so it can own a new NEAR Intents agent wallet.',
      'It moves no funds and costs no gas.',
      '',
      `Address: ${mem.account}`,
      `Nonce: ${crypto.randomUUID()}`,
    ].join('\n');
    const signer = recoverPersonalSigner(message, await mem.w.personalSign(mem.account, message));
    if (signer.address !== mem.account) throw new Error('The sign-in signature belongs to another account. Nothing was created.');
    signStep(0, 'Signed in', 'done');
    signStep(1, 'Create the agent wallet: confirm in your wallet', 'now');

    const policy = hostedPolicy({ sellAssetId: order.sell.assetId, perSwap: o.cap.perSwap, perDay: o.cap.perDay, destinations: destinationsFor(receive, refund) });
    const owner = { type: 'evm', address: mem.account, chain_id: 1, public_key: signer.publicKey };
    const created = await runOwnerIntent(api, sign, { type: 'agent_create', name: 'Wakeless desk', owner, policy });
    if (created.status !== 'SUCCESS' || !created.agent_id) throw new Error(`Creating the wallet ended ${created.status}${created.failure_code ? ` (${created.failure_code})` : ''}.`);
    const agent = await api.getAgent(created.agent_id);
    saved = {
      v: 1,
      agentId: created.agent_id,
      nearAccount: agent.wallet?.near_account_id ?? null,
      owner: { address: mem.account, publicKey: signer.publicKey },
      spec: o.spec,
      receive: { chain: receive.chain, address: canonicalAddress(receive.chain, receive.address) },
      refund: { chain: refund.chain, address: canonicalAddress(refund.chain, refund.address) },
      createdAt: new Date().toISOString(),
      runs: 0,
      frozen: false,
    };
    store();
    signStep(1, `Agent wallet ${short(saved.agentId)} created`, 'done');
    signStep(2, 'Let this tab work the order: confirm in your wallet', 'now');
    await issueGrant();
    signStep(2, `This tab may trade until ${mem.grant.expiresAt.slice(11, 16)} UTC`, 'done');
    await requestDeposit(order);
    await refreshBalances();
  }

  async function refreshBalances() {
    if (!saved?.agentId) return;
    const res = await api.getBalances(saved.agentId, { source: 'confidential' });
    mem.balances = res.balances ?? [];
  }

  function startPolling() {
    clearInterval(mem.pollTimer);
    mem.pollTimer = setInterval(async () => {
      if (document.hidden || mem.running || !saved?.agentId || $('#live').hidden) return;
      try {
        await refreshBalances();
        render();
      } catch {
        // the next tick tries again
      }
    }, 10_000);
  }

  async function sendFromWallet() {
    const o = currentOrder();
    const dep = saved.deposit;
    const hash = await mem.w.send({ from: mem.account, chain: o.order.sell.blockchain, to: dep.address, amount: dep.amount, token: contractOf(o.order.sell.assetId) });
    const link = txLink(o.order.sell.blockchain, hash);
    $('#live-balance').textContent = '';
    $('#live-sent').textContent = '';
    $('#live-sent').append('Sent: ', link ? node('a', { href: link, target: '_blank', rel: 'noopener', text: short(hash) }) : short(hash), '. The balance updates once the deposit settles, usually within a few minutes.');
  }

  async function work() {
    const o = currentOrder();
    if (o.error) throw new Error(o.error);
    const policyView = await api.getPolicy(saved.agentId);
    if (policyView.policy?.frozen) throw new Error('The wallet is frozen. Unfreeze it first.');
    const order = prepareOrder({ ...o.spec, id: `web-live-${Date.now().toString(36)}`, deskAccount: saved.nearAccount ?? undefined }, await prices.tokens());
    const seed = newSeed();
    const cap = checkSliceCap(policyView.policy, { assetId: order.sell.assetId, schedule: scheduleFor(order, mulberry32(seed)), total: order.totalUnits });
    if (!cap.ok) throw new Error(`The signed policy does not hold this order to one slice per swap (${cap.reason}). Start over with a new wallet.`);
    await refreshBalances();
    if (holdings(o).sell < order.totalUnits) throw new Error('The deposit has not fully arrived yet.');
    const bot = api.forGrant(mem.grant.token);
    mem.running = true;
    render();
    try {
      await workOrder({
        order,
        seed,
        label: 'Working the order live',
        client: agentQuoteClient({ bot, agentId: saved.agentId, prices, confidential: true }),
        executor: agentExecutor({ api, bot, agentId: saved.agentId, mode: 'live', confidential: true }),
        walletCap: { revision: policyView.revision, reason: cap.reason, perSwap: cap.perSwap?.toString() ?? null, perDay: cap.perDay?.toString() ?? null, largestSlice: cap.largest.toString() },
      });
    } finally {
      mem.running = false;
      saved.runs = (saved.runs ?? 0) + 1;
      store();
      await refreshBalances().catch(() => {});
    }
  }

  async function takeOut(kind) {
    const o = currentOrder();
    const asset = kind === 'buy' ? o.order.buy : o.order.sell;
    const dest = kind === 'buy' ? saved.receive : saved.refund;
    await refreshBalances();
    const amount = kind === 'buy' ? holdings(o).buy : holdings(o).sell;
    if (amount <= 0n) throw new Error('Nothing to withdraw.');
    const bot = api.forGrant(mem.grant.token);
    const body = { asset: asset.assetId, amount: amount.toString(), chain: dest.chain, recipient: dest.address, confidential: true };
    const preview = await bot.withdraw(saved.agentId, { ...body, dry: true });
    const warnings = (preview.warnings ?? []).map((w) => w.code ?? String(w));
    if (warnings.length) throw new Error(`The wallet would refuse this withdrawal (${warnings.join(', ')}); nothing was sent.`);
    const out = $('#live-out');
    out.textContent = `Withdrawing ${fromUnits(amount, asset.decimals)} ${asset.symbol} to ${short(dest.address)} on ${chainName(dest.chain)}${preview.fee?.amount_usd ? `, fee about $${Number(preview.fee.amount_usd).toFixed(2)}` : ''}.`;
    const started = await bot.withdraw(saved.agentId, { ...body, async: true });
    const final = await waitForStatus(api, started.correlation_id, 900_000);
    const d = final.details ?? {};
    const hash = d.destination_tx_hash ?? d.tx_hash ?? null;
    const link = txLink(dest.chain, hash);
    out.textContent = '';
    out.append(
      final.status === 'SUCCESS' ? `Withdrawn: ${d.amount_out ? fromUnits(BigInt(d.amount_out), asset.decimals) : fromUnits(amount, asset.decimals)} ${asset.symbol}. ` : `The withdrawal ended ${final.status}${final.failure_code ? ` (${final.failure_code})` : ''}. `,
      link ? node('a', { href: link, target: '_blank', rel: 'noopener', text: `Transaction ${short(hash)}` }) : '',
    );
    await refreshBalances();
  }

  async function toggleFreeze() {
    const type = saved.frozen ? 'agent_unfreeze' : 'agent_freeze';
    const status = await runOwnerIntent(api, sign, { type, agent_id: saved.agentId });
    if (status.status !== 'SUCCESS') throw new Error(`${type} ended ${status.status}${status.failure_code ? ` (${status.failure_code})` : ''}.`);
    const view = await api.getPolicy(saved.agentId);
    saved.frozen = Boolean(view.policy?.frozen);
    store();
  }

  function download() {
    const details = {
      about: 'Wakeless agent wallet. No secrets here: the owner wallet signs every change. To come back, open the desk, choose Live, connect the owner wallet and load this file.',
      agent_id: saved.agentId,
      owner: saved.owner.address,
      near_account: saved.nearAccount,
      receive: saved.receive,
      refund: saved.refund,
      deposit: saved.deposit ?? null,
      order: saved.spec,
      created_at: saved.createdAt,
      site: location.origin,
    };
    const a = node('a', { href: URL.createObjectURL(new Blob([`${JSON.stringify(details, null, 2)}\n`], { type: 'application/json' })), download: `wakeless-wallet-${saved.agentId.slice(0, 8)}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2_000);
  }

  async function load(file) {
    const d = JSON.parse(await file.text());
    if (typeof d.agent_id !== 'string' || !/^[0-9a-f]{64}$/.test(d.agent_id) || typeof d.owner !== 'string') throw new Error('Not a Wakeless wallet file.');
    saved = { v: 1, agentId: d.agent_id, nearAccount: d.near_account ?? null, owner: { address: d.owner.toLowerCase(), publicKey: null }, spec: d.order, receive: d.receive, refund: d.refund, deposit: d.deposit, createdAt: d.created_at, runs: 1, frozen: false };
    store();
    mem.grant = null;
    await refreshBalances();
  }

  function forget() {
    const ok = window.confirm('Forget this agent wallet in this browser? Any funds stay in it. Save the wallet details first if you want to come back.');
    if (!ok) return;
    saved = null;
    mem.grant = null;
    mem.balances = null;
    store();
    $('#live-sigs').textContent = '';
    $('#live-out').textContent = '';
    $('#live-sent').textContent = '';
  }

  // ---------- wiring ----------

  $('#live-connect').addEventListener('click', () => act(connect));
  $('#live-create').addEventListener('click', () => act(create));
  $('#live-regrant').addEventListener('click', () => act(async () => {
    await issueGrant();
    if (!saved.deposit) await requestDeposit(currentOrder().order);
    await refreshBalances();
  }));
  $('#live-copy').addEventListener('click', () => navigator.clipboard?.writeText(saved?.deposit?.address ?? ''));
  $('#live-send-wallet').addEventListener('click', () => act(sendFromWallet));
  $('#live-run').addEventListener('click', () => act(work));
  $('#live-withdraw').addEventListener('click', () => act(() => takeOut('buy')));
  $('#live-return').addEventListener('click', () => act(() => takeOut('sell')));
  $('#live-freeze').addEventListener('click', () => act(toggleFreeze));
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
      if (saved?.agentId) await refreshBalances().catch(() => {});
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
