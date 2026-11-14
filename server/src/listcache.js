// Fast mail lists: keep the last answer for each folder page and reuse it while the folder hasn't changed.
// "Hasn't changed" is decided by the mail server itself (CONDSTORE: a change counter that goes up on every new,
// deleted or re-flagged email, from any app or phone), so a reused list is always exactly what a fresh one would be.
// Mail servers without CONDSTORE simply don't use this. Kept in memory only, per app server, for 10 minutes.
const MAX = 800;
const TTL = 10 * 60e3;
const cache = new Map(); // key -> { sig, at, value }
export const listCacheStats = { hits: 0, misses: 0 };

/** The folder's change marker, or null if the server can't tell us. */
export async function folderSignature(client) {
  const mb = client.mailbox;
  if (!mb?.path || !client.capabilities?.has?.('CONDSTORE')) return null;
  const st = await client.status(mb.path, { messages: true, uidNext: true, highestModseq: true }).catch(() => null);
  if (!st?.highestModseq) return null;
  return `${mb.uidValidity}:${st.uidNext}:${st.messages}:${st.highestModseq}`;
}

/** compute() runs only when the folder changed since the cached answer. */
export async function cachedList(client, key, compute) {
  const sig = await folderSignature(client);
  if (!sig) return compute();
  const hit = cache.get(key);
  if (hit && hit.sig === sig && Date.now() - hit.at < TTL) {
    cache.delete(key); cache.set(key, hit); // most recently used
    listCacheStats.hits++;
    return structuredClone(hit.value);
  }
  listCacheStats.misses++;
  const value = await compute();
  cache.set(key, { sig, at: Date.now(), value: structuredClone(value) });
  while (cache.size > MAX) cache.delete(cache.keys().next().value);
  return value;
}
/** Forget everything about a mailbox (sign-out, deletion). */
export function forgetLists(email) {
  const p = `${String(email).toLowerCase()}|`;
  for (const k of cache.keys()) if (k.startsWith(p)) cache.delete(k);
}
