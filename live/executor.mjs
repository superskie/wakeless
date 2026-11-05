// Live executor: sends each slice through the Wakeless agent on the NEAR
// Intents Agent API as a confidential swap whose minimum output is the desk's
// price floor, then follows it to a settled status. In `preview` mode it stops
// at the agent's own preview and nothing is submitted.
//
// No SDK import here: the API clients are passed in, so tests use fakes.
import { minOutAtRate } from '../src/units.mjs';
import { waitForStatus } from './status.mjs';

/** Refusals that will not go away by waiting: stop and let a person look. */
const HARD_REFUSAL = /denied|exceeded|insufficient|frozen|revoked|expired|unauthori[sz]ed|forbidden/i;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Submit with the same idempotency key on network errors and 5xx, so a retry can not double-spend. */
async function submitSwap(bot, agentId, body, idempotencyKey, { attempts = 3, backoffMs = 1_500 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await bot.swap(agentId, body, { idempotencyKey });
    } catch (err) {
      const transient = err?.status == null || err.status >= 500;
      if (!transient || attempt >= attempts) throw err;
      await pause(backoffMs * attempt);
    }
  }
}

/**
 * @param {object} p
 * @param {{ getStatus: Function }} p.api partner client, for statuses
 * @param {{ swap: Function }} p.bot grant client, for swaps
 * @param {string} p.agentId
 * @param {'preview'|'live'} [p.mode]
 * @param {boolean} [p.confidential] settle every swap in confidential form
 * @param {string} [p.runId] prefix of every idempotency key in this run
 * @param {number} [p.statusTimeoutMs] how long one swap may take to settle
 * @param {number} [p.maxMissesInARow] stop after this many unfilled attempts in a row
 */
export function agentExecutor({
  api,
  bot,
  agentId,
  mode = 'preview',
  confidential = true,
  runId = crypto.randomUUID(),
  statusTimeoutMs = 180_000,
  maxMissesInARow = 3,
  submitOptions,
}) {
  if (mode !== 'preview' && mode !== 'live') throw new Error(`unknown executor mode: ${mode}`);
  let missesInARow = 0;

  const miss = (result) => {
    missesInARow += 1;
    if (result.next !== 'halt' && missesInARow >= maxMissesInARow) {
      return { ...result, next: 'halt', message: `${missesInARow} attempts in a row did not fill, the last one ${result.status}` };
    }
    return result;
  };

  return {
    mode,
    async execute({ slice, quote, request, floorRate, order }) {
      const amountIn = BigInt(quote.amountIn);
      const quotedOut = BigInt(quote.amountOut);
      // The floor travels with the swap: below it the swap does not settle.
      const floorMin = minOutAtRate(floorRate, amountIn, order.sell.decimals, order.buy.decimals);
      const quotedMin = quote.minAmountOut ? BigInt(quote.minAmountOut) : 0n;
      const minAmountOut = floorMin > quotedMin ? floorMin : quotedMin;
      const warnings = (quote.warnings ?? []).map((w) => w?.code ?? String(w));
      const nothing = { amountIn: 0n, amountOut: 0n, minAmountOut, txHashes: [] };

      if (mode === 'preview') {
        return { status: 'PREVIEW', amountIn, amountOut: quotedOut, minAmountOut, txHashes: [], details: { warnings } };
      }

      if (warnings.length) {
        return {
          ...nothing,
          status: 'BLOCKED',
          details: { warnings },
          next: 'halt',
          message: `the agent's preview says this swap would be refused (${warnings.join(', ')}); nothing was submitted`,
        };
      }
      if (quotedOut < minAmountOut) {
        return miss({ ...nothing, status: 'BELOW_FLOOR', details: { warnings, quotedOut: quotedOut.toString() }, next: 'retry' });
      }

      const idempotencyKey = `wakeless-${runId}-${slice.id}-${slice.defers}`;
      const body = {
        origin_asset: request.originAsset,
        destination_asset: request.destinationAsset,
        amount: amountIn.toString(),
        min_amount_out: minAmountOut.toString(),
        confidential,
      };

      let submitted;
      try {
        submitted = await submitSwap(bot, agentId, body, idempotencyKey, submitOptions);
      } catch (err) {
        const details = { idempotencyKey, httpStatus: err?.status ?? null, code: err?.code ?? null, failureReason: err?.message ?? String(err) };
        const hard = [401, 403, 422].includes(err?.status) || HARD_REFUSAL.test(`${err?.code ?? ''} ${err?.message ?? ''}`);
        if (hard) {
          return { ...nothing, status: 'REJECTED', details, next: 'halt', message: `the Agent API refused the swap: ${err?.code ?? err?.status} ${err?.message ?? ''}`.trim() };
        }
        return miss({ ...nothing, status: 'REJECTED', details, next: 'retry' });
      }

      let final;
      try {
        final = await waitForStatus(api, submitted.correlation_id, statusTimeoutMs);
      } catch {
        return {
          ...nothing,
          status: 'TIMEOUT',
          details: { idempotencyKey, correlationId: submitted.correlation_id },
          next: 'halt',
          message: `no settled status for slice ${slice.id} after ${Math.round(statusTimeoutMs / 1000)}s; check ${submitted.correlation_id} before trading again`,
        };
      }

      const d = final.details ?? {};
      const txHashes = [d.intent_hash, d.tx_hash, d.destination_tx_hash].filter(Boolean);
      const details = {
        correlationId: final.correlation_id,
        idempotencyKey,
        status: final.status,
        failureCode: final.failure_code ?? null,
        failureReason: d.failure_reason ?? null,
        intentHash: d.intent_hash ?? null,
        txHash: d.tx_hash ?? null,
        destinationTxHash: d.destination_tx_hash ?? null,
        providerStatus: d.provider_status ?? null,
        confidential: d.confidential ?? confidential,
        expectedAmountOut: d.expected_amount_out ?? null,
        settledMinAmountOut: d.min_amount_out ?? null,
      };

      if (final.status === 'SUCCESS') {
        const settled = d.amount_out ?? d.delivered ?? null;
        missesInARow = 0;
        return {
          status: 'SUCCESS',
          amountIn,
          // Without a settled amount the expected one is used, and the journal says so.
          amountOut: BigInt(settled ?? d.expected_amount_out ?? quotedOut),
          minAmountOut,
          txHashes,
          details: { ...details, amountOutSource: settled != null ? 'settled' : d.expected_amount_out != null ? 'expected' : 'quoted' },
        };
      }
      if (final.status === 'REFUNDED' || final.status === 'FAILED') {
        // Nothing traded and the funds are back in the agent's balance: try the slice again later.
        return miss({ ...nothing, status: final.status, txHashes, details, next: 'retry' });
      }
      // PENDING_* or UNCERTAIN / NEEDS_REVIEW: a person has to look before the desk trades again.
      return {
        ...nothing,
        status: final.status,
        txHashes,
        details,
        next: 'halt',
        message: `slice ${slice.id} is ${final.status}${final.failure_code ? ` (${final.failure_code})` : ''}; check ${final.correlation_id} before trading again`,
      };
    },
  };
}
