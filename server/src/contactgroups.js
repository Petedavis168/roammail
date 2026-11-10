// Contact groups ("Family", "Team", "Book club"): a name for a list of people. Type the name in To and everyone in
// it is added. Private to each mailbox (business-wide lists are the admin's distribution groups).
import express from 'express';
import { q } from './db.js';
import { requireAuth } from './session.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>".]{1,63}(?:\.[^\s@<>".]{1,63}){1,8}$/;
const MAX_GROUPS = 100; const MAX_MEMBERS = 500;

const clean = (b) => {
  const name = String(b.name || '').replace(/[\r\n<>]/g, '').trim().slice(0, 80);
  if (!name) throw fail(400, 'Give the group a name');
  const seen = new Set(); const members = [];
  for (const m of Array.isArray(b.members) ? b.members : []) {
    const address = String(m?.address || m || '').trim().toLowerCase();
    if (!EMAIL_RE.test(address) || seen.has(address)) continue;
    seen.add(address); members.push({ address, name: String(m?.name || '').replace(/[\r\n<>"]/g, '').trim().slice(0, 120) });
    if (members.length >= MAX_MEMBERS) break;
  }
  return { name, members };
};
const out = (r) => ({ id: Number(r.id), name: r.name, members: JSON.parse(r.members || '[]'), updatedAt: Number(r.updated_at) });

export async function groupsFor(email) { return (await q.all('SELECT * FROM contact_groups WHERE email = ? ORDER BY name', email)).map(out); }

export const contactGroups = express.Router();
contactGroups.use('/contact-groups', requireAuth);
contactGroups.get('/contact-groups', wrap(async (req, res) => res.json(await groupsFor(req.user.email))));
contactGroups.post('/contact-groups', wrap(async (req, res) => {
  const g = clean(req.body);
  if (Number((await q.get('SELECT COUNT(*) AS n FROM contact_groups WHERE email = ?', req.user.email)).n) >= MAX_GROUPS) throw fail(400, 'You have too many groups');
  if (await q.get('SELECT id FROM contact_groups WHERE email = ? AND lower(name) = lower(?)', req.user.email, g.name)) throw fail(409, 'You already have a group with that name');
  const id = await q.insert('INSERT INTO contact_groups(email, name, members, updated_at) VALUES(?, ?, ?, ?)', req.user.email, g.name, JSON.stringify(g.members), Date.now());
  res.json(out(await q.get('SELECT * FROM contact_groups WHERE id = ?', id)));
}));
contactGroups.put('/contact-groups/:id', wrap(async (req, res) => {
  const g = clean(req.body);
  const r = await q.run('UPDATE contact_groups SET name = ?, members = ?, updated_at = ? WHERE id = ? AND email = ?', g.name, JSON.stringify(g.members), Date.now(), Number(req.params.id), req.user.email);
  if (!r.changes) throw fail(404, 'Group not found');
  res.json(out(await q.get('SELECT * FROM contact_groups WHERE id = ?', Number(req.params.id))));
}));
contactGroups.delete('/contact-groups/:id', wrap(async (req, res) => {
  await q.run('DELETE FROM contact_groups WHERE id = ? AND email = ?', Number(req.params.id), req.user.email);
  res.json({ ok: true });
}));
