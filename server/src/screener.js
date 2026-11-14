// The Screener: email from people you've never dealt with waits in a "Screener" folder until you say yes or no.
// Yes: their emails move to your inbox and they always get through. No: they go to Junk from now on.
//
// "People you've dealt with" = everyone you've ever emailed (learned from Sent when you switch it on, and every
// time you send), everyone already in your inbox when you switch it on, and anyone at your own company.
// It runs on the mail server (Sieve), so it works in every app, even when Roammail isn't open.
import express from 'express';
import { q, userSetting, setUserSetting, audit } from './db.js';
import { requireAuth } from './session.js';
import { getClient, withMailbox, specialFolder } from './imap.js';
import { syncSieve, setScreenerSource } from './mailtools.js';
import { rateLimit } from './shared.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>".]{1,63}(?:\.[^\s@<>".]{1,63}){1,8}$/;
export const SCREENER_FOLDER = 'Screener';
const MAX_ALLOW = 8000; // newest; keeps the server rule a sensible size
const SEED_LIMIT = 5000; // messages looked at in Sent and Inbox when switching on

setScreenerSource(async (email) => {
  const s = await userSetting(email, 'screener', null);
  if (!s?.enabled) return null;
  const rows = await q.all('SELECT address, decision FROM screener_list WHERE email = ? ORDER BY at DESC', email);
  return {
    enabled: true,
    allow: rows.filter((r) => r.decision === 'allow').slice(0, MAX_ALLOW).map((r) => r.address),
    block: rows.filter((r) => r.decision === 'block').slice(0, 2000).map((r) => r.address),
  };
});

async function remember(email, addresses, decision, source) {
  let added = 0;
  for (const a of addresses) {
    const addr = String(a || '').trim().toLowerCase();
    if (!EMAIL_RE.test(addr) || addr === email.toLowerCase()) continue;
    if (decision === 'allow' && source === 'sent') {
      const r = await q.run('INSERT INTO screener_list(email, address, decision, source, at) VALUES(?, ?, ?, ?, ?) ON CONFLICT(email, address) DO NOTHING', email, addr, 'allow', source, Date.now());
      added += r.changes || 0;
    } else {
      await q.run('INSERT INTO screener_list(email, address, decision, source, at) VALUES(?, ?, ?, ?, ?) ON CONFLICT(email, address) DO UPDATE SET decision = excluded.decision, source = excluded.source, at = excluded.at', email, addr, decision, source, Date.now());
      added++;
    }
  }
  return added;
}

/** Everyone you've written to, and everyone already in your inbox. */
async function seed(user) {
  const client = await getClient(user);
  const boxes = await client.list();
  const sent = boxes.find((b) => b.specialUse === '\\Sent')?.path;
  const people = new Set();
  for (const [box, fields] of [[sent, ['to', 'cc', 'bcc']], ['INBOX', ['from']]]) {
    if (!box) continue;
    await withMailbox(user, box, async (c) => {
      const total = c.mailbox.exists;
      if (!total) return;
      for await (const m of c.fetch(`${Math.max(1, total - SEED_LIMIT + 1)}:${total}`, { envelope: true })) {
        for (const f of fields) for (const a of m.envelope?.[f] || []) if (a.address) people.add(a.address.toLowerCase());
      }
    }, { readOnly: true });
  }
  await remember(user.email, [...people], 'allow', 'sent');
  await client.mailboxCreate(SCREENER_FOLDER).catch(() => {}); // already there is fine
  return people.size;
}

/** Called after every send: people you write to always get through. */
const pending = new Map();
export async function learnRecipients(email, addresses) {
  const s = await userSetting(email, 'screener', null);
  if (!s?.enabled) return;
  const added = await remember(email, addresses, 'allow', 'sent');
  if (!added) return;
  clearTimeout(pending.get(email));
  pending.set(email, setTimeout(() => { pending.delete(email); syncSieve({ email }).catch((e) => console.warn('screener sync failed', e.message)); }, 3000).unref());
}

/** Who is waiting in the Screener, grouped by sender. */
async function waiting(user) {
  const out = new Map();
  try {
    await withMailbox(user, SCREENER_FOLDER, async (c) => {
      const total = c.mailbox.exists;
      if (!total) return;
      for await (const m of c.fetch(`${Math.max(1, total - 500 + 1)}:${total}`, { uid: true, envelope: true, internalDate: true, flags: true })) {
        const f = m.envelope?.from?.[0]; const a = String(f?.address || '').toLowerCase();
        if (!a) continue;
        const date = new Date(m.internalDate || m.envelope?.date || 0).getTime();
        const s = out.get(a) || { address: a, name: f.name || '', count: 0, last: 0, subject: '', uids: [] };
        s.count++; s.uids.push(m.uid);
        if (date > s.last) { s.last = date; s.subject = m.envelope?.subject || ''; if (f.name) s.name = f.name; }
        out.set(a, s);
      }
    }, { readOnly: true });
  } catch { /* no Screener folder yet */ }
  return [...out.values()].sort((a, b) => b.last - a.last);
}

export const screenerApi = express.Router();
screenerApi.use('/screener', requireAuth);

screenerApi.get('/screener', wrap(async (req, res) => {
  const s = await userSetting(req.user.email, 'screener', { enabled: false });
  const allowed = Number((await q.get("SELECT COUNT(*) AS n FROM screener_list WHERE email = ? AND decision = 'allow'", req.user.email)).n);
  res.json({ enabled: !!s.enabled, allowed, waiting: s.enabled ? (await waiting(req.user)).map(({ uids, ...x }) => x) : [] });
}));

screenerApi.put('/screener', rateLimit({ windowMs: 60e3, limit: 10 }), wrap(async (req, res) => {
  if (req.delegatedMailbox) throw fail(403, 'Turn the Screener on from your own mailbox');
  const enabled = !!req.body.enabled;
  let learned = 0;
  if (enabled) learned = await seed(req.user);
  await setUserSetting(req.user.email, 'screener', { enabled, since: enabled ? Date.now() : null });
  await syncSieve(req.user);
  if (!enabled) { // turning it off: anything still waiting goes back to the inbox
    try {
      await withMailbox(req.user, SCREENER_FOLDER, async (c) => { if (c.mailbox.exists) await c.messageMove('1:*', 'INBOX'); });
    } catch { /* nothing there */ }
  }
  await audit(req.user.email, null, enabled ? 'screener.on' : 'screener.off', { learned });
  res.json({ enabled, learned });
}));

screenerApi.post('/screener/decide', rateLimit({ windowMs: 60e3, limit: 120 }), wrap(async (req, res) => {
  const address = String(req.body.address || '').trim().toLowerCase();
  if (!EMAIL_RE.test(address)) throw fail(400, 'Pick a sender');
  const decision = req.body.decision === 'block' ? 'block' : 'allow';
  await remember(req.user.email, [address], decision, 'you');
  await syncSieve(req.user);
  // move what they've already sent
  const sender = (await waiting(req.user)).find((s) => s.address === address);
  let moved = 0;
  if (sender?.uids.length) {
    const dest = decision === 'allow' ? 'INBOX' : (await specialFolder(req.user, '\\Junk', { create: true })) || 'Junk';
    await withMailbox(req.user, SCREENER_FOLDER, (c) => c.messageMove(sender.uids.join(','), dest, { uid: true }));
    moved = sender.uids.length;
  }
  res.json({ ok: true, decision, moved });
}));

export async function deleteScreener(email) { await q.run('DELETE FROM screener_list WHERE email = ?', email); }
