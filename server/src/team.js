// Team inboxes: working a shared mailbox (support@, sales@) together.
//  - assign an email to a teammate (they're told straight away)
//  - private team notes on an email (never sent to the customer)
//  - "Ann is replying": who has the email open or is writing a reply right now, so two people don't answer twice
// Emails are identified by their Message-ID, so assignments and notes follow them between folders.
// Only members of the shared mailbox see or change any of this.
import express from 'express';
import { q, audit } from './db.js';
import { requireAuth } from './session.js';
import { rateLimit } from './shared.js';
import { pushLive } from './live.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const PRESENCE_MS = 40_000;
const cleanId = (v) => { const s = String(v || '').trim(); if (!/^<?[^<>\s]{3,300}>?$/.test(s)) throw fail(400, 'Unknown email'); return s.replace(/^<|>$/g, '').toLowerCase(); };

/** The shared mailbox this request is about, after checking the person is a member of it. */
async function teamOf(req) {
  const mailbox = String(req.delegatedMailbox || '').toLowerCase();
  if (!mailbox) throw fail(400, 'Open a shared mailbox first');
  const me = req.user.email.toLowerCase();
  if (!(await q.get('SELECT 1 FROM shared_access WHERE mailbox = ? AND member = ?', mailbox, me))) throw fail(403, 'You’re not a member of this mailbox');
  return { mailbox, me };
}
const members = async (mailbox) => (await q.all(`SELECT a.member AS email, COALESCE(p.name, '') AS name FROM shared_access a LEFT JOIN profiles p ON p.email = a.member
  WHERE a.mailbox = ? ORDER BY a.member`, mailbox).catch(() => q.all('SELECT member AS email, \'\' AS name FROM shared_access WHERE mailbox = ? ORDER BY member', mailbox)));
const tell = async (mailbox, event, data, except) => { for (const m of await members(mailbox)) if (m.email !== except) pushLive(m.email, event, { mailbox, ...data }); };
const nameOf = (list, email) => list.find((m) => m.email === email)?.name || email.split('@')[0];

export const teamApi = express.Router();
teamApi.use('/team', requireAuth);

// For the message list: who each email is assigned to, and how many notes it has
teamApi.get('/team', wrap(async (req, res) => {
  const { mailbox } = await teamOf(req);
  const ids = String(req.query.ids || '').split(',').map((x) => x.trim().replace(/^<|>$/g, '').toLowerCase()).filter(Boolean).slice(0, 200);
  const list = await members(mailbox);
  const out = { members: list, assign: {}, notes: {} };
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    for (const r of await q.all(`SELECT msgid, assignee FROM team_assign WHERE mailbox = ? AND msgid IN (${ph})`, mailbox, ...ids)) out.assign[r.msgid] = { email: r.assignee, name: nameOf(list, r.assignee) };
    for (const r of await q.all(`SELECT msgid, COUNT(*) AS n FROM team_notes WHERE mailbox = ? AND msgid IN (${ph}) GROUP BY msgid`, mailbox, ...ids)) out.notes[r.msgid] = Number(r.n);
  }
  res.json(out);
}));

// One email: assignment, notes, and who else has it open
teamApi.get('/team/message', wrap(async (req, res) => {
  const { mailbox, me } = await teamOf(req);
  const msgid = cleanId(req.query.id);
  const list = await members(mailbox);
  const a = await q.get('SELECT assignee, by_email, at FROM team_assign WHERE mailbox = ? AND msgid = ?', mailbox, msgid);
  const notes = await q.all('SELECT id, author, body, at FROM team_notes WHERE mailbox = ? AND msgid = ? ORDER BY at', mailbox, msgid);
  const here = await q.all('SELECT email, state, at FROM team_presence WHERE mailbox = ? AND msgid = ? AND at > ? AND email <> ?', mailbox, msgid, Date.now() - PRESENCE_MS, me);
  res.json({
    me, members: list,
    assignee: a ? { email: a.assignee, name: nameOf(list, a.assignee), by: nameOf(list, a.by_email), at: Number(a.at) } : null,
    notes: notes.map((n) => ({ id: Number(n.id), author: n.author, name: nameOf(list, n.author), body: n.body, at: Number(n.at), mine: n.author === me })),
    others: here.map((p) => ({ email: p.email, name: nameOf(list, p.email), state: p.state })),
  });
}));

teamApi.post('/team/assign', rateLimit({ windowMs: 60e3, limit: 60 }), wrap(async (req, res) => {
  const { mailbox, me } = await teamOf(req);
  const msgid = cleanId(req.body.id);
  const to = req.body.to ? String(req.body.to).toLowerCase() : null;
  const list = await members(mailbox);
  if (to && !list.some((m) => m.email === to)) throw fail(400, 'They aren’t a member of this mailbox');
  if (to) await q.run('INSERT INTO team_assign(mailbox, msgid, assignee, by_email, at) VALUES(?, ?, ?, ?, ?) ON CONFLICT(mailbox, msgid) DO UPDATE SET assignee = excluded.assignee, by_email = excluded.by_email, at = excluded.at', mailbox, msgid, to, me, Date.now());
  else await q.run('DELETE FROM team_assign WHERE mailbox = ? AND msgid = ?', mailbox, msgid);
  await audit(me, null, 'team.assign', { mailbox, to });
  await tell(mailbox, 'team', { id: msgid, kind: 'assign', to, toName: to ? nameOf(list, to) : null, byName: nameOf(list, me), subject: String(req.body.subject || '').slice(0, 140) }, me);
  res.json({ ok: true });
}));

teamApi.post('/team/notes', rateLimit({ windowMs: 60e3, limit: 30 }), wrap(async (req, res) => {
  const { mailbox, me } = await teamOf(req);
  const msgid = cleanId(req.body.id);
  const body = String(req.body.body || '').trim().slice(0, 4000);
  if (!body) throw fail(400, 'Write a note');
  const id = await q.insert('INSERT INTO team_notes(mailbox, msgid, author, body, at) VALUES(?, ?, ?, ?, ?)', mailbox, msgid, me, body, Date.now());
  await tell(mailbox, 'team', { id: msgid, kind: 'note' }, me);
  res.json({ ok: true, id });
}));
teamApi.delete('/team/notes/:id', wrap(async (req, res) => {
  const { mailbox, me } = await teamOf(req);
  const r = await q.run('DELETE FROM team_notes WHERE id = ? AND mailbox = ? AND author = ?', Number(req.params.id), mailbox, me);
  if (!r.changes) throw fail(404, 'You can only delete your own notes');
  res.json({ ok: true });
}));

// "I have this open" / "I'm replying" (sent every ~15 seconds while true); "done" when they leave
teamApi.post('/team/presence', rateLimit({ windowMs: 60e3, limit: 120 }), wrap(async (req, res) => {
  const { mailbox, me } = await teamOf(req);
  const msgid = cleanId(req.body.id);
  const state = ['viewing', 'replying', 'done'].includes(req.body.state) ? req.body.state : 'viewing';
  const before = await q.get('SELECT state FROM team_presence WHERE mailbox = ? AND msgid = ? AND email = ? AND at > ?', mailbox, msgid, me, Date.now() - PRESENCE_MS);
  if (state === 'done') await q.run('DELETE FROM team_presence WHERE mailbox = ? AND msgid = ? AND email = ?', mailbox, msgid, me);
  else await q.run('INSERT INTO team_presence(mailbox, msgid, email, state, at) VALUES(?, ?, ?, ?, ?) ON CONFLICT(mailbox, msgid, email) DO UPDATE SET state = excluded.state, at = excluded.at', mailbox, msgid, me, state, Date.now());
  if ((before?.state || 'done') !== state) await tell(mailbox, 'team', { id: msgid, kind: 'presence' }, me);
  if (Math.random() < 0.02) await q.run('DELETE FROM team_presence WHERE at < ?', Date.now() - 10 * 60e3);
  res.json({ ok: true });
}));
