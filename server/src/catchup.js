// Catch up: never feel buried by unread email.
//  - a summary of what's unread and one-tap clean-ups (all unread newsletters, all unread updates, anything old,
//    or everything from one sender: mark read or archive)
//  - auto-tidy (opt-in): newsletters marked read after N days, updates archived after N days, anything unread older
//    than N days marked read. Runs when you open your inbox (at most a few times a day), on the server.
import express from 'express';
import { userSetting, setUserSetting, audit } from './db.js';
import { requireAuth } from './session.js';
import { withMailbox, specialFolder } from './imap.js';
import { inboxTabs } from './inboxtabs.js';
import { rateLimit } from './shared.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>".]{1,63}(?:\.[^\s@<>".]{1,63}){1,8}$/;
const DAY = 864e5;
const DEFAULTS = { newsletters: 0, updates: 0, old: 0 }; // days; 0 = off
const lastTidy = new Map();

async function unreadSets(client, olderThanDays = 30) {
  const tabs = await inboxTabs(client);
  const unseen = new Set((await client.search({ seen: false }, { uid: true })) || []);
  const old = new Set((await client.search({ seen: false, before: new Date(Date.now() - olderThanDays * DAY) }, { uid: true })) || []);
  const pick = (s) => [...s].filter((u) => unseen.has(u));
  return { unseen, newsletters: pick(tabs.newsletters), updates: pick(tabs.updates), primary: pick(tabs.primary), old: [...old] };
}

async function apply(user, client, uids, action) {
  if (!uids.length) return 0;
  const range = uids.slice(0, 20000).join(',');
  if (action === 'archive') {
    const dest = await specialFolder(user, '\\Archive', { create: true });
    await client.messageFlagsAdd(range, ['\\Seen'], { uid: true });
    await client.messageMove(range, dest, { uid: true });
  } else await client.messageFlagsAdd(range, ['\\Seen'], { uid: true });
  return uids.length;
}

export const catchupApi = express.Router();
catchupApi.use('/catchup', requireAuth);

catchupApi.get('/catchup', rateLimit({ windowMs: 60e3, limit: 30 }), wrap(async (req, res) => {
  const data = await withMailbox(req.user, 'INBOX', async (c) => {
    const s = await unreadSets(c);
    // who sent the most unread (top 8 with 3+)
    const bySender = new Map();
    const sample = [...s.unseen].sort((a, b) => b - a).slice(0, 3000);
    if (sample.length) {
      for await (const m of c.fetch(sample.join(','), { uid: true, envelope: true }, { uid: true })) {
        const f = m.envelope?.from?.[0]; const a = String(f?.address || '').toLowerCase();
        if (!a) continue;
        const x = bySender.get(a) || { address: a, name: f.name || '', count: 0 };
        x.count++; if (!x.name && f.name) x.name = f.name;
        bySender.set(a, x);
      }
    }
    return {
      unread: s.unseen.size, primary: s.primary.length, newsletters: s.newsletters.length, updates: s.updates.length, old: s.old.length,
      senders: [...bySender.values()].filter((x) => x.count >= 3).sort((a, b) => b.count - a.count).slice(0, 8),
    };
  });
  res.json({ ...data, settings: { ...DEFAULTS, ...(await userSetting(req.user.email, 'autotidy', {})) } });
}));

catchupApi.post('/catchup/apply', rateLimit({ windowMs: 60e3, limit: 30 }), wrap(async (req, res) => {
  const what = String(req.body.what || '');
  const action = req.body.action === 'archive' ? 'archive' : 'read';
  const done = await withMailbox(req.user, 'INBOX', async (c) => {
    if (what === 'sender') {
      const a = String(req.body.address || '').toLowerCase();
      if (!EMAIL_RE.test(a)) throw fail(400, 'Pick a sender');
      const uids = [];
      const found = (await c.search({ seen: false, header: { from: a } }, { uid: true })) || [];
      if (found.length) for await (const m of c.fetch(found.join(','), { uid: true, envelope: true }, { uid: true })) if (String(m.envelope?.from?.[0]?.address || '').toLowerCase() === a) uids.push(m.uid);
      return apply(req.user, c, uids, action);
    }
    if (!['newsletters', 'updates', 'old', 'all'].includes(what)) throw fail(400, 'Pick what to clean up');
    const s = await unreadSets(c);
    return apply(req.user, c, what === 'all' ? [...s.unseen] : s[what], action);
  });
  await audit(req.user.email, null, 'catchup.apply', { what, action, done });
  res.json({ ok: true, done });
}));

catchupApi.put('/catchup/settings', wrap(async (req, res) => {
  const d = (v, ok) => (ok.includes(Number(v)) ? Number(v) : 0);
  const s = { newsletters: d(req.body.newsletters, [0, 1, 3, 7]), updates: d(req.body.updates, [0, 3, 7, 14]), old: d(req.body.old, [0, 30, 60, 90]) };
  await setUserSetting(req.user.email, 'autotidy', s);
  lastTidy.delete(req.user.email);
  res.json(s);
}));

/** Auto-tidy: the client calls this when the inbox opens; it does the work at most every 3 hours. */
catchupApi.post('/catchup/autotidy', wrap(async (req, res) => {
  if (req.delegatedMailbox) return res.json({ ok: true, skipped: true });
  const s = { ...DEFAULTS, ...(await userSetting(req.user.email, 'autotidy', {})) };
  if (!s.newsletters && !s.updates && !s.old) return res.json({ ok: true, off: true });
  if (Date.now() - (lastTidy.get(req.user.email) || 0) < 3 * 3600e3 && req.body.force !== true) return res.json({ ok: true, skipped: true });
  lastTidy.set(req.user.email, Date.now());
  const done = await withMailbox(req.user, 'INBOX', async (c) => {
    const before = (days) => new Date(Date.now() - days * DAY);
    const tabs = await inboxTabs(c);
    const r = { newsletters: 0, updates: 0, old: 0 };
    if (s.newsletters) { const old = new Set((await c.search({ seen: false, before: before(s.newsletters) }, { uid: true })) || []); r.newsletters = await apply(req.user, c, [...tabs.newsletters].filter((u) => old.has(u)), 'read'); }
    if (s.updates) { const old = new Set((await c.search({ before: before(s.updates) }, { uid: true })) || []); r.updates = await apply(req.user, c, [...tabs.updates].filter((u) => old.has(u)), 'archive'); }
    if (s.old) r.old = await apply(req.user, c, (await c.search({ seen: false, before: before(s.old) }, { uid: true })) || [], 'read');
    return r;
  });
  if (done.newsletters || done.updates || done.old) await audit(req.user.email, null, 'catchup.autotidy', done);
  res.json({ ok: true, done });
}));
