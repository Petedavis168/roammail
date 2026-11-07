// Web push: "New mail from …" notifications on phones and computers even when Roammail isn't open.
// The background worker keeps one IMAP IDLE watch per person who turned notifications on and sends an encrypted
// push through the browser's push service (Apple, Google, Mozilla). Only sender name and subject are included.
import express from 'express';
import crypto from 'node:crypto';
import https from 'node:https';
import webpush from 'web-push';
import { config } from './config.js';
import { q, setting, setSetting, audit } from './db.js';
import { requireAuth, seal, unseal, onRevoke } from './session.js';
import { makeClient } from './imap.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status });
const MAX_WATCHERS = Number(process.env.PUSH_MAX_WATCHERS || 2000);
const SUB_DAYS = 30; // re-confirmed each time the person uses the app

let keys = null;
async function vapid() {
  if (keys) return keys;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) keys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  else {
    const stored = await setting('vapid', null);
    keys = stored ? { publicKey: stored.publicKey, privateKey: unseal(stored.privateKey)?.k } : null;
    if (!keys?.privateKey) {
      const k = webpush.generateVAPIDKeys();
      await setSetting('vapid', { publicKey: k.publicKey, privateKey: seal({ k: k.privateKey }) });
      keys = k;
    }
  }
  webpush.setVapidDetails(`mailto:${config.legal.contact || 'support@example.com'}`, keys.publicKey, keys.privateKey);
  return keys;
}

const validEndpoint = (u) => { try { return new URL(u).protocol === 'https:'; } catch { return false; } };
// Tests run a local push service with a throwaway certificate; never in production
const devLocal = (u) => process.env.NODE_ENV !== 'production' && new URL(u).hostname === '127.0.0.1';
const devAgent = new https.Agent({ rejectUnauthorized: false });

export const push = express.Router();
push.use('/push', requireAuth);
push.get('/push/key', wrap(async (req, res) => res.json({ publicKey: (await vapid()).publicKey })));

push.post('/push/subscribe', wrap(async (req, res) => {
  const s = req.body.subscription || {};
  if (!validEndpoint(s.endpoint) || !s.keys?.p256dh || !s.keys?.auth) throw fail(400, 'Invalid push subscription');
  const id = crypto.createHash('sha256').update(s.endpoint).digest('hex');
  const creds = seal({ email: req.user.email, password: req.user.password, exp: Date.now() + SUB_DAYS * 864e5 });
  await q.run(`INSERT INTO push_subs(id, email, endpoint, p256dh, auth, creds, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET email = excluded.email, creds = excluded.creds, p256dh = excluded.p256dh, auth = excluded.auth`,
  id, req.user.email, s.endpoint, s.keys.p256dh, s.keys.auth, creds, Date.now());
  await audit(req.user.email, null, 'push.subscribe');
  res.json({ ok: true });
}));
push.post('/push/unsubscribe', wrap(async (req, res) => {
  const endpoint = String(req.body.endpoint || '');
  await q.run('DELETE FROM push_subs WHERE email = ? AND endpoint = ?', req.user.email, endpoint);
  res.json({ ok: true });
}));

// Signing out everywhere (or a password change) stops notifications on every device
onRevoke((email) => { q.run('DELETE FROM push_subs WHERE email = ?', email).catch(() => {}); stopWatch(email); });

// ---------------------------------------------------------------- worker: one IDLE watch per person
const watchers = new Map(); // email -> { client, closed }
function stopWatch(email) { const w = watchers.get(email); if (w) { w.closed = true; watchers.delete(email); w.client.logout().catch(() => {}); } }

async function notify(email, payload) {
  await vapid();
  for (const s of await q.all('SELECT * FROM push_subs WHERE email = ?', email)) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 3600, urgency: 'normal', ...(devLocal(s.endpoint) ? { agent: devAgent } : {}) });
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) await q.run('DELETE FROM push_subs WHERE id = ?', s.id); // browser unsubscribed
    }
  }
}

async function watch(email, user) {
  if (watchers.has(email) || watchers.size >= MAX_WATCHERS) return;
  const client = makeClient(user);
  const w = { client, closed: false };
  watchers.set(email, w);
  try {
    await client.connect();
    await client.mailboxOpen('INBOX', { readOnly: true });
    client.on('exists', async (d) => {
      if (d.count <= d.prevCount) return;
      try {
        for await (const m of client.fetch(`${d.prevCount + 1}:${d.count}`, { envelope: true, flags: true })) {
          if (m.flags?.has('\\Seen')) continue;
          const from = m.envelope.from?.[0];
          await notify(email, { title: from?.name || from?.address || 'New mail', body: String(m.envelope.subject || '(no subject)').slice(0, 140), tag: `mail-${m.uid || m.seq}`, url: '/' });
        }
      } catch { /* next time */ }
    });
    client.on('close', () => { watchers.delete(email); });
    client.idle().catch(() => {});
  } catch (e) {
    watchers.delete(email);
    if (e.authenticationFailed) await q.run('DELETE FROM push_subs WHERE email = ?', email); // password changed
  }
}

/** Keep a watch open for everyone with a live subscription (runs on the background worker). */
export async function refreshWatches() {
  const subs = await q.all('SELECT email, creds FROM push_subs ORDER BY created_at DESC');
  const wanted = new Map();
  for (const s of subs) {
    const c = unseal(s.creds);
    if (!c || c.exp < Date.now()) { await q.run('DELETE FROM push_subs WHERE email = ? AND creds = ?', s.email, s.creds); continue; }
    if (!wanted.has(s.email)) wanted.set(s.email, { email: c.email, password: c.password, sid: `push:${s.email}` });
  }
  for (const email of watchers.keys()) if (!wanted.has(email)) stopWatch(email);
  for (const [email, user] of wanted) await watch(email, user);
  return { watching: watchers.size };
}

export function startPush() {
  if (!config.runsBackground) return;
  const run = () => refreshWatches().catch((e) => console.error('APP_ERROR push watches', e.message));
  setTimeout(run, 5000).unref();
  setInterval(run, Number(process.env.PUSH_REFRESH_MS || 60_000)).unref();
}
export const pushStats = () => ({ watching: watchers.size });
