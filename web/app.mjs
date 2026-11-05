// Wakeless web desk. Runs the same engine as the command line, in the browser,
// against the public 1Click API (it allows cross-origin requests). No keys and
// no wallet: quotes are live, fills are simulated.
import { createOneClick, intentsQuoteBody, normalizeQuote } from '../src/oneclick.mjs';
import { prepareOrder } from '../src/order.mjs';
import { runOrder } from '../src/engine.mjs';
import { dryExecutor } from '../src/executors/dry.mjs';
import { realClock } from '../src/clock.mjs';
import { buildReport } from '../src/report.mjs';
import { mulberry32 } from '../src/rng.mjs';
import { resolveAsset } from '../src/assets.mjs';
import { memoryJournal, parseJsonl, toJsonl } from '../src/memory-journal.mjs';
import { toNumber } from '../src/units.mjs';
import { startWater } from './water.mjs';

const SAMPLE_RUN = '../examples/sample-run.jsonl';
const LIVE_RUN = '../examples/live-run.jsonl';
const LIVE_CHAIN = '../examples/live-run-chain.json';
const BASESCAN_TX = 'https://basescan.org/tx/';
const PRIVACY_SNAPSHOT = '../research/confidential/usdc-arb_sol-sol_2026-11-05t03-37-19-519z.json';
const IMPACT_SIZES = [1_000, 10_000, 50_000, 100_000, 250_000, 500_000, 1_000_000];
const ASSETS = ['usdc:arb', 'usdc:eth', 'usdc:base', 'usdc:sol', 'usdt:eth', 'usdt:tron', 'eth:eth', 'eth:arb', 'eth:base', 'sol:sol', 'btc:btc', 'wnear:near', 'zec:zec'];
const CHAINS = { arb: 'Arbitrum', eth: 'Ethereum', base: 'Base', sol: 'Solana', tron: 'Tron', btc: 'Bitcoin', near: 'NEAR', zec: 'Zcash' };
const DRY_ACCOUNT = 'dry-run.wakeless.near';

const $ = (selector) => document.querySelector(selector);
const SVG = 'http://www.w3.org/2000/svg';
const client = createOneClick();
const state = { tokens: null, busy: false, impactBusy: false, targetUsd: 500_000, lastRun: null };

// ---------- small helpers ----------

function svg(tag, attrs = {}, parent) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (parent) parent.appendChild(node);
  return node;
}

function html(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const num = (value, digits = 2) =>
  value == null || !Number.isFinite(value)
    ? '-'
    : value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const signed = (value, digits = 1) => (value == null || !Number.isFinite(value) ? '-' : `${value >= 0 ? '+' : ''}${num(value, digits)}`);
const mmss = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const usdShort = (usd) => (usd >= 1e6 ? `$${usd / 1e6}M` : `$${usd / 1e3}k`);
const chainName = (id) => CHAINS[id] ?? id.toUpperCase();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const human = (units, decimals) => toNumber(BigInt(units), decimals);
const compact = (value) =>
  value >= 1e6 ? `${num(value / 1e6, 1)}M` : value >= 1e3 ? `${num(value / 1e3, value >= 1e4 ? 0 : 1)}k` : num(value, value >= 10 ? 0 : 2);
const digitsFor = (price) => (price >= 1000 ? 4 : price >= 10 ? 3 : price >= 0.5 ? 2 : 0);

// ---------- status, assets, ticket ----------

/** `wide` is extra text that narrow screens drop (see .status .wide). */
function setStatus(kind, text, wide = '') {
  $('#status').dataset.state = kind;
  const node = $('#status-text');
  node.textContent = text;
  if (wide) node.append(html('span', { class: 'wide', text: wide }));
}

function populateAssets(tokens) {
  const sell = $('#sell');
  const buy = $('#buy');
  sell.textContent = '';
  buy.textContent = '';
  for (const ref of ASSETS) {
    let asset;
    try {
      asset = resolveAsset(tokens, ref);
    } catch {
      continue;
    }
    const label = `${asset.symbol} on ${chainName(asset.blockchain)}`;
    sell.append(html('option', { value: ref, text: label }));
    buy.append(html('option', { value: ref, text: label }));
  }
  sell.value = 'usdc:arb';
  buy.value = 'sol:sol';
}

function selected(which) {
  return resolveAsset(state.tokens, $(which).value);
}

function setAmountFromUsd(usd) {
  state.targetUsd = usd;
  if (!state.tokens) return;
  const sell = selected('#sell');
  // Stablecoins are entered at face value; everything else converts at the 1Click price.
  const amount = Math.abs(sell.price - 1) < 0.01 ? usd : usd / sell.price;
  $('#amount').value = String(Number(amount.toFixed(digitsFor(sell.price))));
  syncAmountHint();
}

function syncAmountHint() {
  if (!state.tokens) return;
  const sell = selected('#sell');
  $('#amount-unit').textContent = sell.symbol;
  const amount = Number($('#amount').value);
  $('#amount-usd').textContent = Number.isFinite(amount) && amount > 0 ? `about $${num(amount * sell.price, 0)}` : 'enter an amount';
  for (const chip of document.querySelectorAll('#chips button')) {
    const usd = Number(chip.dataset.usd);
    chip.setAttribute('aria-pressed', String(Math.abs(usd - amount * sell.price) / usd < 0.005));
  }
}

function currentSpeed() {
  return Number(document.querySelector('input[name="speed"]:checked')?.value ?? 60);
}

function currentSpec() {
  return {
    id: `web-${Date.now().toString(36)}`,
    sell: $('#sell').value,
    buy: $('#buy').value,
    amount: $('#amount').value.trim().replace(/,/g, ''),
    slices: Number($('#slices').value),
    horizonMinutes: Number($('#window').value),
    maxAdverseBps: Number($('#adverse').value),
    maxDefers: 2,
    minSliceUsd: 1000,
    deskAccount: DRY_ACCOUNT,
  };
}

function showError(message) {
  $('#ticket-error').textContent = message;
}

function setBusy(busy, label) {
  state.busy = busy;
  const run = $('#run');
  run.classList.toggle('busy', busy);
  run.disabled = busy;
  run.querySelector('.run-label').textContent = busy ? label : 'Work this order';
  for (const id of ['#replay', '#replay-top']) $(id).disabled = busy;
}

function wireTicket() {
  $('#ticket').addEventListener('submit', (event) => {
    event.preventDefault();
    runLive();
  });
  for (const id of ['#replay', '#replay-top']) $(id).addEventListener('click', replay);
  $('#sell').addEventListener('change', () => {
    setAmountFromUsd(state.targetUsd);
    onPairChange();
  });
  $('#buy').addEventListener('change', onPairChange);
  $('#flip').addEventListener('click', () => {
    const sell = $('#sell').value;
    $('#sell').value = $('#buy').value;
    $('#buy').value = sell;
    setAmountFromUsd(state.targetUsd);
    onPairChange();
  });
  $('#amount').addEventListener('input', () => {
    if (state.tokens) state.targetUsd = Number($('#amount').value) * selected('#sell').price || state.targetUsd;
    syncAmountHint();
    renderChain();
  });
  for (const chip of document.querySelectorAll('#chips button')) {
    chip.addEventListener('click', () => {
      setAmountFromUsd(Number(chip.dataset.usd));
      renderChain();
    });
  }
  $('#slices').addEventListener('input', () => {
    $('#slices-out').textContent = $('#slices').value;
    renderChain();
  });
  $('#window').addEventListener('change', renderChain);
  $('#adverse').addEventListener('input', () => {
    $('#adverse-out').textContent = `${$('#adverse').value} bps`;
  });
  $('#impact-refresh').addEventListener('click', measureImpact);
}

function onPairChange() {
  showError('');
  if (!state.tokens) return;
  const sell = selected('#sell');
  const buy = selected('#buy');
  $('#impact-pair').textContent = `${sell.symbol} on ${chainName(sell.blockchain)} to ${buy.symbol} on ${chainName(buy.blockchain)}`;
  $('#impact-refresh').disabled = state.impactBusy;
  $('#impact-note').textContent = 'Pair changed. Press "Measure again" for live quotes on this pair.';
  renderChain();
}

// ---------- hero chart: price impact by size ----------

function drawImpact(results, { final }) {
  const root = $('#impact-chart');
  root.textContent = '';
  const W = 560;
  const H = 290;
  const L = 44;
  const R = 8;
  const T = 26;
  const B = 34;
  const plotW = W - L - R;
  const plotH = H - T - B;
  const band = plotW / IMPACT_SIZES.length;
  const ok = results.filter((r) => r.q.ok);
  const base = ok.length ? ok[0].q.costBps : 0;
  const extras = ok.map((r) => r.q.costBps - base);
  const yMax = Math.max(10, Math.ceil(Math.max(0, ...extras) / 10) * 10);
  const y = (bps) => T + plotH - (Math.max(0, bps) / yMax) * plotH;

  const grid = svg('g', { class: 'grid axis' }, root);
  for (const tick of [0, yMax / 2, yMax]) {
    svg('line', { x1: L, x2: W - R, y1: y(tick), y2: y(tick) }, grid);
    svg('text', { x: L - 8, y: y(tick) + 4, 'text-anchor': 'end' }, grid).textContent = tick === 0 ? '0' : `+${tick}`;
  }
  svg('text', { x: L - 8, y: T - 12, 'text-anchor': 'end' }, grid).textContent = 'bps';

  IMPACT_SIZES.forEach((usd, i) => {
    const cx = L + band * (i + 0.5);
    const bw = band * 0.56;
    const r = results.find((x) => x.usd === usd);
    const axis = svg('text', { x: cx, y: H - 12, 'text-anchor': 'middle', class: 'axis' }, root);
    axis.textContent = usdShort(usd);
    if (!r) {
      svg('rect', { x: cx - bw / 2, y: T, width: bw, height: plotH, rx: 4, class: 'bar-pending' }, root);
      return;
    }
    if (!r.q.ok) {
      svg('rect', { x: cx - bw / 2, y: T, width: bw, height: plotH, rx: 4, class: final ? 'bar none' : 'bar-pending' }, root);
      const label = svg('text', { x: cx, y: T - 8, 'text-anchor': 'middle', class: 'bar-label none' }, root);
      label.textContent = r.q.noLiquidity ? 'no quote' : `HTTP ${r.q.status}`;
      return;
    }
    const extra = r.q.costBps - base;
    const top = Math.min(y(extra), T + plotH - 2);
    if (final) {
      svg('rect', { x: cx - bw / 2, y: top, width: bw, height: T + plotH - top, rx: 4, class: i === 0 ? 'bar base' : 'bar', style: `animation-delay:${i * 70}ms` }, root);
    } else {
      svg('rect', { x: cx - bw / 2, y: T, width: bw, height: plotH, rx: 4, class: 'bar-pending', style: 'fill: rgba(94,224,193,0.10)' }, root);
    }
    const label = svg('text', { x: cx, y: (final ? top : T) - 8, 'text-anchor': 'middle', class: 'bar-label' }, root);
    label.textContent = i === 0 ? 'base' : signed(extra, 1);
  });
}

async function measureImpact() {
  if (state.impactBusy || !state.tokens) return;
  state.impactBusy = true;
  $('#impact-refresh').disabled = true;
  const sell = selected('#sell');
  const buy = selected('#buy');
  $('#impact-pair').textContent = `${sell.symbol} on ${chainName(sell.blockchain)} to ${buy.symbol} on ${chainName(buy.blockchain)}`;
  const results = [];
  drawImpact(results, { final: false });
  for (const usd of IMPACT_SIZES) {
    $('#impact-note').textContent = `Quoting ${usdShort(usd)} through 1Click.`;
    const amount = BigInt(Math.round((usd / sell.price) * 10 ** sell.decimals));
    const body = intentsQuoteBody({ sellAsset: sell.assetId, buyAsset: buy.assetId, amount, account: DRY_ACCOUNT });
    const res = await client.quote(body);
    results.push({ usd, q: normalizeQuote(res, { sellDecimals: sell.decimals, buyDecimals: buy.decimals, amountIn: amount }) });
    drawImpact(results, { final: false });
  }
  drawImpact(results, { final: true });
  const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const okCount = results.filter((r) => r.q.ok).length;
  $('#impact-note').textContent = okCount
    ? `Live 1Click quotes at ${time}. Each includes the same platform fee, which cancels out against the $1k base.`
    : `1Click returned no quotes for this pair at ${time}.`;
  state.impactBusy = false;
  $('#impact-refresh').disabled = false;
}

// ---------- execution monitor ----------

function startMonitor({ speed }) {
  const root = $('#timeline');
  const tape = $('#tape');
  const result = $('#result');
  const body = document.querySelector('.monitor-body');
  root.textContent = '';
  tape.textContent = '';
  result.hidden = true;
  result.textContent = '';
  body.classList.remove('has-result');
  $('#monitor-empty').hidden = true;
  setStep('arrival');

  const W = 720;
  const H = 230;
  const L = 52;
  const R = 12;
  const T = 14;
  const B = 30;
  const plotW = W - L - R;
  const plotH = H - T - B;
  let order = null;
  let maxAmount = 1;
  let horizon = 1;
  let lastT = 0;
  let lastWall = performance.now();
  let raf = 0;
  let nowLine = null;
  let bars = null;
  const waits = new Map();

  const x = (t) => L + (Math.min(Math.max(t, 0), horizon) / horizon) * plotW;
  const h = (units) => (human(units, order.sell.decimals) / maxAmount) * plotH;
  const barWidth = () => Math.max(4, Math.min(20, (plotW / order.slices) * 0.42));

  function axes() {
    const g = svg('g', { class: 'tl grid axis' }, root);
    const minutes = horizon / 60_000;
    const step = [1, 2, 5, 10, 15, 30, 60].find((s) => minutes / s <= 7) ?? 60;
    for (let m = 0; m <= minutes + 1e-9; m += step) {
      const px = x(m * 60_000);
      svg('line', { x1: px, x2: px, y1: T, y2: T + plotH }, g);
      svg('text', { x: px, y: H - 10, 'text-anchor': 'middle' }, g).textContent = `${m}m`;
    }
    for (const frac of [0.5, 1]) {
      const py = T + plotH - frac * plotH;
      svg('text', { x: L - 8, y: py + 4, 'text-anchor': 'end' }, g).textContent = compact(maxAmount * frac);
    }
    svg('line', { x1: L, x2: W - R, y1: T + plotH, y2: T + plotH, stroke: 'rgba(233,238,244,0.2)' }, g);
    bars = svg('g', { class: 'tl' }, root);
    nowLine = svg('line', { class: 'tl now', x1: L, x2: L, y1: T - 4, y2: T + plotH }, root);
  }

  function tick() {
    raf = requestAnimationFrame(tick);
    if (!order) return;
    const now = Math.min(horizon, lastT + (performance.now() - lastWall) * speed);
    nowLine.setAttribute('x1', x(now));
    nowLine.setAttribute('x2', x(now));
    $('#clock').textContent = `${mmss(now)} / ${mmss(horizon)}`;
  }

  function addRow({ t, what, px, tag, cls, info }) {
    const row = html('li', { class: info ? 'info' : '' }, [
      html('span', { class: 't', text: t == null ? '' : mmss(t) }),
      html('span', { class: 'what', text: what }),
      info ? null : html('span', { class: 'px', text: px ?? '' }),
      info ? null : html('span', { class: `tag ${cls}`, text: tag }),
    ]);
    tape.prepend(row);
  }

  function drawBar(t, units, cls) {
    const bw = barWidth();
    const height = Math.max(2, h(units));
    return svg('rect', { x: x(t) - bw / 2, y: T + plotH - height, width: bw, height, rx: 3, class: `${cls} pop` }, bars);
  }

  function onEvent(event) {
    lastT = event.t ?? lastT;
    lastWall = performance.now();
    switch (event.type) {
      case 'order': {
        order = event.order;
        horizon = order.horizonMs;
        maxAmount = Math.max(...event.schedule.map((s) => human(s.amount, order.sell.decimals))) * 1.15;
        axes();
        for (const s of event.schedule) {
          const bw = barWidth();
          const height = Math.max(2, h(s.amount));
          svg('rect', { x: x(s.atMs) - bw / 2, y: T + plotH - height, width: bw, height, rx: 3, class: 'ghost', id: `ghost-${s.index + 1}` }, bars);
        }
        addRow({
          info: true,
          what: `Order: ${num(Number(order.amount), 2)} ${order.sell.symbol} on ${chainName(order.sell.blockchain)} for ${order.buy.symbol} on ${chainName(order.buy.blockchain)}, ${order.slices} slices over ${mmss(horizon)}. Seed ${event.seed}.`,
        });
        raf = requestAnimationFrame(tick);
        break;
      }
      case 'arrival': {
        setStep('working');
        const p = event.probe.q;
        const o = event.oneShot.q;
        const probe = p.ok ? `one slice-sized swap costs ${num(p.costBps, 1)} bps` : `slice-sized quote failed (${p.message})`;
        const whole = o.ok ? `the whole order in one swap costs ${num(o.costBps, 1)} bps` : `the whole order in one swap gets no quote (${o.message})`;
        addRow({ t: 0, info: true, what: `Arrival: ${probe}; ${whole}.` });
        break;
      }
      case 'slice': {
        const { slice, decision, quote } = event;
        const q = quote.q;
        const size = `Slice ${slice.id}, ${num(human(slice.amount, order.sell.decimals), 2)} ${order.sell.symbol}`;
        const px = q.ok ? `${num(q.costBps, 1)} bps` : q.message;
        const baseId = slice.id.replace(/[ab]+$/, '');
        const ghost = root.querySelector(`#ghost-${baseId}`);
        if (decision.action === 'execute') {
          if (ghost && slice.id === baseId) ghost.remove();
          const bar = drawBar(event.t, slice.amount, 'fill');
          const wait = waits.get(slice.id);
          if (wait) {
            svg('path', { class: 'link', d: `M${wait.x} ${wait.y} Q${(wait.x + Number(bar.getAttribute('x'))) / 2} ${Math.min(wait.y, Number(bar.getAttribute('y'))) - 18} ${Number(bar.getAttribute('x')) + barWidth() / 2} ${bar.getAttribute('y')}` }, bars);
          }
          addRow({ t: event.t, what: size, px, tag: 'filled', cls: 'fill' });
        } else if (decision.action === 'defer') {
          const bar = drawBar(event.t, slice.amount, 'wait');
          waits.set(slice.id, { x: Number(bar.getAttribute('x')) + barWidth() / 2, y: Number(bar.getAttribute('y')) });
          addRow({ t: event.t, what: size, px, tag: 'waited', cls: 'wait' });
        } else if (decision.action === 'split') {
          if (ghost) ghost.remove();
          drawBar(event.t, slice.amount, 'split');
          addRow({ t: event.t, what: size, px, tag: 'split', cls: 'split' });
        } else {
          if (ghost && slice.id === baseId) ghost.remove();
          drawBar(event.t, slice.amount, 'skip');
          addRow({ t: event.t, what: size, px, tag: 'unfilled', cls: 'skip' });
        }
        break;
      }
      case 'abort':
        addRow({ t: event.t, info: true, what: `Stopped: ${event.message}.` });
        break;
      default:
        break;
    }
  }

  function stop() {
    cancelAnimationFrame(raf);
    if (order) {
      nowLine?.setAttribute('x1', x(lastT));
      nowLine?.setAttribute('x2', x(lastT));
      $('#clock').textContent = `${mmss(lastT)} / ${mmss(horizon)}`;
    }
  }

  function finish(events) {
    stop();
    setStep('report');
    const report = buildReport(events);
    renderResult(report, events);
    body.classList.add('has-result');
    state.lastRun = report;
    renderChain();
  }

  function fail(message) {
    stop();
    addRow({ info: true, what: `Stopped: ${message}` });
  }

  return { onEvent, finish, fail };
}

function setStep(step) {
  const order = ['arrival', 'working', 'report'];
  const index = order.indexOf(step);
  for (const li of document.querySelectorAll('#stepper li')) {
    const i = order.indexOf(li.dataset.step);
    li.classList.toggle('active', i === index);
    li.classList.toggle('done', i < index);
  }
}

function renderResult(r, events) {
  const box = $('#result');
  box.textContent = '';
  box.hidden = false;
  const o = r.vsOneShot;
  const kicker = html('p', { class: 'kicker', text: r.mode === 'dry' ? 'Report, dry run' : 'Report' });
  let headline;
  let sub;
  if (r.aborted) {
    headline = html('h3', { class: 'headline worse' }, ['Stopped ', html('em', { text: 'before the first slice' })]);
    sub = html('p', { class: 'sub', text: r.abortMessage ?? '' });
  } else if (o.executable && o.deltaBps != null) {
    // Same measure as the CLI report and the README: what the slices received
    // against one swap of the whole order quoted at arrival.
    const more = o.deltaBps;
    headline = html('h3', { class: `headline${more < 0 ? ' worse' : ''}` }, [
      `${num(Math.abs(more), 1)} bps `,
      html('em', { text: more >= 0 ? 'more' : 'less' }),
      ` ${r.buy.symbol} than one swap`,
    ]);
    sub = html('p', {
      class: 'sub',
      text: `${signed(o.deltaBuy, 6)} ${r.buy.symbol}${o.deltaUsd != null ? `, about $${num(Math.abs(o.deltaUsd), 0)} ${o.deltaUsd >= 0 ? 'more' : 'less'}` : ''} for the same ${num(Number(r.filled), 2)} ${r.sell.symbol}.`,
    });
  } else {
    headline = html('h3', { class: 'headline' }, ['Filled ', html('em', { text: `${num(r.filledPct, 1)}%` }), '. One swap got no quote.']);
    sub = html('p', { class: 'sub', text: `1Click answered the whole ${num(Number(r.total), 2)} ${r.sell.symbol} with "${o.message}". The slices received ${num(Number(r.received), 6)} ${r.buy.symbol}.` });
  }
  box.append(kicker, headline, sub);

  if (!r.aborted) {
    const sliced = r.costs.executionCostBps;
    const one = o.executable ? o.costBps : null;
    const max = Math.max(sliced ?? 0, one ?? 0, 1);
    const row = (cls, label, value) =>
      html('div', { class: `cmp-row ${cls}` }, [
        html('span', { text: label }),
        html('div', { class: 'cmp-bar' }, html('i', { style: `width:${value == null ? 0 : (value / max) * 100}%` })),
        html('span', { class: 'v', text: value == null ? 'no quote' : `${num(value, 1)} bps` }),
      ]);
    box.append(html('div', { class: 'cmp' }, [row('one', 'One swap', one), row('sliced', `${r.slices.fills} slices`, sliced)]));

    const reasons = r.slices.reasons;
    const waited = (reasons.below_floor_wait ?? 0) + (reasons.no_liquidity_wait ?? 0) + (reasons.quote_failed_wait ?? 0);
    const stat = (value, label) => html('li', {}, [html('b', { text: value }), ` ${label}`]);
    box.append(
      html('ul', { class: 'stats' }, [
        stat(`${num(r.filledPct, 1)}%`, 'filled'),
        stat(String(r.slices.fills), 'fills'),
        stat(String(waited), 'waits'),
        stat(String(reasons.no_liquidity_split ?? 0), 'splits'),
        stat(String(r.slices.skips), 'unfilled'),
        stat(String(r.seed ?? '-'), 'seed'),
      ]),
    );
    box.append(html('p', { class: 'fineprint', text: 'Both costs are measured the same way and include the same 1Click platform fee. Dry run: each fill is simulated at its live quote.' }));
  }

  const download = html('button', { class: 'btn small', type: 'button', text: 'Download journal' });
  download.addEventListener('click', () => {
    const blob = new Blob([toJsonl(events)], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const a = html('a', { href: url, download: `${r.orderId}.jsonl` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const again = html('button', { class: 'btn small ghost', type: 'button', text: 'Run again' });
  again.addEventListener('click', runLive);
  box.append(html('div', { class: 'actions' }, [download, again]));
}

// ---------- runs ----------

function scrollToDesk() {
  const top = $('#desk').getBoundingClientRect().top + window.scrollY - 76;
  window.scrollTo({ top, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

async function runLive() {
  if (state.busy) return;
  showError('');
  if (!state.tokens) {
    showError('1Click is not reachable right now. The committed run can still be replayed.');
    return;
  }
  let order;
  try {
    order = prepareOrder(currentSpec(), state.tokens);
  } catch (err) {
    showError(err.message);
    return;
  }
  const speed = currentSpeed();
  const seed = crypto.getRandomValues(new Uint32Array(1))[0] >>> 1;
  const journal = memoryJournal();
  setBusy(true, 'Working the order');
  scrollToDesk();
  const view = startMonitor({ speed });
  try {
    await runOrder({ order, client, executor: dryExecutor(), clock: realClock({ speed }), journal, rand: mulberry32(seed), seed, onEvent: view.onEvent });
    view.finish(journal.events);
  } catch (err) {
    view.fail(err.message);
  } finally {
    setBusy(false);
  }
}

async function replay() {
  if (state.busy) return;
  showError('');
  setBusy(true, 'Replaying');
  scrollToDesk();
  try {
    const res = await fetch(SAMPLE_RUN);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const events = parseJsonl(await res.text());
    const speed = currentSpeed();
    const view = startMonitor({ speed });
    let previous = 0;
    for (const event of events) {
      const wait = ((event.t ?? previous) - previous) / speed;
      if (wait > 0) await sleep(wait);
      previous = event.t ?? previous;
      view.onEvent(event);
    }
    view.finish(events);
  } catch (err) {
    showError(`Could not replay the committed run: ${err.message}`);
  } finally {
    setBusy(false);
  }
}

// ---------- what the chain sees ----------

function renderChain() {
  const spec = currentSpec();
  const total = Number(spec.amount);
  if (!(total > 0)) return;
  const sellRef = state.tokens ? selected('#sell') : { symbol: 'USDC', blockchain: 'arb' };
  const buyRef = state.tokens ? selected('#buy') : { symbol: 'SOL', blockchain: 'sol' };
  const n = spec.slices;
  const windowMs = spec.horizonMinutes * 60_000;
  const each = total / n;
  const windowText = spec.horizonMinutes >= 60 ? `${spec.horizonMinutes / 60} hour${spec.horizonMinutes > 60 ? 's' : ''}` : `${spec.horizonMinutes} minutes`;
  $('#chain-order').textContent = `${num(total, 2)} ${sellRef.symbol} to ${buyRef.symbol} in ${n} slices over ${windowText}.`;

  const pub = $('#ledger-public');
  pub.textContent = '';
  const shown = Math.min(n, 5);
  for (let i = 0; i < shown; i++) {
    pub.append(
      html('li', {}, [
        html('span', { class: 't', text: mmss(((i + 0.5) * windowMs) / n) }),
        html('span', {}, [html('span', { class: 'addr', text: '0x7a3f...9c21' }), ` swaps ${sellRef.symbol} for ${buyRef.symbol}`]),
        html('span', { class: 'amt', text: `${num(each, 2)} ${sellRef.symbol}` }),
      ]),
    );
  }
  if (n > shown) pub.append(html('li', { class: 'more', text: `${n - shown} more swaps: same address, same size, every ${mmss(windowMs / n)}` }));

  const run = state.lastRun && !state.lastRun.aborted && state.lastRun.sell.symbol === sellRef.symbol && state.lastRun.buy.symbol === buyRef.symbol ? state.lastRun : null;
  const out = run ? `${num(Number(run.received), 4)} ${buyRef.symbol}` : `the ${buyRef.symbol}`;
  const quiet = $('#ledger-wakeless');
  quiet.textContent = '';
  quiet.append(
    html('li', {}, [
      html('span', { class: 't', text: '00:00' }),
      html('span', {}, [`Deposit ${num(total, 2)} ${sellRef.symbol} into NEAR Intents `, html('span', { class: 'pub', text: 'public' })]),
      html('span', { class: 'amt', text: chainName(sellRef.blockchain) }),
    ]),
    html('li', { class: 'sealed' }, [html('b', { text: `${n} slices, random sizes and times` }), 'Settled inside Confidential Intents balances. Not on a public ledger.']),
    html('li', {}, [
      html('span', { class: 't', text: mmss(windowMs) }),
      html('span', {}, [`Withdraw ${out} `, html('span', { class: 'pub', text: 'public' })]),
      html('span', { class: 'amt', text: chainName(buyRef.blockchain) }),
    ]),
  );
}

async function loadPrivacySnapshot() {
  try {
    const res = await fetch(PRIVACY_SNAPSHOT);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const snap = await res.json();
    const by = new Map();
    for (const row of snap.rows) {
      const out = row.response?.quote?.amountOut;
      if (!out) continue;
      if (!by.has(row.usd)) by.set(row.usd, {});
      by.get(row.usd)[row.mode] = Number(out) / 1e9;
    }
    const tbody = document.querySelector('#privacy-table tbody');
    tbody.textContent = '';
    const advanced = [];
    for (const [usd, v] of [...by.entries()].sort((a, b) => a[0] - b[0])) {
      if (v.public == null || v.basic == null) continue;
      const diff = (v.basic / v.public - 1) * 10_000;
      if (v.advanced != null) advanced.push((v.advanced / v.public - 1) * 10_000);
      tbody.append(
        html('tr', {}, [
          html('td', { text: `$${num(usd, 0)}` }),
          html('td', { text: `${num(v.public, 4)} SOL` }),
          html('td', { text: `${num(v.basic, 4)} SOL` }),
          html('td', { class: diff >= 0 ? 'good' : '', text: `${signed(diff, 2)} bps` }),
        ]),
      );
    }
    const when = new Date(snap.takenAt);
    const adv = advanced.length ? ` The advanced mode returned ${signed(Math.min(...advanced), 2)} to ${signed(Math.max(...advanced), 2)} bps against public.` : '';
    $('#privacy-when').textContent = `Snapshot of ${when.toISOString().slice(0, 16).replace('T', ' ')} UTC, confidentiality "basic". Positive means the confidential quote returned more SOL.${adv}`;
  } catch (err) {
    $('#privacy-when').textContent = `Snapshot unavailable: ${err.message}`;
  }
}

// ---------- live on mainnet ----------

const utc = (iso) => new Date(iso).toISOString().slice(11, 16);
const shortHash = (hash) => (hash.length > 16 ? `${hash.slice(0, 6)}...${hash.slice(-6)}` : hash);
const txLink = (hash) => html('a', { href: `${BASESCAN_TX}${hash}`, target: '_blank', rel: 'noopener', text: 'Base tx' });

/** The committed live run: its journal plus the public chain facts around it. */
async function loadLiveRun() {
  try {
    const [runRes, chainRes] = await Promise.all([fetch(LIVE_RUN), fetch(LIVE_CHAIN)]);
    if (!runRes.ok || !chainRes.ok) throw new Error(`HTTP ${runRes.ok ? chainRes.status : runRes.status}`);
    const events = parseJsonl(await runRes.text());
    const chain = await chainRes.json();
    const r = buildReport(events);
    const order = events.find((e) => e.type === 'order').order;
    const fills = events.filter((e) => e.type === 'fill' && BigInt(e.amountIn) > 0n);
    const sol = Number(chain.publicLedger.confidentialAtTheSameTime['nep141:sol.omft.near']) / 1e9;
    const first = fills[0];
    const last = fills[fills.length - 1];

    $('#live-summary').textContent =
      `${chain.deposit.amount} ETH on Base, worked into ${r.buy.symbol} in ${r.slices.fills} slices by a policy-bound agent on ` +
      `5 November 2026, then paid back to its owner. Real funds, settled on NEAR Intents.`;

    const ledger = $('#live-ledger');
    ledger.textContent = '';
    ledger.append(
      html('li', {}, [
        html('span', { class: 't', text: utc(chain.deposit.at) }),
        html('span', {}, [
          `Deposit ${chain.deposit.amount} ETH to the agent's address `,
          html('span', { class: 'pub' }, ['public, ', txLink(chain.deposit.tx)]),
        ]),
      ]),
      html('li', { class: 'sealed' }, [
        html('b', { text: `${fills.length} slices, ${utc(first.wall)} to ${utc(last.wall)} UTC` }),
        html('p', {
          text:
            `ETH to ${r.buy.symbol} in confidential form. The public intents.near ledger showed the agent holding 0 ${r.buy.symbol} ` +
            `at block ${num(chain.publicLedger.block, 0)}, while its confidential balance held ${num(sol, 6)} ${r.buy.symbol}.`,
        }),
      ]),
      html('li', {}, [
        html('span', { class: 't', text: utc(chain.withdrawal.at) }),
        html('span', {}, [
          `${num(Number(chain.withdrawal.amount), 6)} ETH back to the owner's wallet `,
          html('span', { class: 'pub' }, ['public, ', txLink(chain.withdrawal.tx)]),
        ]),
      ]),
    );
    const proof = $('#live-proof');
    proof.textContent = '';
    proof.append(
      `The agent is NEAR account ${shortHash(chain.agent.nearAccount)}. Its policy: ${chain.agent.policy}. ` +
        'Read the public ledger at that block yourself, no keys needed:',
      html('code', { text: chain.publicLedger.check }),
    );

    const tbody = document.querySelector('#live-table tbody');
    tbody.textContent = '';
    for (const f of fills) {
      const sold = toNumber(BigInt(f.amountIn), order.sell.decimals);
      const got = toNumber(BigInt(f.amountOut), order.buy.decimals);
      const vsQuote = f.quotedAmountOut ? (Number(BigInt(f.amountOut)) / Number(BigInt(f.quotedAmountOut)) - 1) * 10_000 : null;
      const hash = f.txHashes?.[0] ?? '';
      tbody.append(
        html('tr', {}, [
          html('td', { text: f.sliceId }),
          html('td', { text: num(sold, 6) }),
          html('td', { text: num(got, 6) }),
          html('td', { class: vsQuote != null && vsQuote < 0 ? 'miss' : 'good', text: `${signed(vsQuote, 1)} bps` }),
          html('td', { class: 'hash', title: hash, text: shortHash(hash) }),
        ]),
      );
    }
    $('#live-note').textContent =
      `Each slice was submitted as a confidential swap whose minimum output was the desk's floor, and all ${fills.length} settled at or above it, ` +
      `${num(Number(r.received), 6)} ${r.buy.symbol} in total. "vs preview" is the settled amount against the agent's own preview for that slice. ` +
      `At $6 there is no price impact to save, so this run proves the path, not the saving; the $500,000 replay above shows the saving.`;
  } catch (err) {
    $('#live-summary').textContent = `Live run unavailable: ${err.message}`;
  }
}

// ---------- start ----------

async function init() {
  startWater($('#water'));
  wireTicket();
  renderChain();
  loadPrivacySnapshot();
  loadLiveRun();
  const res = await client.tokens();
  if (!res.ok || !Array.isArray(res.json)) {
    setStatus('down', '1Click unreachable. The replay still works.');
    $('#impact-note').textContent = 'Live quotes are unavailable right now.';
    return;
  }
  state.tokens = res.json;
  const chains = new Set(state.tokens.map((t) => t.blockchain)).size;
  setStatus('live', '1Click live', `: ${state.tokens.length} tokens on ${chains} chains`);
  populateAssets(state.tokens);
  setAmountFromUsd(state.targetUsd);
  onPairChange();
  measureImpact();
}

init();
