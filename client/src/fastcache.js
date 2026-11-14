// Speed, the way big webmail does it: show what we already have at once, then refresh it quietly.
// - Mail lists: the last copy of each folder shows instantly when you go back to it (and the inbox shows instantly
//   when the app opens, on devices where you chose to stay signed in).
// - Emails: the first few unread ones, and the one under your pointer, are loaded before you click.
//   Loading ahead never marks anything read or sends read receipts; that happens when you actually open it.
import { api, currentMailboxId, offlineAllowed } from './api.js';

const lists = new Map();
const opened = new Map(); // key -> Promise of { subject, messages }
const MAX_OPEN = 40;
const store = () => `rm-list:${currentMailboxId()}`;

export const listKey = (folder, filter, tab) => `${currentMailboxId()}|${folder}|${filter || ''}|${tab || ''}`;
export function cachedList(key) {
  if (lists.has(key)) return lists.get(key);
  if (key.split('|')[1] === 'INBOX' && offlineAllowed()) {
    try { const s = JSON.parse(localStorage.getItem(store()) || 'null'); if (s?.key === key) return s.data; } catch { /* */ }
  }
  return null;
}
export function saveList(key, data) {
  lists.set(key, data);
  if (key.split('|')[1] === 'INBOX' && offlineAllowed()) {
    try { localStorage.setItem(store(), JSON.stringify({ key, data: { ...data, messages: data.messages.slice(0, 50) } })); } catch { /* full */ }
  }
}

const openKey = (folder, uid, conv) => `${currentMailboxId()}|${folder}|${uid}|${conv ? 1 : 0}`;
const fetchOpen = (folder, uid, conv, peek) => (conv
  ? api.get('/api/thread', { folder, uid, ...(peek ? { peek: 1 } : {}) })
  : api.get('/api/message', { folder, uid, ...(peek ? { peek: 1 } : {}) }).then((m) => ({ subject: m.subject, messages: [m] })));

/** Load an email ahead of time (no read marks, no receipts). */
export function prefetch(folder, uid, conv) {
  const k = openKey(folder, uid, conv);
  if (opened.has(k) || String(uid).includes(':')) return;
  const p = fetchOpen(folder, uid, conv, true);
  p.catch(() => opened.delete(k));
  opened.set(k, p);
  if (opened.size > MAX_OPEN) opened.delete(opened.keys().next().value);
}
/** What we already loaded for this email (or null). */
export const prefetched = (folder, uid, conv) => opened.get(openKey(folder, uid, conv)) || null;
/** Really open it: marks it read and tells the sender, as before. */
export const openNow = (folder, uid, conv) => fetchOpen(folder, uid, conv, false).then((t) => { opened.set(openKey(folder, uid, conv), Promise.resolve(t)); return t; });

let queue = [];
let running = 0;
function pump() {
  while (running < 2 && queue.length) {
    const [f, u, c] = queue.shift();
    if (prefetched(f, u, c)) continue;
    running++;
    prefetch(f, u, c);
    Promise.resolve(prefetched(f, u, c)).catch(() => {}).finally(() => { running--; pump(); });
  }
}
/** After a list loads: quietly fetch the first few unread emails. */
export function warmList(folder, messages, conv) {
  if (navigator.connection?.saveData) return;
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 400));
  idle(() => {
    queue = messages.filter((m) => !m.seen).slice(0, 3).map((m) => [folder, m.uid, conv]);
    pump();
  });
}
export function clearFast() {
  lists.clear(); opened.clear(); queue = [];
  try { for (const k of Object.keys(localStorage)) if (k.startsWith('rm-list:')) localStorage.removeItem(k); } catch { /* */ }
}
