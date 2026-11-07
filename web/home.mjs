// Wakeless landing page: the size penalty from committed 1Click quotes, the
// desk's own slice scheduler, copy buttons, reveals and the water.
import { scheduleFor } from '../src/engine.mjs';
import { largestPossibleSlice } from '../src/schedule.mjs';
import { mulberry32 } from '../src/rng.mjs';
import { DEFAULTS } from '../src/order.mjs';
import { startWater } from './water.mjs';

const $ = (sel) => document.querySelector(sel);
const NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs, parent) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (parent) parent.append(el);
  return el;
}
const num = (n, digits = 0) => n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const signed = (n) => `${n >= 0 ? '+' : '-'}${num(Math.abs(n), 1)}`;
const usdShort = (usd) => (usd >= 1e6 ? `$${num(usd / 1e6, usd % 1e6 ? 1 : 0)}M` : `$${num(usd / 1e3)}k`);
const usdLong = (usd) => `$${num(usd)}`;
const compact = (n) => (n >= 1e3 ? `${num(n / 1e3, n >= 1e4 ? 0 : 1)}k` : num(n));

// ---------- 01: the cost of size, from committed quotes ----------

/** Raw 1Click responses committed under research/impact/; two files of one minute make one series. */
const IMPACT = [
  { pair: 'USDC (Arbitrum) to SOL', day: '5 Nov', files: ['../research/impact/usdc-arb_sol-sol_2026-11-05t02-30-14-324z.json'] },
  { pair: 'USDC (Arbitrum) to SOL', day: '7 Nov', files: ['../research/impact/usdc-arb_sol-sol_2026-11-07t07-51-02-938z.json', '../research/impact/usdc-arb_sol-sol_2026-11-07t07-51-55-639z.json'] },
  { pair: 'ETH to SOL', day: '7 Nov', files: ['../research/impact/eth-eth_sol-sol_2026-11-07t07-51-22-260z.json', '../research/impact/eth-eth_sol-sol_2026-11-07t07-52-04-557z.json'] },
  { pair: 'USDC (Solana) to ETH', day: '7 Nov', files: ['../research/impact/usdc-sol_eth-eth_2026-11-07t07-51-26-453z.json', '../research/impact/usdc-sol_eth-eth_2026-11-07t07-52-08-604z.json'] },
];
const CONFIDENTIAL_QUOTES = '../research/confidential/usdc-arb_sol-sol_2026-11-05t03-37-19-519z.json';

/** Extra cost of each size against the $1,000 swap quoted in the same file, in bps. */
async function loadSeries(set) {
  const files = await Promise.all(set.files.map(async (f) => {
    const res = await fetch(new URL(f, import.meta.url));
    if (!res.ok) throw new Error(`${res.status} for ${f}`);
    return res.json();
  }));
  const points = new Map();
  for (const file of files) {
    const base = file.rows.find((r) => r.usd === 1000 && r.q?.ok);
    for (const r of file.rows) {
      if (points.has(r.usd)) continue;
      if (r.q?.ok && base) points.set(r.usd, { usd: r.usd, extra: r.q.costBps - base.q.costBps });
      else if (r.q && !r.q.ok) points.set(r.usd, { usd: r.usd, none: true, reason: r.q.noLiquidity ? 'No liquidity available' : r.q.message });
    }
  }
  return { takenAt: new Date(files[0].takenAt), points: [...points.values()].sort((a, b) => a.usd - b.usd) };
}

const IC = { W: 640, H: 300, L: 50, R: 10, T: 30, B: 34 };

function drawImpact(series) {
  const root = $('#impact-chart');
  root.textContent = '';
  const { points } = series;
  const plotW = IC.W - IC.L - IC.R;
  const plotH = IC.H - IC.T - IC.B;
  const quoted = points.filter((p) => !p.none);
  const top = Math.max(30, Math.ceil((Math.max(...quoted.map((p) => p.extra)) * 1.18) / 10) * 10);
  const low = Math.min(0, ...quoted.map((p) => p.extra));
  const span = top - low;
  const y = (v) => IC.T + ((top - v) / span) * plotH;
  const grid = svg('g', { class: 'ax' }, root);
  for (const v of [0, top / 2, top]) {
    svg('line', { x1: IC.L, x2: IC.W - IC.R, y1: y(v), y2: y(v), class: v === 0 ? 'zero' : '' }, grid);
    svg('text', { x: IC.L - 10, y: y(v) + 4, 'text-anchor': 'end' }, grid).textContent = v === 0 ? '0' : `+${num(v)}`;
  }
  svg('text', { x: IC.L - 10, y: IC.T - 14, 'text-anchor': 'end', class: 'unit' }, grid).textContent = 'bps';
  const slot = plotW / points.length;
  const bw = Math.min(54, slot * 0.56);
  points.forEach((p, i) => {
    const cx = IC.L + slot * (i + 0.5);
    svg('text', { x: cx, y: IC.H - 10, 'text-anchor': 'middle', class: 'size' }, grid).textContent = usdShort(p.usd);
    const g = svg('g', { style: `--i: ${i}` }, root);
    if (p.none) {
      svg('rect', { x: cx - bw / 2, y: IC.T, width: bw, height: y(0) - IC.T, rx: 5, class: 'none' }, g);
      const t = svg('text', { x: cx, y: IC.T + 18, 'text-anchor': 'middle', class: 'lbl none' }, g);
      t.textContent = 'no quote';
      return;
    }
    const isBase = p.usd === 1000;
    const y0 = y(0);
    const y1 = y(isBase ? 0 : p.extra);
    const h = Math.max(2, Math.abs(y1 - y0));
    svg('rect', { x: cx - bw / 2, y: Math.min(y0, y1) - (h === 2 && y1 >= y0 ? 1 : 0), width: bw, height: h, rx: Math.min(5, h / 2), class: `bar${isBase ? ' base' : ''}${p.extra < 0 ? ' neg' : ''}` }, g);
    const label = svg('text', { x: cx, y: Math.min(y0, y1) - 8, 'text-anchor': 'middle', class: `lbl${isBase ? ' base' : ''}` }, g);
    label.textContent = isBase ? 'base' : signed(Math.abs(p.extra) < 0.05 ? 0 : p.extra);
  });
}

function readImpact(set, series) {
  const { points, takenAt } = series;
  const at = `${takenAt.getUTCDate()} ${takenAt.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })} 2026, ${takenAt.toISOString().slice(11, 16)} UTC`;
  const pick = points.find((p) => p.usd === 500_000 && !p.none) ?? [...points].reverse().find((p) => !p.none);
  const firstNone = points.find((p) => p.none);
  const largest = [...points].reverse().find((p) => !p.none);
  $('#impact-v').textContent = `${signed(pick.extra)} bps`;
  $('#impact-k').textContent = `for ${usdLong(pick.usd)} in one swap, ${set.pair}.`;
  const after = firstNone
    ? `${usdLong(firstNone.usd)} got no quote: "${firstNone.reason}".`
    : largest.usd > pick.usd ? `${usdLong(largest.usd)} cost ${signed(largest.extra)} bps.` : '';
  $('#impact-n').textContent = `Quoted ${at}. ${after}`.trim();
}

async function initImpact() {
  const picker = $('#impact-picker');
  const cache = new Map();
  const buttons = IMPACT.map((set, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-pressed', 'false');
    b.append(set.pair);
    const day = document.createElement('b');
    day.textContent = set.day;
    b.append(day);
    b.addEventListener('click', () => show(i));
    picker.append(b);
    return b;
  });
  async function show(i) {
    buttons.forEach((b, j) => b.setAttribute('aria-pressed', String(i === j)));
    try {
      if (!cache.has(i)) cache.set(i, await loadSeries(IMPACT[i]));
      const series = cache.get(i);
      drawImpact(series);
      readImpact(IMPACT[i], series);
    } catch (err) {
      $('#impact-k').textContent = `The committed quotes did not load (${err.message}).`;
    }
  }
  await show(0);
}

// ---------- 03: the desk's scheduler on the $500,000 order ----------

const USDC = 10n ** 6n;
const ORDER = Object.freeze({
  totalUnits: 500_000n * USDC,
  horizonMs: 30 * 60_000,
  timeJitter: DEFAULTS.timeJitter,
  sizeJitter: DEFAULTS.sizeJitter,
  minSliceUnits: 1_000n * USDC,
});
const SC = { W: 720, H: 290, L: 54, R: 12, T: 18, B: 30 };
const newSeed = () => crypto.getRandomValues(new Uint32Array(1))[0] >>> 1;
let seed = newSeed();

/** @param {boolean} [animate] bars grow in on a new draw, not while the slider moves */
function drawSchedule(animate = true) {
  $('#sched').classList.toggle('still', !animate);
  const slices = Number($('#sched-slices').value);
  const input = $('#sched-slices');
  input.style.setProperty('--p', `${((slices - input.min) / (input.max - input.min)) * 100}%`);
  $('#sched-out').textContent = String(slices);
  const order = { ...ORDER, slices };
  const schedule = scheduleFor(order, mulberry32(seed));
  const units = (u) => Number(u) / 1e6;
  const total = units(order.totalUnits);
  const ceiling = units(largestPossibleSlice({ total: order.totalUnits, slices, sizeJitter: order.sizeJitter }));
  const maxAmount = ceiling * 1.14;
  const plotW = SC.W - SC.L - SC.R;
  const plotH = SC.H - SC.T - SC.B;
  const x = (t) => SC.L + (t / order.horizonMs) * plotW;
  const y = (a) => SC.T + plotH - (a / maxAmount) * plotH;

  const root = $('#sched');
  root.textContent = '';
  const grid = svg('g', { class: 'ax' }, root);
  for (let m = 0; m <= 30; m += 5) {
    svg('line', { x1: x(m * 60_000), x2: x(m * 60_000), y1: SC.T, y2: SC.T + plotH }, grid);
    svg('text', { x: x(m * 60_000), y: SC.H - 8, 'text-anchor': 'middle' }, grid).textContent = `${m}m`;
  }
  for (const frac of [0.5, 1]) {
    svg('text', { x: SC.L - 10, y: y(maxAmount * frac) + 4, 'text-anchor': 'end' }, grid).textContent = compact(maxAmount * frac);
  }
  svg('line', { x1: SC.L, x2: SC.W - SC.R, y1: SC.T + plotH, y2: SC.T + plotH, class: 'zero' }, grid);
  const bw = Math.max(3, Math.min(18, (plotW / slices) * 0.44));
  schedule.forEach((s, i) => {
    const top = Math.min(y(units(s.amount)), SC.T + plotH - 2);
    svg('rect', { x: x(s.atMs) - bw / 2, y: top, width: bw, height: SC.T + plotH - top, rx: Math.min(3, bw / 2), class: 'slice', style: `--i: ${i}` }, root);
  });
  const capY = y(ceiling);
  svg('line', { x1: SC.L, x2: SC.W - SC.R, y1: capY, y2: capY, class: 'cap' }, root);
  svg('text', { x: SC.W - SC.R - 4, y: capY - 7, 'text-anchor': 'end', class: 'cap-label' }, root).textContent = `largest possible slice ${num(ceiling)} USDC`;

  const every = Math.round(order.horizonMs / slices / 1000);
  const cadence = every >= 60 ? `${Math.floor(every / 60)}m ${String(every % 60).padStart(2, '0')}s` : `${every}s`;
  $('#sched-note').textContent =
    `${slices} slices over 30 minutes, one every ${cadence} on average. Average slice ${num(total / slices)} USDC; ` +
    `the largest any draw can reach is ${num(ceiling)} USDC, ${num((ceiling / total) * 100)}% of the order, and that is the per-swap cap a live wallet signs.`;
}

function initSchedule() {
  $('#sched-slices').addEventListener('input', () => drawSchedule(false));
  $('#sched-redraw').addEventListener('click', () => {
    seed = newSeed();
    drawSchedule();
  });
  drawSchedule();
}

// ---------- page ----------

function initCopy() {
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('button.copy');
    if (!button) return;
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Select it';
    }
    setTimeout(() => (button.textContent = 'Copy'), 1600);
  });
}

function initReveal() {
  const items = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('in'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('in');
      io.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -6% 0px', threshold: 0.06 });
  items.forEach((el) => io.observe(el));
}

function initNav() {
  const links = new Map([...document.querySelectorAll('.topnav a[href^="#"]')].map((a) => [a.getAttribute('href').slice(1), a]));
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      links.forEach((a, id) => a.setAttribute('aria-current', String(id === entry.target.id)));
    }
  }, { rootMargin: '-45% 0px -50% 0px' });
  document.querySelectorAll('main section[id]').forEach((s) => io.observe(s));
}

$('#confidential-link').href = new URL(CONFIDENTIAL_QUOTES, import.meta.url).pathname;
initReveal();
initCopy();
initNav();
initSchedule();
startWater($('#water'), { slices: 16 });
startWater($('#water-cta'), { slices: 16, band: 0.36 });
initImpact();
