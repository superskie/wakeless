// Wakeless web desk. Runs the same engine as the command line, in the browser,
// against the public 1Click API (it allows cross-origin requests). No keys and
// no wallet: quotes are live, fills are simulated.
import { createOneClick } from '../src/oneclick.mjs';
import { prepareOrder } from '../src/order.mjs';
import { runOrder, scheduleFor } from '../src/engine.mjs';
import { largestPossibleSlice } from '../src/schedule.mjs';
import { dryExecutor } from '../src/executors/dry.mjs';
import { realClock } from '../src/clock.mjs';
import { buildReport } from '../src/report.mjs';
import { adviceText, precheck } from '../src/precheck.mjs';
import { mulberry32 } from '../src/rng.mjs';
import { resolveAsset } from '../src/assets.mjs';
import { memoryJournal, parseJsonl, toJsonl } from '../src/memory-journal.mjs';
import { toNumber } from '../src/units.mjs';
import { HOSTED } from '../src/agent/hosted.mjs';
import { createLive, LIVE_ASSETS } from './live.mjs';

// Two committed $500k runs of the same order: a thin market and a deeper one.
const SAMPLE_RUNS = {
  replay: '../examples/sample-run.jsonl',
  'replay-deep': '../examples/sample-run-2026-11-07.jsonl',
};
const ASSETS = ['usdc:arb', 'usdc:eth', 'usdc:base', 'usdc:sol', 'usdt:eth', 'usdt:tron', 'eth:eth', 'eth:arb', 'eth:base', 'sol:sol', 'btc:btc', 'wnear:near', 'zec:zec'];
const CHAINS = { arb: 'Arbitrum', eth: 'Ethereum', base: 'Base', sol: 'Solana', tron: 'Tron', btc: 'Bitcoin', near: 'NEAR', zec: 'Zcash' };
const DRY_ACCOUNT = 'dry-run.wakeless.near';

const $ = (selector) => document.querySelector(selector);
const SVG = 'http://www.w3.org/2000/svg';
const client = createOneClick();
const newSeed = () => crypto.getRandomValues(new Uint32Array(1))[0] >>> 1;
// `idle`: the monitor shows the plan preview until the first run or replay starts.
const state = { tokens: null, busy: false, precheckBusy: false, targetUsd: 500_000, lastRun: null, idle: true, planSeed: newSeed(), mode: 'sim', lockedSpec: null };
// Simulated orders are sized for the price impact they show; live ones stay under the hosted cap.
const MODES = {
  sim: { assets: ASSETS, pair: ['usdc:arb', 'sol:sol'], chips: [100_000, 250_000, 500_000, 1_000_000], usd: 500_000, windows: [10, 30, 60, 120], window: 30, slices: [1, 64, 16] },
  live: { assets: LIVE_ASSETS, pair: ['eth:base', 'sol:sol'], chips: [10, 25, HOSTED.maxOrderUsd], usd: 25, windows: [5, 10, 15, 30], window: 10, slices: [HOSTED.minSlices, HOSTED.maxSlices, 4] },
};
let liveDesk = null;

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
const chainName = (id) => CHAINS[id] ?? id.toUpperCase();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const human = (units, decimals) => toNumber(BigInt(units), decimals);
const compact = (value) =>
  value >= 1e6 ? `${num(value / 1e6, 1)}M` : value >= 1e3 ? `${num(value / 1e3, value >= 1e4 ? 0 : 1)}k` : num(value, value >= 10 ? 0 : 2);
const digitsFor = (price) => (price >= 1000 ? 4 : price >= 10 ? 3 : price >= 0.5 ? 2 : 0);
// Token amounts: whole units when large, three significant digits when small (0.00096 ETH).
const qty = (value) =>
  !(value > 0) ? num(value, 0) : value >= 100 ? num(value, 0) : value >= 1 ? num(value, 2) : num(value, Math.min(10, 2 - Math.floor(Math.log10(value))));

// ---------- status, assets, ticket ----------

/** `wide` is extra text that narrow screens drop (see .status .wide). */
function setStatus(kind, text, wide = '') {
  $('#status').dataset.state = kind;
  const node = $('#status-text');
  node.textContent = text;
  if (wide) node.append(html('span', { class: 'wide', text: wide }));
}

function populateAssets(tokens, refs = MODES[state.mode].assets, [sellRef, buyRef] = MODES[state.mode].pair) {
  const sell = $('#sell');
  const buy = $('#buy');
  sell.textContent = '';
  buy.textContent = '';
  for (const ref of refs) {
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
  sell.value = sellRef;
  buy.value = buyRef;
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
    // Live orders are $10 to $50, so their slices are a few dollars each.
    minSliceUsd: state.mode === 'live' ? 0.5 : 1000,
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
  for (const id of Object.keys(SAMPLE_RUNS)) $(`#${id}`).disabled = busy;
  $('#precheck-run').disabled = busy || state.precheckBusy;
}

function wireTicket() {
  $('#ticket').addEventListener('submit', (event) => {
    event.preventDefault();
    // In live mode the run starts from its own step, never from Enter in a field.
    if (state.mode === 'sim') runLive();
  });
  for (const radio of document.querySelectorAll('input[name="mode"]')) {
    radio.addEventListener('change', () => radio.checked && applyMode(radio.value));
  }
  for (const type of ['input', 'change']) {
    $('#ticket').addEventListener(type, (event) => {
      if (state.mode === 'live' && !event.target.closest('#live')) liveDesk?.render();
    });
  }
  for (const [id, file] of Object.entries(SAMPLE_RUNS)) $(`#${id}`).addEventListener('click', () => replay(file));
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
    clearPrecheck();
    renderPlan();
  });
  for (const chip of document.querySelectorAll('#chips button')) {
    chip.addEventListener('click', () => {
      setAmountFromUsd(Number(chip.dataset.usd));
      clearPrecheck();
      renderPlan();
    });
  }
  $('#slices').addEventListener('input', () => {
    $('#slices-out').textContent = $('#slices').value;
    syncRange($('#slices'));
    renderPlan();
  });
  $('#window').addEventListener('change', renderPlan);
  $('#adverse').addEventListener('input', () => {
    $('#adverse-out').textContent = `${$('#adverse').value} bps`;
    syncRange($('#adverse'));
    renderPlan();
  });
  $('#plan-redraw').addEventListener('click', () => {
    state.planSeed = newSeed();
    renderPlan();
  });
  for (const range of document.querySelectorAll('input[type="range"]')) syncRange(range);
  $('#precheck-run').addEventListener('click', runPrecheck);
}

function onPairChange() {
  showError('');
  clearPrecheck();
  if (!state.tokens) return;
  renderPlan();
}

// ---------- pre-trade check ----------

function clearPrecheck() {
  const out = $('#precheck-out');
  if (!out || state.precheckBusy) return;
  out.hidden = true;
  out.textContent = '';
  $('#precheck-run').textContent = 'Check this order first';
}

function setSlices(n) {
  $('#slices').value = String(n);
  $('#slices-out').textContent = String(n);
  syncRange($('#slices'));
  renderPlan();
}

/** Paints the filled part of a range track (WebKit has no progress pseudo-element). */
function syncRange(input) {
  const min = Number(input.min);
  const span = Number(input.max) - min || 1;
  input.style.setProperty('--p', `${((Number(input.value) - min) / span) * 100}%`);
}

async function runPrecheck() {
  if (state.busy || state.precheckBusy) return;
  showError('');
  if (!state.tokens) {
    showError('1Click is not reachable right now.');
    return;
  }
  let order;
  try {
    order = prepareOrder(currentSpec(), state.tokens);
  } catch (err) {
    showError(err.message);
    return;
  }
  const out = $('#precheck-out');
  const button = $('#precheck-run');
  state.precheckBusy = true;
  button.disabled = true;
  out.hidden = false;
  out.textContent = '';
  const progress = html('p', { class: 'hint', text: 'Quoting a $1,000 reference swap.' });
  out.append(progress);
  try {
    const result = await precheck({
      order,
      client,
      maxSlices: Number($('#slices').max),
      onRow: (row) => {
        progress.textContent = `Quoted ${row.slices} slice${row.slices === 1 ? '' : 's'}.`;
      },
    });
    renderPrecheck(result);
  } catch (err) {
    out.textContent = '';
    out.append(html('p', { class: 'hint', text: `The check failed: ${err.message}` }));
  } finally {
    state.precheckBusy = false;
    button.disabled = state.busy;
    button.textContent = 'Check again';
  }
}

function renderPrecheck(r) {
  const out = $('#precheck-out');
  out.textContent = '';
  const each = (row) => (r.totalUsd ? `$${num(r.totalUsd / row.slices, 0)}` : '-');
  const body = r.rows.map((row) =>
    html('tr', row.slices === r.recommendedSlices ? { class: 'pick' } : {}, [
      html('td', { text: String(row.slices) }),
      html('td', { text: each(row) }),
      html('td', { text: row.q.ok ? `${signed(Math.abs(row.penaltyBps) < 0.05 ? 0 : row.penaltyBps)} bps` : 'no quote' }),
    ]),
  );
  out.append(
    html('table', { class: 'privacy-table precheck-table' }, [
      html('thead', {}, html('tr', {}, [html('th', { text: 'Slices' }), html('th', { text: 'Each' }), html('th', { text: `vs a $${num(r.referenceUsd, 0)} swap` })])),
      html('tbody', {}, body),
    ]),
  );
  out.append(html('p', { class: 'precheck-advice', text: adviceText(r) }));
  if (r.recommendedSlices && r.recommendedSlices !== Number($('#slices').value)) {
    const use = html('button', { class: 'btn small', type: 'button', text: `Use ${r.recommendedSlices} slice${r.recommendedSlices === 1 ? '' : 's'}` });
    use.addEventListener('click', () => {
      setSlices(r.recommendedSlices);
      use.remove();
    });
    out.append(use);
  }
}

// ---------- execution monitor ----------

/** Geometry of the timeline SVG; keep the viewBox in index.html in step (720 x 330). */
const TL = Object.freeze({ W: 720, H: 330, L: 52, R: 12, T: 14, B: 30 });

/** Minute grid, two size labels and the baseline, shared by the plan preview and the run. */
function drawAxes(root, { x, horizon, maxAmount }) {
  const plotH = TL.H - TL.T - TL.B;
  const g = svg('g', { class: 'tl grid axis' }, root);
  const minutes = horizon / 60_000;
  const step = [1, 2, 5, 10, 15, 30, 60].find((s) => minutes / s <= 7) ?? 60;
  for (let m = 0; m <= minutes + 1e-9; m += step) {
    const px = x(m * 60_000);
    svg('line', { x1: px, x2: px, y1: TL.T, y2: TL.T + plotH }, g);
    svg('text', { x: px, y: TL.H - 10, 'text-anchor': 'middle' }, g).textContent = `${m}m`;
  }
  for (const frac of [0.5, 1]) {
    const py = TL.T + plotH - frac * plotH;
    svg('text', { x: TL.L - 8, y: py + 4, 'text-anchor': 'end' }, g).textContent = maxAmount >= 10 ? compact(maxAmount * frac) : qty(maxAmount * frac);
  }
  svg('line', { x1: TL.L, x2: TL.W - TL.R, y1: TL.T + plotH, y2: TL.T + plotH, stroke: 'rgba(233,238,244,0.2)' }, g);
}

/**
 * Until the first run, the monitor draws one possible schedule for the ticket,
 * with the same function the run uses, under the largest slice any draw of
 * this order can reach (the cap a live wallet holds the order to).
 */
function renderPlan() {
  if (!state.idle) return;
  const root = $('#timeline');
  const stats = $('#plan-stats');
  const caption = $('#plan-caption');
  root.textContent = '';
  stats.textContent = '';
  let order;
  let schedule;
  try {
    if (!state.tokens) throw new Error(caption.dataset.down ?? 'Waiting for the 1Click token list.');
    order = prepareOrder(currentSpec(), state.tokens);
    schedule = scheduleFor(order, mulberry32(state.planSeed));
  } catch (err) {
    caption.textContent = err.message.charAt(0).toUpperCase() + err.message.slice(1);
    return;
  }

  const { decimals, symbol, price } = order.sell;
  const horizon = order.horizonMs;
  const total = human(order.totalUnits, decimals);
  const ceiling = human(order.slices > 1 ? largestPossibleSlice({ total: order.totalUnits, slices: order.slices, sizeJitter: order.sizeJitter }) : order.totalUnits, decimals);
  const maxAmount = ceiling * 1.12;
  const plotW = TL.W - TL.L - TL.R;
  const plotH = TL.H - TL.T - TL.B;
  const x = (t) => TL.L + (Math.min(Math.max(t, 0), horizon) / horizon) * plotW;
  const y = (amount) => TL.T + plotH - (amount / maxAmount) * plotH;

  drawAxes(root, { x, horizon, maxAmount });
  const g = svg('g', { class: 'tl' }, root);
  const bw = Math.max(4, Math.min(20, (plotW / order.slices) * 0.42));
  for (const s of schedule) {
    const top = Math.min(y(human(s.amount, decimals)), TL.T + plotH - 2);
    svg('rect', { x: x(s.atMs) - bw / 2, y: top, width: bw, height: TL.T + plotH - top, rx: 3, class: 'ghost plan' }, g);
  }
  const capY = y(ceiling);
  svg('line', { class: 'cap', x1: TL.L, x2: TL.W - TL.R, y1: capY, y2: capY }, g);
  svg('text', { class: 'cap-label', x: TL.W - TL.R - 4, y: capY - 6, 'text-anchor': 'end' }, g).textContent = `largest possible slice ${qty(ceiling)} ${symbol}`;

  const usd = (amount) => (price > 0 ? `about $${num(amount * price, 0)}` : null);
  const seconds = Math.round(horizon / order.slices / 1000);
  const every = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
  const minutes = horizon / 60_000;
  const span = minutes >= 60 ? `${minutes / 60} hour${minutes > 60 ? 's' : ''}` : `${minutes} minutes`;
  const stat = (label, value, note) =>
    html('li', {}, [html('span', { class: 'ps-k', text: label }), html('b', { text: value }), note ? html('span', { class: 'ps-n', text: note }) : null]);
  stats.append(
    stat('Average slice', `${qty(total / order.slices)} ${symbol}`, usd(total / order.slices)),
    stat('Largest possible', `${qty(ceiling)} ${symbol}`, `${num((ceiling / total) * 100, 0)}% of the order; a live wallet is capped here`),
    stat('A slice every', every, 'on average, at a random moment'),
    stat('Floor', `${order.maxAdverseBps} bps`, 'under the arrival price'),
  );
  caption.textContent = `One possible draw: ${order.slices} slices over ${span}.`;
  $('#clock').textContent = `00:00 / ${mmss(horizon)}`;
}

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
  body.hidden = false;
  $('#monitor-empty').hidden = true;
  $('#plan-head').hidden = true;
  $('#legend-cap').hidden = true;
  state.idle = false;
  setStep('arrival');

  const { W, H, L, R, T, B } = TL;
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
    drawAxes(root, { x, horizon, maxAmount });
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
  const top = $('.desk').getBoundingClientRect().top + window.scrollY - 76;
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
  await workOrder({ order, client, executor: dryExecutor(), speed: currentSpeed() }).catch(() => {});
}

/**
 * Runs one order in the monitor: simulated fills, or live swaps through the
 * agent wallet. Same engine either way; live mode passes its own quote client
 * and executor and runs in real time. Resolves with the journal's events.
 */
async function workOrder({ order, client: quotes, executor, speed = 1, seed = newSeed(), label = 'Working the order', walletCap }) {
  const journal = memoryJournal();
  setBusy(true, label);
  scrollToDesk();
  const view = startMonitor({ speed });
  try {
    await runOrder({ order, client: quotes, executor, clock: realClock({ speed }), journal, rand: mulberry32(seed), seed, walletCap, onEvent: view.onEvent });
    view.finish(journal.events);
    return journal.events;
  } catch (err) {
    view.fail(err.message);
    throw err;
  } finally {
    setBusy(false);
  }
}

// ---------- modes ----------

function setWindowOptions(minutes, selected) {
  const select = $('#window');
  select.textContent = '';
  for (const m of minutes) select.append(html('option', { value: String(m), text: m < 60 ? `${m} minutes` : m === 60 ? '1 hour' : `${m / 60} hours` }));
  select.value = String(selected);
}

function setChips(values) {
  const chips = [...document.querySelectorAll('#chips button')];
  chips.forEach((chip, i) => {
    chip.hidden = i >= values.length;
    if (i >= values.length) return;
    chip.dataset.usd = String(values[i]);
    chip.textContent = `$${values[i] >= 1e6 ? `${values[i] / 1e6}M` : values[i] >= 1e3 ? `${values[i] / 1e3}k` : values[i]}`;
  });
}

function applyMode(mode) {
  if (state.busy || liveDesk?.running) return;
  state.mode = mode;
  const m = MODES[mode];
  const live = mode === 'live';
  document.body.dataset.mode = mode;
  $('#run').hidden = live;
  $('#precheck').hidden = live;
  document.querySelector('.speed').hidden = live;
  setChips(m.chips);
  setWindowOptions(m.windows, m.window);
  const [min, max, start] = m.slices;
  $('#slices').min = String(min);
  $('#slices').max = String(max);
  setSlices(start);
  clearPrecheck();
  showError('');
  if (state.tokens) {
    populateAssets(state.tokens);
    setAmountFromUsd(m.usd);
  }
  if (live) liveDesk.show();
  else liveDesk.hide();
  renderPlan();
}

/** Once an agent wallet exists its signed limits fix the order, so the ticket shows that order and locks. */
function lockTicket(spec) {
  const key = spec ? JSON.stringify(spec) : null;
  if (key === state.lockedSpec) return;
  state.lockedSpec = key;
  const fields = ['#sell', '#buy', '#flip', '#amount', '#slices', '#window', '#adverse', ...document.querySelectorAll('#chips button')];
  for (const f of fields) (typeof f === 'string' ? $(f) : f).disabled = Boolean(spec);
  if (!spec) return;
  $('#sell').value = spec.sell;
  $('#buy').value = spec.buy;
  $('#amount').value = spec.amount;
  if (![...$('#window').options].some((o) => o.value === String(spec.horizonMinutes))) {
    $('#window').append(html('option', { value: String(spec.horizonMinutes), text: `${spec.horizonMinutes} minutes` }));
  }
  $('#window').value = String(spec.horizonMinutes);
  $('#adverse').value = String(spec.maxAdverseBps);
  $('#adverse-out').textContent = `${spec.maxAdverseBps} bps`;
  syncRange($('#adverse'));
  setSlices(spec.slices);
  syncAmountHint();
}

async function replay(file) {
  if (state.busy) return;
  showError('');
  setBusy(true, 'Replaying');
  scrollToDesk();
  try {
    const res = await fetch(file);
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

// ---------- committed replays: what each one got, shown before it is played ----------

async function loadReplayStats() {
  const runs = { replay: SAMPLE_RUNS.replay, 'replay-deep': SAMPLE_RUNS['replay-deep'] };
  await Promise.all(
    Object.entries(runs).map(async ([id, file]) => {
      try {
        const res = await fetch(file);
        if (!res.ok) return;
        const o = buildReport(parseJsonl(await res.text())).vsOneShot;
        if (o.deltaBps == null) return;
        const label = `${signed(o.deltaBps, 1)} bps vs one swap${o.deltaUsd != null ? `, about $${num(Math.abs(o.deltaUsd), 0)}` : ''}`;
        document.querySelector(`.rc-val[data-run="${id}"]`).textContent = label;
      } catch {
        // The card still replays; it just does not show the result first.
      }
    }),
  );
}

// ---------- motion: blocks rise once as they enter ----------

function startMotion() {
  const blocks = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window)) {
    for (const b of blocks) b.classList.add('in');
    return;
  }
  const reveal = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add('in');
        reveal.unobserve(e.target);
      }
    },
    { rootMargin: '0px 0px -12% 0px', threshold: 0.08 },
  );
  for (const b of blocks) reveal.observe(b);
}

// ---------- start ----------

async function init() {
  liveDesk = createLive({
    ticket: currentSpec,
    // null: a native coin; undefined: not in the 1Click list, so the page will not send it.
    contractOf: (assetId) => {
      const token = state.tokens?.find((t) => t.assetId === assetId);
      return token ? token.contractAddress ?? null : undefined;
    },
    lockTicket,
    workOrder,
  });
  wireTicket();
  renderPlan();
  startMotion();
  loadReplayStats();
  const res = await client.tokens();
  if (!res.ok || !Array.isArray(res.json)) {
    setStatus('down', '1Click unreachable. The replay still works.');
    $('#plan-caption').dataset.down = '1Click is unreachable, so there is no token list to plan with. The replays still work.';
    renderPlan();
    return;
  }
  state.tokens = res.json;
  const chains = new Set(state.tokens.map((t) => t.blockchain)).size;
  setStatus('live', '1Click live', `: ${state.tokens.length} tokens on ${chains} chains`);
  populateAssets(state.tokens);
  setAmountFromUsd(state.targetUsd);
  onPairChange();
}

init();
