// iMessage-style status between Roammail users: "Delivered", "Read 3:42 PM" and "… is typing".
// Only between people on Roammail (we deliver the mail ourselves, so we know); for everyone else the standard
// delivery/read receipts still apply. Anyone can turn off sharing their read and typing status (Settings → General);
// then nobody sees when they read or type.
import express from 'express';
import { q, userSetting, setUserSetting } from './db.js';
import { requireAuth } from './session.js';
import { config } from './config.js';
import { pushLive } from './live.js';
import { rateLimit } from './shared.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bare = (id) => String(id || '').trim().replace(/^<|>$/g, '').slice(0, 900);
const domainCache = { at: 0, set: new Set() };

/** Is this address a mailbox on Roammail (one of our domains)? */
export async function isRoammail(address) {
  if (Date.now() - domainCache.at > 60e3) {
    const rows = await q.all("SELECT domain FROM domains WHERE status = 'active'").catch(() => []);
    domainCache.set = new Set([...rows.map((r) => r.domain.toLowerCase()), config.signup?.domain].filter(Boolean));
    domainCache.at = Date.now();
  }
  return domainCache.set.has(String(address || '').toLowerCase().split('@')[1]);
}
const sharing = async (email) => (await userSetting(email, 'shareStatus', true)) !== false;

/** After a send: Roammail recipients have it now ("Delivered"). */
export async function recordDelivered(sender, messageId, recipients) {
  const id = bare(messageId);
  if (!id) return;
  const now = Date.now();
  for (const r of [...new Set(recipients.map((x) => String(x).toLowerCase()))]) {
    if (r === sender.toLowerCase() || !(await isRoammail(r))) continue;
    await q.run('INSERT INTO msg_status(message_id, sender, recipient, delivered_at) VALUES(?, ?, ?, ?) ON CONFLICT(message_id, recipient) DO NOTHING', id, sender.toLowerCase(), r, now);
  }
}

/** When a Roammail user opens an email from another Roammail user: "Read" for the sender (if they share it). */
export async function recordRead(reader, msg) {
  const id = bare(msg?.messageId);
  const from = String(msg?.from?.[0]?.address || '').toLowerCase();
  if (!id || !from || from === reader.toLowerCase()) return;
  const row = await q.get('SELECT sender, read_at FROM msg_status WHERE message_id = ? AND recipient = ?', id, reader.toLowerCase());
  if (!row || row.read_at || row.sender !== from || !(await sharing(reader))) return;
  const now = Date.now();
  await q.run('UPDATE msg_status SET read_at = ? WHERE message_id = ? AND recipient = ? AND read_at IS NULL', now, id, reader.toLowerCase());
  pushLive(from, 'status', { messageId: `<${id}>`, recipient: reader.toLowerCase(), read: now });
}

export const statusApi = express.Router();
statusApi.use(['/msg-status', '/live'], requireAuth);

// Status of emails I sent (by Message-ID)
statusApi.get('/msg-status', wrap(async (req, res) => {
  const ids = String(req.query.ids || '').split(',').map(bare).filter(Boolean).slice(0, 100);
  if (!ids.length) return res.json({ status: {} });
  const rows = await q.all(`SELECT message_id, recipient, delivered_at, read_at FROM msg_status WHERE sender = ? AND message_id IN (${ids.map(() => '?').join(',')})`, req.user.email.toLowerCase(), ...ids);
  const status = {};
  for (const r of rows) (status[`<${r.message_id}>`] ||= []).push({ address: r.recipient, delivered: Number(r.delivered_at) || null, read: Number(r.read_at) || null });
  res.json({ status });
}));

statusApi.get('/msg-status/settings', wrap(async (req, res) => res.json({ share: await sharing(req.user.email) })));
statusApi.put('/msg-status/settings', wrap(async (req, res) => {
  await setUserSetting(req.user.email, 'shareStatus', req.body.share !== false);
  res.json({ share: req.body.share !== false });
}));

// "… is typing": sent every few seconds while writing a reply, only to the Roammail people in that conversation
statusApi.post('/live/typing', rateLimit({ windowMs: 60e3, limit: 40 }), wrap(async (req, res) => {
  if (req.delegatedMailbox || !(await sharing(req.user.email))) return res.json({ ok: true, sent: 0 });
  const ref = bare(req.body.ref);
  const to = [...new Set((Array.isArray(req.body.to) ? req.body.to : []).map((x) => String(x).toLowerCase()))].slice(0, 20);
  if (!ref || !to.length) return res.json({ ok: true, sent: 0 });
  let sent = 0;
  for (const r of to) {
    if (r === req.user.email.toLowerCase() || !(await isRoammail(r))) continue;
    pushLive(r, 'typing', { from: req.user.email.toLowerCase(), name: req.user.name || '', ref: `<${ref}>`, stop: !!req.body.stop, at: Date.now() });
    sent++;
  }
  res.json({ ok: true, sent });
}));

export async function deleteStatus(email) { await q.run('DELETE FROM msg_status WHERE sender = ? OR recipient = ?', email, email); }
