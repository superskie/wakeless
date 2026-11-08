// Live executor: sends each slice through the Wakeless agent on the NEAR
// Intents Agent API as a confidential swap whose minimum output is the desk's
// price floor, then follows it to a settled status. In `preview` mode it stops
// at the agent's own preview and nothing is submitted.
//
// No SDK import here: the API clients are passed in, so tests use fakes.
//
// A slice is never sent twice. A new idempotency key means new work to the
// API, so a slice moves to a new key only after an outcome that proves its
// earlier attempt traded nothing: a refusal the Agent API documents as sent
// before anything ran, REFUNDED, or FAILED with never_executed or
// never_submitted. Any other submit failure (no answer, an abort, a 5xx, a
// 409 or 429 that stays, an unknown code) may have executed upstream, so the
// order stops with outcome UNKNOWN and the key, and a person checks the
// agent's history before anything else is sent.
import { minOutAtRate } from '../units.mjs';
import { safeErrorText } from '../oneclick.mjs';
import { waitForStatus } from '../agent/status.mjs';

/**
 * Submit refusals the Agent API documents as refusing the request before
 * anything was sent (request, grant, policy, budget and balance rules), which
 * waiting does not fix: the order stops, and nothing was sent.
 */
const REFUSED_FOR_GOOD = new Set([
  'validation_failed', 'unsupported_chain', 'unsupported_token', 'invalid_address', 'refund_address_required',
  'agent_grant_required', 'authorization_stale',
  'policy_action_denied', 'policy_asset_denied', 'policy_transaction_limit_exceeded', 'policy_limit_exceeded',
  'policy_action_limit_exceeded', 'policy_destination_denied', 'policy_schedule_denied', 'policy_not_ready', 'policy_denied',
  'spend_budget_exceeded', 'insufficient_balance', 'provider_limit_reached',
  'wallet_frozen', 'agent_archived', 'agent_deleted',
]);
/**
 * Refusals documented as sending nothing that can clear later (a route, a
 * busy wallet, a price or usage figure the API could not read yet): the slice
 * waits and may go again under a new key.
 */
const REFUSED_FOR_NOW = new Set(['route_unavailable', 'wallet_busy', 'provider_rate_limited', 'amount_too_low', 'spend_price_unavailable', 'policy_usage_unavailable']);
/** The hosted desk's proxy refuses these itself, before forwarding anything upstream. */
const PROXY_FOR_GOOD = new Set(['hosted_rule', 'confidential_required', 'grant_required', 'bad_idempotency_key', 'bad_json', 'body_too_large', 'not_proxied', 'proxy_not_configured', 'bad_query', 'json_required', 'cross_site']);
const PROXY_FOR_NOW = new Set(['rate_limited', 'prices_unavailable']);

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `meta.retryable`: the SDK's error has it as a field, a plain HTTP client keeps the error document. */
const retryable = (err) => err?.retryable === true || err?.document?.errors?.[0]?.meta?.retryable === true;

/**
 * What one failed submit proves:
 * - `refused`: refused before anything was sent, and waiting will not help.
 * - `refused_for_now`: refused before anything was sent, may clear later.
 * - `unknown`: it may have executed (no answer, abort, 5xx, a retryable
 *   throttle, 409 on earlier work under the key, any code not listed above).
 */
export function submitFailure(err) {
  const code = err?.code ?? null;
  const status = err?.status ?? null;
  if (status == null || status >= 500 || retryable(err)) return 'unknown';
  if (err?.layer === 'proxy') return PROXY_FOR_GOOD.has(code) ? 'refused' : PROXY_FOR_NOW.has(code) ? 'refused_for_now' : 'unknown';
  if (REFUSED_FOR_GOOD.has(code)) return 'refused';
  if (REFUSED_FOR_NOW.has(code)) return 'refused_for_now';
  // An API key or grant the server does not accept: refused before anything ran.
  if ((status === 401 || status === 403) && (err?.layer === 'auth' || err?.layer === 'grant')) return 'refused';
  return 'unknown';
}

/**
 * Submit, retrying only under the same idempotency key, which replays the
 * first request instead of adding one. A refusal proves nothing was sent only
 * on the first attempt: after a lost reply, a replay's refusal can not say
 * whether the first request ran.
 */
async function submitSwap(bot, agentId, body, idempotencyKey, { attempts = 3, backoffMs = 1_500, maxWaitMs = 30_000 } = {}) {
  const tries = [];
  for (let attempt = 1; ; attempt++) {
    try {
      return { submitted: await bot.swap(agentId, body, { idempotencyKey }), tries };
    } catch (err) {
      const kind = submitFailure(err);
      tries.push({ httpStatus: err?.status ?? null, code: err?.code ?? null, kind, error: safeErrorText(err) });
      if (kind !== 'unknown' || attempt >= attempts) {
        return { err, tries, kind: kind !== 'unknown' && attempt === 1 ? kind : 'unknown' };
      }
      const wait = Number(err?.retryAfterSeconds) > 0 ? Number(err.retryAfterSeconds) * 1000 : backoffMs * attempt;
      await pause(Math.min(wait, maxWaitMs));
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

      // Without a positive floor the swap would carry min_amount_out 0 and settle at any price.
      if (!(floorRate > 0) || minAmountOut <= 0n) {
        return {
          ...nothing,
          status: 'NO_FLOOR',
          details: { floorRate: floorRate ?? null },
          next: 'halt',
          message: `slice ${slice.id} has no usable price floor (floor rate ${floorRate}); nothing was submitted`,
        };
      }

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

      const sent = await submitSwap(bot, agentId, body, idempotencyKey, submitOptions);
      if (!sent.submitted) {
        const { err, kind, tries } = sent;
        const text = safeErrorText(err);
        const details = { idempotencyKey, httpStatus: err?.status ?? null, code: err?.code ?? null, failureReason: text, attempts: tries };
        if (kind === 'refused') {
          return {
            ...nothing,
            status: 'REJECTED',
            details: { ...details, nothingSent: true },
            next: 'halt',
            message: `the Agent API refused the swap before sending anything: ${err?.code ?? err?.status} ${text}`.trim(),
          };
        }
        if (kind === 'refused_for_now') return miss({ ...nothing, status: 'REJECTED', details: { ...details, nothingSent: true }, next: 'retry' });
        // Nothing proves the swap was not executed: stop, and keep the key so its outcome can be looked up.
        return {
          ...nothing,
          status: 'UNKNOWN',
          details: { ...details, failureReason: `outcome unknown: ${text}`, unsettledAmountIn: amountIn.toString(), minAmountOut: minAmountOut.toString() },
          next: 'halt',
          message:
            `the submit of slice ${slice.id} ended without a clear answer (${err?.status ? `HTTP ${err.status} ` : ''}${err?.code ?? text}), so it may have executed; ` +
            `check idempotency key ${idempotencyKey} in the agent's history before trading again`,
        };
      }
      const submitted = sent.submitted;

      let final;
      try {
        final = await waitForStatus(api, submitted.correlation_id, statusTimeoutMs);
      } catch (err) {
        return {
          ...nothing,
          status: 'TIMEOUT',
          details: { idempotencyKey, correlationId: submitted.correlation_id, failureReason: safeErrorText(err) },
          next: 'halt',
          message: `slice ${slice.id}: ${safeErrorText(err)}; check ${submitted.correlation_id} before trading again`,
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
      // REFUNDED: nothing traded and the funds went back to the agent, so the slice may go again later
      // under a new key; the next preview checks the balance before anything is sent. FAILED proves
      // nothing ran only with never_executed or never_submitted (the Agent API's rule for a new key).
      const neverRan = d.never_executed === true || d.never_submitted === true;
      if (final.status === 'REFUNDED' || (final.status === 'FAILED' && neverRan)) {
        return miss({ ...nothing, status: final.status, txHashes, details: { ...details, neverRan }, next: 'retry' });
      }
      if (final.status === 'FAILED') {
        return {
          ...nothing,
          status: 'FAILED',
          txHashes,
          details: { ...details, neverRan },
          next: 'halt',
          message: `slice ${slice.id} FAILED${final.failure_code ? ` (${final.failure_code})` : ''} without proof that nothing ran; check ${final.correlation_id} and the balances before trading again`,
        };
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
