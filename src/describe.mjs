// One console line per journal event, shared by the dry-run and live command lines.
import { fromUnits } from './units.mjs';

export const fmt = (value, digits = 2) =>
  value == null ? '-' : value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const orderClock = (ms) => {
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

const short = (hash) => (hash && hash.length > 16 ? `${hash.slice(0, 8)}...${hash.slice(-6)}` : hash);

/** @returns {string|null} the line to print for `event`, or null to stay quiet. */
export function describeEvent(event, order, speed = 1) {
  switch (event.type) {
    case 'order':
      return `Order ${order.id}: sell ${fmt(Number(order.amount), 2)} ${order.sell.symbol} (${order.sell.blockchain}) for ${order.buy.symbol} (${order.buy.blockchain}) ` +
        `in ${order.slices} slices over ${orderClock(order.horizonMs)} of order time. Seed ${event.seed}, ${event.mode} run, speed x${speed}.`;
    case 'arrival': {
      const p = event.probe.q;
      const o = event.oneShot.q;
      const probeText = p.ok
        ? `slice-size quote ${p.rate.toPrecision(6)} ${order.buy.symbol}/${order.sell.symbol}, cost ${fmt(p.costBps, 1)} bps`
        : `slice-size quote failed: ${p.message}`;
      const oneShotText = o.ok ? `whole order in one swap: cost ${fmt(o.costBps, 1)} bps` : `whole order in one swap: not executable (${o.message})`;
      return `Arrival: ${probeText}; ${oneShotText}.`;
    }
    case 'slice': {
      const q = event.quote.q;
      const size = `${fmt(Number(fromUnits(BigInt(event.slice.amount), order.sell.decimals)), 2)} ${order.sell.symbol}`;
      const price = q.ok ? `rate ${q.rate.toPrecision(6)}, cost ${fmt(q.costBps, 1)} bps` : q.message;
      return `[${orderClock(event.t)}] slice ${event.slice.id.padEnd(4)} ${size.padStart(18)}  ${price}  -> ${event.decision.action} (${event.decision.reason})`;
    }
    case 'fill': {
      // Dry and preview fills are already described by their slice line.
      if (event.status === 'SIMULATED' || event.status === 'PREVIEW') return null;
      const got = `${fmt(Number(fromUnits(BigInt(event.amountOut), order.buy.decimals)), 6)} ${order.buy.symbol}`;
      const refs = (event.txHashes ?? []).map(short).join(', ');
      if (BigInt(event.amountIn) > 0n) {
        return `[${orderClock(event.t)}]   filled ${event.sliceId}: got ${got} (${event.status})${refs ? ` ${refs}` : ''}`;
      }
      const why = event.details?.failureReason ?? event.details?.failureCode ?? event.details?.code ?? '';
      return `[${orderClock(event.t)}]   slice ${event.sliceId} not filled: ${event.status}${why ? ` (${why})` : ''}`;
    }
    case 'skip':
      return `[${orderClock(event.t)}] slice ${event.sliceId} left unfilled (${event.reason})`;
    case 'halt':
      return `Stopped: ${event.message}`;
    case 'abort':
      return `Aborted: ${event.message}`;
    default:
      return null;
  }
}
