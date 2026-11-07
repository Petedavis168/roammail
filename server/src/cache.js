// Small in-process cache with TTL, a size bound, and single-flight (concurrent callers share one fetch).
// Phase 2 swaps this for Redis when several app servers run; the interface stays the same.
export function createCache({ ttlMs = 60_000, max = 5000 } = {}) {
  const store = new Map(); // key -> { at, value?, promise? }
  const evict = () => { while (store.size > max) store.delete(store.keys().next().value); };
  return {
    async get(key, load, ttl = ttlMs) {
      const hit = store.get(key);
      if (hit && Date.now() - hit.at < ttl) return hit.promise || hit.value;
      const promise = Promise.resolve().then(load);
      store.set(key, { at: Date.now(), promise });
      evict();
      try {
        const value = await promise;
        if (store.get(key)?.promise === promise) store.set(key, { at: Date.now(), value });
        return value;
      } catch (e) { if (store.get(key)?.promise === promise) store.delete(key); throw e; }
    },
    peek(key) { const h = store.get(key); return h && 'value' in h ? h.value : undefined; },
    set(key, value) { store.set(key, { at: Date.now(), value }); evict(); },
    delete(key) { store.delete(key); },
    deletePrefix(prefix) { for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k); },
    clear() { store.clear(); },
    get size() { return store.size; },
  };
}
