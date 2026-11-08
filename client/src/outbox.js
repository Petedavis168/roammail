// Outbox: emails sent while offline are kept on this device (IndexedDB, attachments included) and sent
// automatically when the connection is back. Cleared on sign-out with the rest of the offline copy.
import { api } from './api.js';

const DB = 'roammail-outbox';
const open = () => new Promise((res, rej) => {
  const r = indexedDB.open(DB, 1);
  r.onupgradeneeded = () => r.result.createObjectStore('outbox', { keyPath: 'id' });
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
const tx = async (mode, fn) => {
  const db = await open();
  return new Promise((res, rej) => { const t = db.transaction('outbox', mode); const out = fn(t.objectStore('outbox')); t.oncomplete = () => res(out?.result ?? out); t.onerror = () => rej(t.error); });
};

/** True when the failure was the network (offline, DNS, connection dropped), not the server saying no. */
export const isOffline = (e) => !navigator.onLine || e instanceof TypeError || /Failed to fetch|NetworkError|Load failed|network/i.test(String(e?.message || ''));

export async function queue(form, asMailbox, summary) {
  const fields = [];
  for (const [k, v] of form.entries()) fields.push(v instanceof File ? [k, v, v.name] : [k, v]);
  await tx('readwrite', (s) => s.put({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, fields, asMailbox: asMailbox || null, summary, created: Date.now() }));
}
export const outboxCount = () => tx('readonly', (s) => s.count()).catch(() => 0);

let flushing = false;
/** Send everything waiting. Returns { sent, failed: [{summary, error}] }. */
export async function flushOutbox() {
  if (flushing || !navigator.onLine) return { sent: 0, failed: [] };
  flushing = true;
  const out = { sent: 0, failed: [] };
  try {
    const items = await tx('readonly', (s) => s.getAll()).catch(() => []);
    for (const it of items.sort((a, b) => a.created - b.created)) {
      const fd = new FormData();
      for (const [k, v, name] of it.fields) name ? fd.append(k, v, name) : fd.append(k, v);
      try {
        await api.form('/api/send', fd, it.asMailbox || undefined);
        out.sent++;
        await tx('readwrite', (s) => s.delete(it.id));
      } catch (e) {
        if (isOffline(e)) break; // still offline: try again later
        out.failed.push({ summary: it.summary, error: e.message });
        await tx('readwrite', (s) => s.delete(it.id)); // the server refused it: hand it back to the person instead of retrying forever
      }
    }
  } finally { flushing = false; }
  return out;
}
export const clearOutbox = () => new Promise((res) => { const r = indexedDB.deleteDatabase(DB); r.onsuccess = r.onerror = r.onblocked = () => res(); });
