// Bounded-concurrency runner.
//
// Downloads were strictly sequential, which is fine for a 10-track crate and
// hopeless for a real one: a 295-track playlist at ~30s each is over two hours.
// Most of that is waiting on the network, so a handful of parallel workers cuts
// it roughly by the concurrency factor.
//
// Kept low on purpose. Each track fans out into ~40 segment requests of its
// own, so four tracks in flight is already ~24 concurrent connections once the
// HLS fetcher's own pool is counted — push it higher and SoundCloud starts
// answering with 429s, which costs more time than it saves.

/**
 * Run `worker` over `items`, at most `limit` at a time, preserving input order
 * in the results.
 *
 * Never rejects: a worker that throws yields { ok: false, error } in its slot,
 * so one bad track can't abandon the rest of the queue.
 *
 * @param {Array} items
 * @param {number} limit
 * @param {(item: any, index: number) => Promise<any>} worker
 */
export async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  async function run() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = { ok: true, value: await worker(items[i], i) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}
