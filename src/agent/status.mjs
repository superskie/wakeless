// Status polling for Agent API operations. No dependencies, so the executor
// and its tests run without the SDK installed.

const MOVING = new Set(['PROCESSING', 'QUEUED']);

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A poll that failed on the way (no answer, a 5xx, a 429) says nothing about
 * the operation, and polling is read-only, so it is simply asked again.
 */
function transient(err) {
  return err?.status == null || err.status >= 500 || err.status === 429;
}

/** The server's own wait, when it sent one (SDK errors carry Retry-After as seconds). */
function retryAfterMs(err) {
  const seconds = Number(err?.retryAfterSeconds);
  return seconds > 0 ? seconds * 1000 : null;
}

const describe = (err) => {
  const text = String(err?.message ?? err ?? '');
  return err?.status ? `HTTP ${err.status}${err.code ? ` ${err.code}` : ''}: ${text}` : text;
};

/**
 * Polls an operation until it stops moving: a terminal status, a status that
 * needs a person (PENDING_*), or one that needs reconciliation (UNCERTAIN,
 * NEEDS_REVIEW). Failed polls (network, 5xx, 429) are retried with backoff
 * until the deadline, and polls are at least `minGapMs` apart even when a
 * long-poll answers early. Throws a TimeoutError after `timeoutMs` that names
 * the last failed poll; a refusal such as 404 or 401 is thrown at once.
 *
 * @param {{ getStatus: Function }} api
 * @param {string} correlationId
 * @param {number} [timeoutMs]
 * @param {object} [opts] `sleep` and `now` replace the real timers in tests
 */
export async function waitForStatus(
  api,
  correlationId,
  timeoutMs = 180_000,
  { minGapMs = 2_000, maxBackoffMs = 15_000, sleep = pause, now = () => Date.now() } = {},
) {
  const signal = AbortSignal.timeout(timeoutMs);
  const deadline = now() + timeoutMs;
  const left = () => Math.max(0, deadline - now());
  let failures = 0;
  let lastError = null;
  for (;;) {
    if (signal.aborted || left() === 0) {
      const err = new Error(`no settled status after ${Math.round(timeoutMs / 1000)}s${lastError ? ` (the last poll failed: ${describe(lastError)})` : ''}`);
      err.name = 'TimeoutError';
      err.lastError = lastError;
      throw err;
    }
    const started = now();
    try {
      const status = await api.getStatus(correlationId, { waitMs: 30_000, signal });
      failures = 0;
      lastError = null;
      if (!MOVING.has(status.status)) return status;
      // A long-poll that came back early still waits, so a server that does not long-poll is not hammered.
      const gap = minGapMs - (now() - started);
      if (gap > 0) await sleep(Math.min(gap, left()));
    } catch (err) {
      if (signal.aborted) continue;
      if (!transient(err)) throw err;
      lastError = err;
      failures += 1;
      const backoff = retryAfterMs(err) ?? Math.min(1_000 * 2 ** (failures - 1), maxBackoffMs);
      await sleep(Math.min(Math.max(backoff, minGapMs), left()));
    }
  }
}
