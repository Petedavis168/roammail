// Follow-up nudges: "No reply in 3 days. Bump it?" Emails you sent to a few people, that asked something, and that
// nobody has answered, come back to the top of your inbox after a few days. Worked out when you open your inbox
// (no background job, nothing stored but what you dismissed), cached for a few minutes.
//
// An email counts as answered when any message in the Inbox or Archive refers to it (In-Reply-To / References), or
// when you have written again in the same conversation (then that later email is the one that can be nudged).
import express from 'express';
import { q, userSetting, setUserSetting } from './db.js';
import { requireAuth } from './session.js';
import { getClient } from './imap.js';
import { rateLimit } from './shared.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const LOOK_BACK_DAYS = 21;
const MAX_SHOWN = 5;
const cache = new Map(); // email -> { at, list }
const CACHE_MS = 10 * 60e3;
const DEFAULTS = { enabled: true, days: 3, onlyQuestions: true };
// Tests shorten "3 days" (never in production)
const dayMs = () => (process.env.NODE_ENV !== 'production' && process.env.NUDGE_DAY_MS ? Number(process.env.NUDGE_DAY_MS) : 864e5);

const ids = (s) => String(s || '').match(/<[^<>\s]+>/g) || [];
const AUTO_SUBJECT = /^(read|delivered|automatic reply|out of office|auto|accepted|declined|tentative|invitation|updated invitation|canceled|cancelled)\b|password for my protected email|sent you a protected email/i;
const NO_REPLY = /(^|[._-])(no-?reply|do-?not-?reply|notifications?|mailer-daemon|postmaster|bounce)/i;

/** The plain-text part of a message (to look for a question), from its body structure. */
function textPart(node, path = '') {
  if (!node) return null;
  if (node.childNodes?.length) {
    for (let i = 0; i < node.childNodes.length; i++) {
      const hit = textPart(node.childNodes[i], node.childNodes[i].part || `${path ? `${path}.` : ''}${i + 1}`);
      if (hit) return hit;
    }
    return null;
  }
  if (node.type === 'text/plain' && node.disposition !== 'attachment') return { part: node.part || path || '1', encoding: (node.encoding || '').toLowerCase(), charset: node.parameters?.charset };
  return null;
}
function decode(buf, enc) {
  const s = Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf || '');
  if (enc === 'base64') return Buffer.from(s.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (enc === 'quoted-printable') return Buffer.from(s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8');
  return Buffer.from(s, 'latin1').toString('utf8');
}
/** Only what I wrote: drop quoted text and everything from "On … wrote:" down. */
export function ownText(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out = [];
  for (const l of lines) {
    if (/^On .{4,200} wrote:\s*$/.test(l) || /^-{2,} ?(Original|Forwarded) message/i.test(l)) break;
    if (/^\s*>/.test(l)) continue;
    out.push(l);
  }
  return out.join('\n').slice(0, 8000);
}
export const asksSomething = (text) => /\?(\s|$)/.test(ownText(text).replace(/https?:\/\/\S+/g, ''));

async function scan(user, prefs) {
  const client = await getClient(user);
  const boxes = await client.list();
  const sent = boxes.find((b) => b.specialUse === '\\Sent')?.path;
  if (!sent) return [];
  const replyBoxes = boxes.filter((b) => b.path.toUpperCase() === 'INBOX' || b.specialUse === '\\Archive').map((b) => b.path);
  const since = new Date(Date.now() - LOOK_BACK_DAYS * 864e5);
  const minAge = prefs.days * dayMs();
  const me = user.email.toLowerCase();
  const mine = [];
  const answered = new Set();
  let lock = await client.getMailboxLock(sent, { readOnly: true });
  try {
    const uids = ((await client.search({ since }, { uid: true })) || []).slice(-400);
    if (uids.length) {
      for await (const m of client.fetch(uids.join(','), { uid: true, envelope: true, internalDate: true, bodyStructure: true, headers: ['references', 'in-reply-to', 'auto-submitted', 'x-roammail-secure-id', 'list-unsubscribe'] }, { uid: true })) {
        const h = String(m.headers || '');
        for (const r of ids(h)) answered.add(r); // my later emails in the same thread
        mine.push(m);
      }
    }
  } finally { lock.release(); }
  // Replies from other people
  for (const box of replyBoxes) {
    lock = await client.getMailboxLock(box, { readOnly: true });
    try {
      const uids = ((await client.search({ since }, { uid: true })) || []).slice(-3000);
      if (!uids.length) continue;
      for await (const m of client.fetch(uids.join(','), { uid: true, headers: ['references', 'in-reply-to'] }, { uid: true })) for (const r of ids(m.headers)) answered.add(r);
    } finally { lock.release(); }
  }
  const dismissed = new Set((await q.all('SELECT message_id FROM nudge_dismissed WHERE email = ?', user.email)).map((r) => r.message_id));
  const now = Date.now();
  const candidates = mine.filter((m) => {
    const id = m.envelope?.messageId; const date = new Date(m.internalDate || m.envelope?.date || 0).getTime();
    if (!id || answered.has(id) || dismissed.has(id)) return false;
    if (now - date < minAge) return false;
    const h = String(m.headers || '').toLowerCase();
    if (/auto-submitted:\s*auto|x-roammail-secure-id|list-unsubscribe/.test(h)) return false;
    if (AUTO_SUBJECT.test(m.envelope?.subject || '')) return false;
    const rcpts = [...(m.envelope?.to || []), ...(m.envelope?.cc || [])].map((a) => String(a.address || '').toLowerCase()).filter((a) => a && a !== me);
    if (!rcpts.length || rcpts.length > 5 || rcpts.some((a) => NO_REPLY.test(a.split('@')[0]))) return false;
    return true;
  }).sort((a, b) => new Date(b.internalDate) - new Date(a.internalDate));
  // Only the ones that asked something (if that's the setting): read just the text part of the newest few
  const out = [];
  lock = await client.getMailboxLock(sent, { readOnly: true });
  try {
    for (const m of candidates.slice(0, 40)) {
      if (out.length >= MAX_SHOWN) break;
      if (prefs.onlyQuestions) {
        const tp = textPart(m.bodyStructure);
        if (!tp) continue;
        const got = await client.fetchOne(String(m.uid), { uid: true, bodyParts: [tp.part] }, { uid: true });
        const raw = got?.bodyParts?.get(tp.part) || got?.bodyParts?.get(tp.part.toLowerCase());
        if (!asksSomething(decode(raw, tp.encoding))) continue;
      }
      const date = new Date(m.internalDate || m.envelope.date).getTime();
      out.push({ uid: m.uid, folder: sent, messageId: m.envelope.messageId, subject: m.envelope.subject || '', date, days: Math.floor((now - date) / dayMs()),
        to: [...(m.envelope.to || []), ...(m.envelope.cc || [])].filter((a) => String(a.address || '').toLowerCase() !== me).map((a) => ({ name: a.name || '', address: a.address })) });
    }
  } finally { lock.release(); }
  return out;
}

export const nudgesApi = express.Router();
nudgesApi.use('/nudges', requireAuth);

nudgesApi.get('/nudges', rateLimit({ windowMs: 60e3, limit: 30 }), wrap(async (req, res) => {
  const prefs = { ...DEFAULTS, ...(await userSetting(req.user.email, 'nudges', {})) };
  if (!prefs.enabled || req.delegatedMailbox) return res.json({ prefs, nudges: [] });
  const key = req.user.email;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS && req.query.refresh !== '1') return res.json({ prefs, nudges: hit.list });
  const list = await scan(req.user, prefs);
  cache.set(key, { at: Date.now(), list });
  if (cache.size > 20000) cache.delete(cache.keys().next().value);
  res.json({ prefs, nudges: list });
}));

nudgesApi.post('/nudges/dismiss', wrap(async (req, res) => {
  const id = String(req.body.messageId || '').trim();
  if (!/^<[^<>\s]{1,900}>$/.test(id)) throw fail(400, 'Pick an email');
  await q.run('INSERT INTO nudge_dismissed(email, message_id, at) VALUES(?, ?, ?) ON CONFLICT(email, message_id) DO NOTHING', req.user.email, id, Date.now());
  const hit = cache.get(req.user.email);
  if (hit) hit.list = hit.list.filter((n) => n.messageId !== id);
  res.json({ ok: true });
}));

nudgesApi.put('/nudges/settings', wrap(async (req, res) => {
  const days = [1, 2, 3, 5, 7].includes(Number(req.body.days)) ? Number(req.body.days) : 3;
  const prefs = { enabled: req.body.enabled !== false, days, onlyQuestions: req.body.onlyQuestions !== false };
  await setUserSetting(req.user.email, 'nudges', prefs);
  cache.delete(req.user.email);
  res.json(prefs);
}));

export async function deleteNudges(email) { await q.run('DELETE FROM nudge_dismissed WHERE email = ?', email); cache.delete(email); }
