// Clocks for the engine. Schedule times are "order time" in milliseconds since
// the order started.

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wall clock. With `speed` above 1 the waits between slices are compressed
 * for demos, and order time advances only while waiting, so quote latency
 * does not eat into the compressed window. Quotes stay live either way.
 */
export function realClock({ speed = 1 } = {}) {
  if (!(speed > 0)) throw new Error('speed must be positive');
  const startedAt = Date.now();
  if (speed === 1) {
    const now = () => Date.now() - startedAt;
    return {
      speed,
      now,
      wallNow: () => Date.now(),
      async sleepUntil(orderMs) {
        const waitMs = orderMs - now();
        if (waitMs > 0) await pause(waitMs);
      },
    };
  }
  let t = 0;
  return {
    speed,
    now: () => t,
    wallNow: () => Date.now(),
    async sleepUntil(orderMs) {
      if (orderMs <= t) return;
      await pause((orderMs - t) / speed);
      t = orderMs;
    },
  };
}

/** Deterministic clock for tests: sleeping jumps time forward instantly. */
export function fakeClock({ wallStart = Date.UTC(2026, 10, 5) } = {}) {
  let t = 0;
  return {
    speed: 1,
    now: () => t,
    wallNow: () => wallStart + t,
    async sleepUntil(orderMs) {
      if (orderMs > t) t = orderMs;
    },
    advance(ms) {
      t += ms;
    },
  };
}
