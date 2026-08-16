// A concurrency limit shared across every batch, not per batch.
//
// pool() bounds one call. Start a second playlist while the first is running
// and you get two independent pools — eight tracks in flight, each fanning out
// ~40 segment requests, which is how you earn a 429 and lose both batches at
// once. The limit has to be global because the rate limit is.

/**
 * @param {number} max  slots available across all callers
 */
export function createLimiter(max) {
  let active = 0;
  const waiting = [];

  const release = () => {
    active--;
    waiting.shift()?.();
  };

  /** Run `fn` once a slot frees. Rejections propagate; the slot is still freed. */
  async function run(fn) {
    if (active >= max) await new Promise((resolve) => waiting.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  run.active = () => active;
  run.queued = () => waiting.length;
  return run;
}

/**
 * A limiter that learns the rate limit instead of assuming one.
 *
 * A fixed cap is a guess: too high and every track in a crate fails at once,
 * too low and a service that would happily take four requests gets one. This
 * does what congestion control does — additive increase, multiplicative
 * decrease. Start optimistic, halve on a refusal, and creep back up while it
 * keeps working.
 *
 * The cooldown is the part a plain limiter cannot express. When a 429 arrives,
 * every worker has to stop, not just the one that was told — the others are
 * mid-flight against the same service and will earn the next refusal. So the
 * penalty is a shared gate that all of them wait behind.
 */
export function createAdaptiveLimiter({ start = 3, min = 1, max = 6 } = {}) {
  let limit = start;
  let active = 0;
  let ok = 0;              // consecutive successes since the last penalty
  let gateUntil = 0;       // nobody starts before this
  const waiting = [];

  const pump = () => {
    while (active < limit && waiting.length) waiting.shift()();
  };

  async function run(fn) {
    if (active >= limit) await new Promise((resolve) => waiting.push(resolve));
    // Re-checked after waking, because the gate may have been set while queued.
    const wait = gateUntil - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));

    active++;
    try {
      return await fn();
    } finally {
      active--;
      pump();
    }
  }

  /** Told to slow down. Halve, and hold everyone for `ms`. */
  run.penalise = (ms = 4000) => {
    limit = Math.max(min, Math.floor(limit / 2));
    ok = 0;
    gateUntil = Math.max(gateUntil, Date.now() + ms);
  };

  /** A clean pass. Widen by one, but only after a few in a row. */
  run.reward = () => {
    if (++ok < 3 || limit >= max) return;
    ok = 0;
    limit++;
    pump();
  };

  run.limit = () => limit;
  run.active = () => active;
  return run;
}
