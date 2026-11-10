// Smart inbox tabs: Primary (people), Updates (receipts, alerts, notifications from automated senders) and
// Newsletters (anything with an unsubscribe header). Worked out with a few IMAP searches on the server, so it
// covers the whole inbox, not just the page you're looking at. Nothing is moved: it's only a view.
const cache = new Map(); // owner|uidValidity|uidNext|exists -> { at, sets }
const CACHE_MS = 20e3;

// Automated senders, by the part before the @ (searched as substrings of From)
const AUTO_FROM = ['noreply', 'no-reply', 'donotreply', 'do-not-reply', 'notification', 'mailer-daemon', 'postmaster', 'alerts@', 'alert@', 'receipts@', 'orders@', 'billing@', 'updates@', 'invoice@', 'statements@'];

async function searchUnion(client, crits) {
  const out = new Set();
  for (const c of crits) for (const u of (await client.search(c, { uid: true }).catch(() => [])) || []) out.add(u);
  return out;
}

/** The UIDs of the current mailbox (must be INBOX, already open) in each tab. */
export async function inboxTabs(client) {
  const mb = client.mailbox;
  const key = `${client.options?.auth?.user}|${mb.uidValidity}|${mb.uidNext}|${mb.exists}|${mb.highestModseq || ''}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.sets;
  const all = ((await client.search({ all: true }, { uid: true })) || []);
  const newsletters = await searchUnion(client, [{ header: { 'list-unsubscribe': '' } }, { header: { 'list-id': '' } }]);
  const autoish = await searchUnion(client, [
    ...AUTO_FROM.map((f) => ({ header: { from: f } })),
    { header: { 'auto-submitted': 'auto' } }, { header: { precedence: 'bulk' } }, { header: { 'content-type': 'multipart/report' } },
  ]);
  const updates = new Set([...autoish].filter((u) => !newsletters.has(u)));
  const primary = new Set(all.filter((u) => !newsletters.has(u) && !updates.has(u)));
  const unseen = new Set((await client.search({ seen: false }, { uid: true })) || []);
  const count = (s) => { let n = 0; for (const u of s) if (unseen.has(u)) n++; return n; };
  const sets = {
    primary, updates, newsletters,
    unread: { primary: count(primary), updates: count(updates), newsletters: count(newsletters) },
  };
  cache.set(key, { at: Date.now(), sets });
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return sets;
}
export const TABS = ['primary', 'updates', 'newsletters'];
