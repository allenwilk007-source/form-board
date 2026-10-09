/**
 * Runs `fn` over every item, `limit` at a time, keeping results in the items' order. The first
 * failure stops every worker from starting anything new: once one item has failed the whole run
 * has, and anything else fetched would only be thrown away.
 */
export async function inOrder<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i]);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
