// web/live.mjs driven in Node: a small fake DOM, a fake EIP-1193 wallet and
// an in-process stand-in for the site's /api/agent proxy and for 1Click. No
// network. The owner key is made fresh for each run and never stored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bytesToHex, hashPersonalMessage, hexToBytes, publicKeyToAddress } from '../src/evm.mjs';
import { capFor } from '../src/agent/cap.mjs';
import { toDeskTokens } from '../src/agent/quotes.mjs';
import { largestPossibleSlice } from '../src/schedule.mjs';
import { prepareOrder } from '../src/order.mjs';
import { createLive, liveSpec, planChunks, planRemainder } from '../web/live.mjs';

// ---------- a throwaway secp256k1 signer for personal_sign ----------

const P = 2n ** 256n - 2n ** 32n - 977n;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = [0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n, 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n];
const mod = (a, m = P) => ((a % m) + m) % m;
function inv(a, m) {
  let [r0, r1, s0, s1] = [mod(a, m), m, 1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1, s0, s1] = [r1, r0 - q * r1, s1, s0 - q * s1];
  }
  return mod(s0, m);
}
function add(p, q) {
  if (!p) return q;
  if (!q) return p;
  if (p[0] === q[0] && mod(p[1] + q[1]) === 0n) return null;
  const l = p[0] === q[0] ? mod(3n * p[0] * p[0] * inv(2n * p[1], P)) : mod((q[1] - p[1]) * inv(q[0] - p[0], P));
  const x = mod(l * l - p[0] - q[0]);
  return [x, mod(l * (p[0] - x) - p[1])];
}
function mul(k, point = G) {
  let r = null;
  for (let b = point; k > 0n; k >>= 1n, b = add(b, b)) if (k & 1n) r = add(r, b);
  return r;
}
const randomScalar = () => mod(BigInt(bytesToHex(crypto.getRandomValues(new Uint8Array(32)))), N - 1n) + 1n;
function newKey() {
  const d = randomScalar();
  const [x, y] = mul(d);
  const publicKey = `0x${x.toString(16).padStart(64, '0')}${y.toString(16).padStart(64, '0')}`;
  return { d, publicKey, address: publicKeyToAddress(publicKey) };
}
function signPersonal(bytes, d) {
  const z = BigInt(bytesToHex(hashPersonalMessage(bytes)));
  for (;;) {
    const k = randomScalar();
    const R = mul(k);
    const r = mod(R[0], N);
    let s = mod(inv(k, N) * (z + r * d), N);
    if (r === 0n || s === 0n) continue;
    let v = Number(R[1] & 1n);
    if (s > N / 2n) {
      s = N - s;
      v ^= 1;
    }
    return `0x${r.toString(16).padStart(64, '0')}${s.toString(16).padStart(64, '0')}${(27 + v).toString(16)}`;
  }
}
const KEYS = [newKey(), newKey()];

// ---------- fake DOM ----------

class FakeNode {}
class FakeText extends FakeNode {
  constructor(t) {
    super();
    this.textContent = t;
  }
}
class FakeEl extends FakeNode {
  constructor(tag, id) {
    super();
    Object.assign(this, { tagName: tag, id, kids: [], dataset: {}, hidden: false, disabled: false, value: '', listeners: {}, className: '', files: null, _text: '' });
  }
  get textContent() {
    return this._text + this.kids.map((c) => c.textContent ?? '').join('');
  }
  set textContent(v) {
    this._text = String(v ?? '');
    this.kids = [];
  }
  get children() {
    return this.kids.filter((c) => c instanceof FakeEl);
  }
  append(...nodes) {
    for (const n of nodes) this.kids.push(n instanceof FakeNode ? n : new FakeText(String(n)));
  }
  appendChild(n) {
    this.kids.push(n);
    return n;
  }
  setAttribute(k, v) {
    this[k] = String(v);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  fire(type, event = {}) {
    return Promise.all((this.listeners[type] ?? []).map((f) => f({ target: this, ...event })));
  }
  click() {
    return this.fire('click');
  }
}

function installDom(store = new Map()) {
  const registry = new Map();
  const dom = { confirms: [], answer: true, store };
  globalThis.Node = FakeNode;
  globalThis.document = {
    hidden: false,
    querySelector(sel) {
      if (!registry.has(sel)) registry.set(sel, Object.assign(new FakeEl('div', sel.slice(1)), { hidden: sel === '#live' }));
      return registry.get(sel);
    },
    querySelectorAll: () => [],
    createElement: (tag) => new FakeEl(tag),
    createTextNode: (t) => new FakeText(t),
  };
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const win = new EventTarget();
  win.confirm = (text) => (dom.confirms.push(text), dom.answer);
  win.ethereum = globalThis.window?.ethereum; // the same browser wallet across a reload
  globalThis.window = win;
  globalThis.location = { origin: 'https://wakeless.example' };
  dom.$ = (sel) => document.querySelector(sel);
  return dom;
}

// ---------- fake wallet ----------

function fakeWallet() {
  let active = 0;
  const calls = [];
  const provider = {
    chainId: '0x1',
    listeners: {},
    async request({ method, params }) {
      calls.push({ method, params });
      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts':
          return [KEYS[active].address];
        case 'personal_sign':
          return signPersonal(hexToBytes(params[0]), KEYS[active].d);
        case 'eth_signTypedData_v4':
          return `0x${'11'.repeat(65)}`;
        case 'eth_chainId':
          return provider.chainId;
        case 'wallet_switchEthereumChain':
          provider.chainId = params[0].chainId;
          return null;
        case 'eth_sendTransaction':
          return `0x${'ab'.repeat(32)}`;
        default:
          throw new Error(`fake wallet: ${method}`);
      }
    },
    on(ev, f) {
      (provider.listeners[ev] ??= []).push(f);
    },
    removeListener(ev, f) {
      provider.listeners[ev] = (provider.listeners[ev] ?? []).filter((x) => x !== f);
    },
    use(i) {
      active = i;
      for (const f of provider.listeners.accountsChanged ?? []) f([KEYS[i].address]);
    },
  };
  window.ethereum = provider;
  return { provider, calls, count: (m) => calls.filter((c) => c.method === m).length };
}

// ---------- fake Agent API behind the proxy, and 1Click ----------

const SELL = 'nep141:base.omft.near';
const BUY = 'nep141:sol.omft.near';
const SOL_ADDR = '11111111111111111111111111111111';
const DEPOSIT = `0x${'de'.repeat(20)}`;
const ATTACKER = `0x${'ba'.repeat(20)}`;
const AGENT_TOKENS = [
  { asset_id: SELL, symbol: 'ETH', blockchain: 'base', decimals: 18, price: 2500 },
  { asset_id: BUY, symbol: 'SOL', blockchain: 'sol', decimals: 9, price: 150 },
  { asset_id: 'nep141:wrap.near', symbol: 'wNEAR', blockchain: 'near', decimals: 24, price: 3 },
];
const ONE_CLICK_TOKENS = AGENT_TOKENS.map((t) => ({ assetId: t.asset_id, symbol: t.symbol, blockchain: t.blockchain, decimals: t.decimals, price: t.price, contractAddress: null }));
const SPEC = { sell: 'eth:base', buy: 'sol:sol', amount: '0.01', slices: 4, horizonMinutes: 10, maxAdverseBps: 50 };
const ORDER = prepareOrder(liveSpec(SPEC), toDeskTokens(AGENT_TOKENS));
const CAP = capFor(ORDER);
const contractOf = (assetId) => {
  const t = ONE_CLICK_TOKENS.find((x) => x.assetId === assetId);
  return t ? t.contractAddress ?? null : undefined;
};

function fakeApi() {
  const s = {
    agentId: 'ab'.repeat(32),
    near: 'agent-test.near',
    owner: null,
    policy: null,
    frozen: false,
    tokens: structuredClone(AGENT_TOKENS),
    conf: [],
    pub: [],
    grants: new Set(),
    pending: new Map(),
    generated: [],
    withdrawals: [],
    deposits: [],
    log: [],
    evil: {},
  };
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const sha = (t) => createHash('sha256').update(t).digest('hex');

  function generate(req) {
    const owner = req.type === 'agent_create' ? req.owner : s.owner;
    const agentId = req.type === 'agent_create' ? s.agentId : req.agent_id;
    const inner =
      req.type === 'agent_create' ? { owner, name: req.name, policy: req.policy }
        : req.type === 'grant_issue' ? { domain: 'near-intents-agent-api.agent-grant.v6', owner, agent_id: agentId, label: req.label, credential: req.credential, expires_at_ms: Date.parse(req.expires_at) }
          : { action: req.type, owner, agent_id: agentId };
    s.evil.inner?.(inner, req);
    const g = {
      correlation_id: `intent_${s.generated.length}`,
      type: req.type,
      agent_id: agentId,
      status: 'PENDING_SIGNATURE',
      signer: owner,
      intent: { standard: 'eip712', payload: { domain: { name: 'NEAR Wallet Contract', version: '1' }, types: { Request: [{ name: 'message', type: 'string' }] }, primaryType: 'Request', message: { message: JSON.stringify(inner), timeoutSecs: 600 } } },
      preview: { summary: `About to sign ${req.type}.`, ...(req.type === 'agent_create' ? { policy: structuredClone(req.policy) } : {}) },
    };
    s.evil.generate?.(g, req);
    s.generated.push(req.type);
    s.pending.set(g.correlation_id, req);
    return g;
  }

  function submit(body) {
    const req = s.pending.get(body.correlation_id);
    if (req.type === 'agent_create') {
      s.owner = req.owner;
      s.policy = s.evil.applied ? s.evil.applied(structuredClone(req.policy)) : structuredClone(req.policy);
    }
    if (req.type === 'grant_issue') s.grants.add(req.credential);
    if (req.type === 'agent_freeze') s.frozen = true;
    if (req.type === 'agent_unfreeze') s.frozen = false;
  }

  function withdraw(body, headers) {
    if (!s.grants.has(sha(headers['x-grant-token'] ?? ''))) return reply(401, { errors: [{ code: 'grant_invalid' }] });
    const cap = s.policy.limits.per_transaction[body.asset];
    const over = cap != null && BigInt(body.amount) > BigInt(cap);
    s.withdrawals.push({ amount: BigInt(body.amount), dry: Boolean(body.dry), key: headers['idempotency-key'] });
    if (body.dry) return reply(200, { warnings: over ? [{ code: 'policy_transaction_limit_exceeded', detail: 'over the cap' }] : [], fee: { amount_usd: '0.05' } });
    if (over) return reply(409, { errors: [{ code: 'policy_transaction_limit_exceeded' }] });
    const b = s.conf.find((x) => x.asset_id === body.asset);
    b.available_raw = String(BigInt(b.available_raw) - BigInt(body.amount));
    return reply(202, { correlation_id: `op_w${s.withdrawals.length}` });
  }

  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url, 'https://wakeless.example');
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    const headers = init.headers ?? {};
    s.log.push({ method, href: u.href, body });
    if (u.origin === 'https://1click.chaindefuser.com') {
      if (u.pathname === '/v0/tokens') return reply(200, ONE_CLICK_TOKENS);
      const dep = s.deposits.find((d) => d.address.toLowerCase() === u.searchParams.get('depositAddress')?.toLowerCase());
      if (!dep) return reply(404, { message: 'Deposit address not found' });
      return reply(200, { correlationId: 'c1', status: 'PENDING_DEPOSIT', quoteResponse: { quote: { depositAddress: dep.address, amountIn: dep.amount }, quoteRequest: { originAsset: dep.asset, amount: dep.amount, recipient: s.near } } });
    }
    const p = u.pathname.replace(/^\/api\/agent/, '');
    const agent = `/v1/agents/${s.agentId}`;
    if (method === 'GET' && p === '/v1/tokens') return reply(200, s.tokens);
    if (method === 'POST' && p === '/v1/generate-intent') return reply(200, generate(body));
    if (method === 'POST' && p === '/v1/submit-intent') return (submit(body), reply(200, { status: 'PROCESSING' }));
    if (method === 'GET' && p === '/v1/status') {
      const id = u.searchParams.get('correlation_id');
      if (id.startsWith('intent_')) return reply(200, { correlation_id: id, status: 'SUCCESS', agent_id: s.agentId });
      if (id.startsWith('op_dep')) return reply(200, { correlation_id: id, status: 'PENDING_DEPOSIT' });
      return reply(200, { correlation_id: id, status: 'SUCCESS', details: { tx_hash: `0x${'ef'.repeat(32)}` } });
    }
    if (method === 'GET' && p === agent) return reply(200, { id: s.agentId, owner: s.owner, wallet: { near_account_id: s.near } });
    if (method === 'GET' && p === `${agent}/policy`) return reply(200, { revision: 1, status: 'APPLIED', policy: { ...s.policy, frozen: s.frozen } });
    if (method === 'GET' && p === `${agent}/balances`) return reply(200, { balances: u.searchParams.get('source') === 'public' ? s.pub : s.conf });
    if (method === 'POST' && p === `${agent}/deposit`) {
      s.deposits.push({ address: DEPOSIT, amount: body.amount, asset: body.origin_asset });
      return reply(200, { correlation_id: `op_dep${s.deposits.length}`, details: { action: 'cross_chain_deposit', deposit_address: DEPOSIT, memo: null, amount: body.amount, min_amount: body.amount, request: JSON.stringify({ origin_asset: body.origin_asset, amount: body.amount, confidential: true }), confidential: 'true', near_account_id: s.near, expires_at: new Date(Date.now() + 3 * 86_400_000).toISOString(), refund_to: s.near } });
    }
    if (method === 'POST' && p === `${agent}/withdraw`) return withdraw(body, headers);
    if (method === 'POST' && p === `${agent}/swap`) return reply(200, { quote: { amount_out: '1' }, warnings: [] });
    return reply(404, { errors: [{ code: 'not_found', detail: `${method} ${p}` }] });
  };
  return s;
}

// ---------- driving the page ----------

const until = async (fn, ms = 4_000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};

function desk(t, { store, ticket = { ...SPEC }, workOrder } = {}) {
  const dom = installDom(store);
  const live = createLive({ ticket: () => ticket, contractOf, lockTicket: () => {}, workOrder: workOrder ?? (async () => [{ type: 'done' }]) });
  t.after(() => live.hide());
  const saved = () => JSON.parse(dom.store.get('wakeless.live.v1') ?? 'null');
  return { ...dom, live, ticket, saved };
}

/** A visitor who connects, names the receive address and creates the wallet. */
async function created(t, api, opts = {}) {
  const d = desk(t, opts);
  const wallet = fakeWallet();
  await d.live.show();
  await d.$('#live-connect').click();
  d.$('#live-receive').value = SOL_ADDR;
  await d.$('#live-receive').fire('input');
  await d.$('#live-create').click();
  return { ...d, wallet, api };
}

/** The same browser after a reload: a new page on the same localStorage. */
async function reload(t, d, { connect = false } = {}) {
  d.live.hide();
  const next = desk(t, { store: d.store, workOrder: d.workOrder });
  await next.live.show();
  if (connect) await next.$('#live-connect').click();
  return { ...next, wallet: d.wallet, api: d.api };
}

// ---------- planners ----------

test('a return is split into parts the per-transaction limit allows', () => {
  assert.deepEqual(planChunks(10n, 4n), [4n, 3n, 3n]);
  assert.deepEqual(planChunks(8n, 4n), [4n, 4n]);
  assert.deepEqual(planChunks(3n, 4n), [3n]);
  assert.deepEqual(planChunks(10n, null), [10n]);
  assert.deepEqual(planChunks(0n, 4n), []);
});

test('a funded wallet works what it holds, within the signed caps', () => {
  const tokens = toDeskTokens(AGENT_TOKENS);
  const full = planRemainder({ spec: SPEC, tokens, balance: ORDER.totalUnits, perSwap: CAP.perSwap, perDay: CAP.perDay });
  assert.equal(full.totalUnits, ORDER.totalUnits);
  assert.equal(full.slices, SPEC.slices);
  const part = planRemainder({ spec: SPEC, tokens, balance: ORDER.totalUnits / 3n, perSwap: CAP.perSwap, perDay: CAP.perDay });
  assert.equal(part.totalUnits, ORDER.totalUnits / 3n);
  assert.ok(part.slices >= 2 && largestPossibleSlice({ total: part.totalUnits, slices: part.slices, sizeJitter: part.sizeJitter }) <= CAP.perSwap);
  const extra = planRemainder({ spec: SPEC, tokens, balance: ORDER.totalUnits * 2n, perSwap: CAP.perSwap, perDay: CAP.perDay });
  assert.equal(extra.totalUnits, CAP.perDay, 'never more than the signed daily limit');
});

// ---------- the page ----------

test('create checks every intent, reads the rules back and checks the deposit answer', async (t) => {
  const api = fakeApi();
  const d = await created(t, api);
  assert.equal(d.$('#live-error').textContent, '');
  assert.deepEqual(api.generated, ['agent_create', 'grant_issue']);
  assert.equal(d.wallet.count('eth_signTypedData_v4'), 2);
  const saved = d.saved();
  assert.equal(saved.agentId, api.agentId);
  assert.equal(saved.nearAccount, api.near);
  assert.equal(saved.deposit.address, DEPOSIT);
  assert.equal(d.$('#live-deposit').textContent, DEPOSIT);
  assert.equal(d.$('#live-send-wallet').hidden, false);
  assert.match(d.$('#live-summary').textContent, /About to sign/);
  assert.match(d.$('#live-rules').textContent, /Read back from the wallet itself/);
  const list = JSON.parse(d.store.get('wakeless.live.agents.v1'));
  assert.equal(list[0].agentId, api.agentId, 'the agent id joins the append-only list');
});

test('a changed policy, grant or applied rule stops the flow before the wallet signs or funds it', async (t) => {
  const preview = fakeApi();
  preview.evil.generate = (g, req) => {
    if (req.type === 'agent_create') g.preview.policy.destinations.list.push({ action: 'withdraw', chain: 'base', address: ATTACKER, memo: null });
  };
  const a = await created(t, preview);
  assert.match(a.$('#live-error').textContent, /not asked to sign/);
  assert.equal(a.wallet.count('eth_signTypedData_v4'), 0);
  assert.equal(a.saved(), null);

  const grant = fakeApi();
  grant.evil.inner = (inner, req) => {
    if (req.type === 'grant_issue') Object.assign(inner, { credential: 'ff'.repeat(32), expires_at_ms: Date.now() + 365 * 86_400_000 });
  };
  const b = await created(t, grant);
  assert.match(b.$('#live-error').textContent, /credential/);
  assert.equal(b.wallet.count('eth_signTypedData_v4'), 1, 'only the honest create was signed');
  assert.equal(grant.deposits.length, 0);

  const applied = fakeApi();
  applied.evil.applied = (p) => ({ ...p, native: { evm: { sign_typed_data: [], sign_message: false, sign_transaction: true } } });
  const c = await created(t, applied);
  assert.match(c.$('#live-error').textContent, /not the ones you signed/);
  assert.deepEqual(applied.generated, ['agent_create'], 'no grant is asked for');
  assert.equal(applied.deposits.length, 0, 'no deposit address is asked for');
  assert.equal(c.saved().agentId, applied.agentId, 'the wallet is still saved, so it can be frozen');
  assert.equal(c.$('#live-fund').hidden, true);
});

test('Send from this wallet pins the chain, is remembered, and needs a warning to repeat', async (t) => {
  const api = fakeApi();
  const d = await created(t, api);
  await d.$('#live-send-wallet').click();
  const sends = d.wallet.calls.filter((c) => c.method === 'eth_sendTransaction');
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].params[0], { from: KEYS[0].address, to: DEPOSIT, value: `0x${ORDER.totalUnits.toString(16)}`, chainId: '0x2105' });
  assert.equal(d.saved().deposit.sent.chainId, 8453);
  assert.equal(d.$('#live-send-wallet').hidden, true);
  assert.equal(d.$('#live-send-again').hidden, false);

  const r = await reload(t, d, { connect: true });
  assert.equal(r.$('#live-send-wallet').hidden, true, 'still hidden after a reload');
  assert.match(r.$('#live-sent').textContent, /Sent: .*Waiting for the transfer/);
  r.answer = false;
  await r.$('#live-send-again').click();
  assert.equal(r.wallet.count('eth_sendTransaction'), 1, 'declining the warning sends nothing');
  assert.match(r.confirms.at(-1), /expects the amount once/);
});

test('Withdraw, Return and Freeze stay after a price rise or with no price at all', async (t) => {
  const api = fakeApi();
  const d = await created(t, api);
  api.conf = [{ asset_id: SELL, available_raw: String(ORDER.totalUnits / 2n) }, { asset_id: BUY, available_raw: '30000000' }];
  for (const price of [2500 * 1.03, null]) {
    api.tokens[0].price = price;
    const r = await reload(t, d);
    assert.equal(r.$('#live-withdraw').hidden, false, `withdraw at ${price}`);
    assert.equal(r.$('#live-return').hidden, false, `return at ${price}`);
    assert.equal(r.$('#live-freeze').hidden, false, `freeze at ${price}`);
    assert.doesNotMatch(r.$('#live-rules').textContent, /capped at/);
  }
});

test('Return goes out in parts within the per-transaction limit, each with its own key', async (t) => {
  const api = fakeApi();
  const d = await created(t, api);
  api.conf = [{ asset_id: SELL, available_raw: String(ORDER.totalUnits) }];
  await d.live.show();
  const parts = planChunks(ORDER.totalUnits, CAP.perSwap).length;
  assert.ok(parts >= 2, 'one slice is less than the order');
  assert.match(d.$('#live-return').textContent, new RegExp(`in ${parts} parts`));
  await d.$('#live-return').click();
  assert.equal(d.$('#live-error').textContent, '');
  const live = api.withdrawals.filter((w) => !w.dry);
  assert.equal(live.length, parts);
  assert.ok(live.every((w) => w.amount <= CAP.perSwap));
  assert.equal(live.reduce((a, w) => a + w.amount, 0n), ORDER.totalUnits);
  assert.equal(new Set(api.withdrawals.map((w) => w.key)).size, api.withdrawals.length, 'every preview and send has its own key');
  assert.match(d.$('#live-out').textContent, /Withdrawn: 0.01 ETH/);
});

test('a resumed wallet works its balance, and Stop ends the run before the next slice', async (t) => {
  const api = fakeApi();
  const runs = [];
  const workOrder = async ({ order, client }) => {
    runs.push(order);
    for (;;) {
      await client.quote({ originAsset: order.sell.assetId, destinationAsset: order.buy.assetId, amount: 1n });
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const d = await created(t, api, { workOrder });
  d.workOrder = workOrder;
  api.conf = [{ asset_id: SELL, available_raw: String(ORDER.totalUnits / 2n) }];
  const r = await reload(t, d, { connect: true });
  assert.equal(r.$('#live-run').disabled, false, 'a partly funded wallet can run after a reload');
  const run = r.$('#live-run').click();
  await until(() => !r.$('#live-stop').hidden || r.$('#live-error').textContent !== '');
  assert.equal(r.$('#live-error').textContent, '');
  assert.equal(r.$('#live-freeze').disabled, false, 'freeze stays open during a run');
  await r.$('#live-stop').click();
  await run;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].totalUnits, ORDER.totalUnits / 2n);
  assert.deepEqual(api.generated, ['agent_create', 'grant_issue', 'grant_issue'], 'the reloaded tab signed a fresh grant for the run');
  assert.match(r.$('#live-run-hint').textContent, /Stopped before the next slice/);
  assert.equal(r.$('#live-stop').hidden, true);
});

test('Freeze works during a run and follows the state the wallet reports', async (t) => {
  const api = fakeApi();
  const workOrder = async ({ client }) => {
    for (;;) {
      await client.quote({});
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const d = await created(t, api, { workOrder });
  api.conf = [{ asset_id: SELL, available_raw: String(ORDER.totalUnits) }];
  const run = d.$('#live-run').click();
  await until(() => !d.$('#live-stop').hidden);
  await d.$('#live-freeze').click();
  await run;
  assert.equal(api.frozen, true);
  assert.match(d.$('#live-run-hint').textContent, /Frozen/);

  api.frozen = false;
  const r = await reload(t, d, { connect: true });
  assert.equal(r.$('#live-freeze').textContent, 'Freeze the wallet');
  api.frozen = true;
  const again = await reload(t, r, { connect: true });
  assert.equal(again.$('#live-freeze').textContent, 'Unfreeze the wallet', 'frozen elsewhere: the page reads it fresh');
  await again.$('#live-freeze').click();
  assert.equal(api.generated.at(-1), 'agent_unfreeze');
});

test('signing is pinned to the owner account, and a reconnect drops the old listener', async (t) => {
  const api = fakeApi();
  const d = await created(t, api);
  const typed = d.wallet.count('eth_signTypedData_v4');
  d.wallet.provider.use(1);
  d.live.render();
  assert.equal(d.$('#live-freeze').disabled, true);
  assert.match(d.$('#live-foot-hint').textContent, /owner wallet/);
  await d.$('#live-freeze').click();
  assert.match(d.$('#live-error').textContent, /not 0x/);
  assert.equal(d.wallet.count('eth_signTypedData_v4'), typed, 'nothing was signed by the other account');
  d.wallet.provider.use(0);
  await d.$('#live-connect').click();
  assert.equal(d.wallet.provider.listeners.accountsChanged.length, 1);
});

test('a wallet file is a pointer: the page checks the wallet itself and never takes an address from it', async (t) => {
  const api = fakeApi();
  const first = await created(t, api);
  const owner = KEYS[0].address;
  const fileFor = (patch = {}) => {
    const text = JSON.stringify({ agent_id: api.agentId, owner, receive: { chain: 'sol', address: SOL_ADDR }, refund: { chain: 'base', address: owner }, order: SPEC, deposit: { address: ATTACKER, amount: '1000000000000000000' }, ...patch });
    return { size: text.length, text: async () => text };
  };
  first.live.hide();
  const d = desk(t);
  await d.live.show();
  await d.$('#live-connect').click();
  const load = async (file) => {
    d.$('#live-load').files = [file];
    await d.$('#live-load').fire('change');
    await until(() => !d.$('#live-connect').disabled && d.$('#live-error').textContent !== '' || Boolean(d.saved()));
    await new Promise((r) => setTimeout(r, 30));
  };

  await load(fileFor({ receive: { chain: 'sol', address: '11111111111111111111111111111112' } }));
  assert.match(d.$('#live-error').textContent, /do not match the file/);
  assert.equal(d.saved(), null);

  await load(fileFor());
  assert.equal(d.$('#live-error').textContent, '');
  assert.equal(d.saved().agentId, api.agentId);
  assert.equal(d.saved().deposit, null, 'the deposit in the file is ignored');
  assert.doesNotMatch(d.$('#live-deposit').textContent, /ba/);
  assert.equal(d.$('#live-get-deposit').hidden, false, 'a fresh address is one click away');
  assert.equal(first.wallet.count('eth_sendTransaction'), 0);

  d.answer = false;
  await load(fileFor({ agent_id: 'cd'.repeat(32) }));
  assert.match(d.confirms.at(-1), /Replace the agent wallet/);
  assert.equal(d.saved().agentId, api.agentId, 'declined: the saved wallet stays');

  api.owner = { ...api.owner, address: KEYS[1].address };
  localStorage.removeItem('wakeless.live.v1');
  await load(fileFor());
  assert.match(d.$('#live-error').textContent, /another owner/);
});

test('an auto-filled address leaves when the chain changes, and 0x on NEAR is flagged', async (t) => {
  fakeApi();
  const d = desk(t, { ticket: { ...SPEC, sell: 'sol:sol', buy: 'eth:base', amount: '0.1' } });
  fakeWallet();
  await d.live.show();
  await d.$('#live-connect').click();
  assert.equal(d.$('#live-receive').value, KEYS[0].address);
  d.ticket.buy = 'wnear:near';
  d.live.render();
  assert.equal(d.$('#live-receive').value, '', 'the EVM address does not stay as a NEAR account');
  d.$('#live-receive').value = KEYS[0].address;
  d.live.render();
  assert.match(d.$('#live-receive-hint').textContent, /only an EVM wallet/);
});
