// Status polling for Agent API operations. No dependencies, so the executor
// and its tests run without the SDK installed.

const MOVING = new Set(['PROCESSING', 'QUEUED']);

/**
 * Polls an operation until it stops moving: a terminal status, a status that
 * needs a person (PENDING_*), or one that needs reconciliation (UNCERTAIN,
 * NEEDS_REVIEW). Throws a TimeoutError after `timeoutMs`.
 */
export async function waitForStatus(api, correlationId, timeoutMs = 180_000) {
  const signal = AbortSignal.timeout(timeoutMs);
  for (;;) {
    signal.throwIfAborted();
    const status = await api.getStatus(correlationId, { waitMs: 30_000, signal });
    if (!MOVING.has(status.status)) return status;
  }
}
