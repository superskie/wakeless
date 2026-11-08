// Pure helpers for the desk: number formats, quote failures, report wording,
// chip amounts and the monitor clock. No DOM, so node --test runs them.

export const num = (value, digits = 2) =>
  value == null || !Number.isFinite(value)
    ? '-'
    : value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const signed = (value, digits = 1) => (value == null || !Number.isFinite(value) ? '-' : `${value >= 0 ? '+' : ''}${num(value, digits)}`);

export const mmss = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** Token amounts: whole units when large, three significant digits when small (0.000580 ETH, not 0.00). */
export function qty(value) {
  if (value == null || !Number.isFinite(value)) return '-';
  const a = Math.abs(value);
  const digits = a === 0 || a >= 100 ? 0 : a >= 1 ? 2 : Math.min(10, 2 - Math.floor(Math.log10(a)));
  return `${value < 0 ? '-' : ''}${num(a, digits)}`;
}

export const signedQty = (value) => (value == null || !Number.isFinite(value) ? '-' : `${value >= 0 ? '+' : '-'}${qty(Math.abs(value))}`);

/** A dollar size without its sign; cents under $10, so a 40 cent gap on a small live order does not read as $0. */
export const dollars = (value) => `$${num(Math.abs(value), Math.abs(value) < 10 ? 2 : 0)}`;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };

/**
 * A network error message as one short line of plain text. 1Click bodies that
 * are not JSON arrive as their first 300 characters, which on a gateway error
 * is the start of an HTML page.
 */
export function plainMessage(message, max = 140) {
  const text = String(message ?? '')
    .replace(/<!--[\s\S]*?(-->|$)/g, ' ')
    .replace(/<(script|style)\b[\s\S]*?(<\/\1\s*>|$)/gi, ' ')
    .replace(/<[^>]*(>|$)/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, name) => ENTITIES[name])
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 3).trimEnd()}...` : text;
}

/** Why a quote failed, in a few words: "no liquidity", "HTTP 503", "timed out", or 1Click's own message. */
export function failureReason({ noLiquidity, status, message } = {}) {
  if (noLiquidity) return 'no liquidity';
  const text = plainMessage(message, 80);
  // The client says "1Click did not answer within 30 s"; 1Click's own solver wait is a 500 "...within timeout".
  if (/timed? ?out|timeout|did not answer within/i.test(text)) {
    const seconds = /within (\d+) ?s\b/i.exec(text)?.[1];
    return seconds ? `timed out after ${seconds} s` : 'timed out';
  }
  if (status >= 400) return !text || /^HTTP \d+$/.test(text) ? `HTTP ${status}` : `HTTP ${status}: ${text}`;
  return text || (status ? `HTTP ${status}` : 'no answer');
}

/** A failed quote as a short label: "no answer" for an error or a timeout, else "no quote". */
export const missLabel = (q) => (q?.noLiquidity === false ? 'no answer' : 'no quote');

/**
 * Report lines when the whole-order quote failed. Only a no-liquidity answer
 * says the market refused the size; a server error or a timeout is no
 * evidence of that, so the run just has no comparison. A report without the
 * noLiquidity field gets wording that claims neither.
 * @param {{ noLiquidity?: boolean, status?: number | null, message?: string }} o the report's vsOneShot
 */
export function oneShotGap(o, { total, symbol }) {
  const whole = `the whole ${qty(Number(total))} ${symbol}`;
  if (o.noLiquidity === true) {
    return { headline: 'One swap got no quote.', detail: `1Click had no liquidity for ${whole} in one swap.`, bar: 'no quote' };
  }
  if (o.noLiquidity === false) {
    return { headline: 'No one-swap comparison.', detail: `1Click did not answer the whole-order quote (${failureReason(o)}), so this run has no comparison.`, bar: 'no answer' };
  }
  return { headline: 'One swap was not quoted.', detail: `1Click gave no quote for ${whole} (${failureReason(o)}), so this run has no comparison.`, bar: 'no quote' };
}

// How the fills of each journal mode happened; the wording follows the CLI report (src/report.mjs).
const REPORT_MODES = {
  dry: {
    kicker: 'Report, dry run',
    fineprint: 'Both costs are measured the same way and include the same 1Click platform fee. Dry run: each fill is simulated at its live quote.',
    rerun: true,
  },
  preview: {
    kicker: 'Report, agent preview',
    fineprint: "Both costs are measured the same way and include the Agent API fee. Agent preview: nothing was submitted and no funds moved; each fill is shown at its previewed amount.",
    rerun: false,
  },
  live: {
    kicker: 'Report, live run',
    fineprint:
      "Both costs are measured the same way and include the Agent API fee. Live run: every fill was a real swap whose minimum output is the desk's floor, " +
      'and the amounts received are the settled amounts the Agent API reported.',
    rerun: false,
  },
};

/** Kicker, fineprint and whether "Run again" fits: rerunning a live report would only simulate it. */
export const reportMode = (mode) => REPORT_MODES[mode] ?? { kicker: 'Report', fineprint: 'Both costs are measured the same way.', rerun: false };

/** One cell of the pre-trade table. A dash when there is nothing to measure against (the reference quote failed). */
export function penaltyText(row) {
  if (!row.q?.ok) return missLabel(row.q);
  if (row.penaltyBps == null || !Number.isFinite(row.penaltyBps)) return '-';
  return `${signed(Math.abs(row.penaltyBps) < 0.05 ? 0 : row.penaltyBps)} bps`;
}

const digitsFor = (price) => (price >= 1000 ? 4 : price >= 10 ? 3 : price >= 0.5 ? 2 : 0);

/**
 * Ticket amount for a size chip, as the text for the amount field. Stablecoins
 * go in at face value, other tokens at the 1Click price, rounded down at a step
 * under 0.1% of the amount, so a chip never lands above its dollar value: a
 * live $50 chip must stay inside the hosted cap. With `atMost`, a stablecoin
 * priced above $1 converts too.
 */
export function chipAmount(usd, price, { decimals = 18, atMost = false } = {}) {
  if (!(usd > 0) || !(price > 0)) return '';
  if (Math.abs(price - 1) < 0.01 && !(atMost && price > 1)) return String(usd);
  const raw = usd / price;
  const digits = Math.max(0, Math.min(decimals, 8, Math.max(digitsFor(price), Math.ceil(-Math.log10(raw / 1000)))));
  const step = 10 ** digits;
  let n = Math.round(raw * step);
  // Nearest went over: one step down. Comparing the product, not the quotient, keeps 0.29 at 0.29.
  if ((n / step) * price > usd) n -= 1;
  const text = (n / step).toFixed(digits);
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/**
 * Order time on the monitor clock. Between events it runs on at `speed`, but
 * with speed above 1 order time only moves while the engine waits (see
 * realClock), so it stops at `cap`, the next scheduled event, instead of
 * counting quote latency. It never runs backwards.
 */
export function clockTime({ shown = 0, lastT, sinceMs, speed, horizon, cap = horizon }) {
  const ahead = lastT + Math.max(0, sinceMs) * speed;
  return Math.max(shown, Math.min(horizon, speed > 1 ? Math.min(cap, ahead) : ahead));
}
