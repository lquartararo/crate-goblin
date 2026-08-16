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
