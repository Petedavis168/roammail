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
import { authFailed, isAuthError } from './authguard.js';
import { sendNative, nativePushConfig } from './nativepush.js';

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
push.get('/push/key', wrap(async (req, res) => res.json({ publicKey: (await vapid()).publicKey, native: nativePushConfig() })));

/** Signed-in mailboxes on this device (each one notifies) with the password the IDLE watch needs. */
function deviceUsers(req) {
  const users = (req.liveSessions || []).map((x) => ({ email: x.email, password: unseal(x.creds)?.password })).filter((u) => u.password);
  if (!users.some((u) => u.email === req.user.email)) users.unshift({ email: req.user.email, password: req.user.password });
  return users;
}
async function saveSubs(users, endpoint, p256dh, auth) {
  for (const u of users) {
    const id = crypto.createHash('sha256').update(`${endpoint}|${u.email}`).digest('hex');
    const creds = seal({ email: u.email, password: u.password, exp: Date.now() + SUB_DAYS * 864e5 });
    await q.run(`INSERT INTO push_subs(id, email, endpoint, p256dh, auth, creds, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET email = excluded.email, creds = excluded.creds, p256dh = excluded.p256dh, auth = excluded.auth`,
    id, u.email, endpoint, p256dh, auth, creds, Date.now());
  }
}

// Show sender and subject in notifications (default), or only "New mail"
const previewOn = async (email) => Number((await q.get('SELECT push_preview FROM user_security WHERE email = ?', email))?.push_preview ?? 1) !== 0;
push.get('/push/preview', wrap(async (req, res) => res.json({ on: await previewOn(req.user.email) })));
push.put('/push/preview', wrap(async (req, res) => {
  await q.run('INSERT INTO user_security(email) VALUES(?) ON CONFLICT(email) DO NOTHING', req.user.email);
  await q.run('UPDATE user_security SET push_preview = ? WHERE email = ?', req.body.on === false ? 0 : 1, req.user.email);
  res.json({ ok: true, on: req.body.on !== false });
}));

// Phone apps (mobile/): the device token from Firebase (Android) or Apple (iPhone)
const nativeEndpoint = (platform, token) => {
  const t = String(token || '');
  if (platform === 'android' && /^[\w:.-]{20,4096}$/.test(t)) return `fcm:${t}`;
  if (platform === 'ios' && /^[0-9a-f]{32,200}$/i.test(t)) return `apns:${t.toLowerCase()}`;
  return null;
};
push.post('/push/native', wrap(async (req, res) => {
  const endpoint = nativeEndpoint(req.body.platform, req.body.token);
  if (!endpoint) throw fail(400, 'Invalid device token');
  await saveSubs(deviceUsers(req), endpoint, '', '');
  await audit(req.user.email, null, 'push.subscribe', { platform: req.body.platform });
  res.json({ ok: true });
}));
push.post('/push/native/unregister', wrap(async (req, res) => {
  const endpoint = nativeEndpoint(req.body.platform, req.body.token);
  if (endpoint) for (const e of new Set([req.user.email, ...(req.liveSessions || []).map((x) => x.email)])) await q.run('DELETE FROM push_subs WHERE email = ? AND endpoint = ?', e, endpoint);
  res.json({ ok: true });
}));

push.post('/push/subscribe', wrap(async (req, res) => {
  const s = req.body.subscription || {};
  if (!validEndpoint(s.endpoint) || !s.keys?.p256dh || !s.keys?.auth) throw fail(400, 'Invalid push subscription');
  // One subscription per signed-in mailbox on this device, so each account notifies (item 10)
  await q.run('DELETE FROM push_subs WHERE endpoint = ? AND id = ?', s.endpoint, crypto.createHash('sha256').update(s.endpoint).digest('hex')); // pre-multi-account row
  await saveSubs(deviceUsers(req), s.endpoint, s.keys.p256dh, s.keys.auth);
  await audit(req.user.email, null, 'push.subscribe');
  res.json({ ok: true });
}));
push.post('/push/unsubscribe', wrap(async (req, res) => {
  const endpoint = String(req.body.endpoint || '');
  const emails = (req.liveSessions || []).map((x) => x.email);
  for (const e of new Set([req.user.email, ...emails])) await q.run('DELETE FROM push_subs WHERE email = ? AND endpoint = ?', e, endpoint);
  res.json({ ok: true });
}));

// Signing out everywhere (or a password change) stops notifications on every device
onRevoke((email) => { q.run('DELETE FROM push_subs WHERE email = ?', email).catch(() => {}); stopWatch(email); });

// ---------------------------------------------------------------- worker: one IDLE watch per person
const watchers = new Map(); // email -> { client, closed }
function stopWatch(email) { const w = watchers.get(email); if (w) { w.closed = true; watchers.delete(email); w.client.logout().catch(() => {}); } }

export async function notify(email, payload) {
  await vapid();
  let sent = 0;
  for (const s of await q.all('SELECT * FROM push_subs WHERE email = ?', email)) {
    if (!s.p256dh) { // phone app
      const r = await sendNative(s.endpoint, payload).catch(() => ({ ok: false }));
      if (r.ok) sent++; else if (r.gone) await q.run('DELETE FROM push_subs WHERE id = ?', s.id);
      continue;
    }
    try {
      sent++;
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 3600, urgency: 'normal', ...(devLocal(s.endpoint) ? { agent: devAgent } : {}) });
    } catch (e) {
      sent--;
      if (e.statusCode === 404 || e.statusCode === 410) await q.run('DELETE FROM push_subs WHERE id = ?', s.id); // browser unsubscribed
    }
  }
  return sent;
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
          const tag = `mail-${email}-${m.uid || m.seq}`;
          if (await previewOn(email)) await notify(email, { title: from?.name || from?.address || 'New mail', body: String(m.envelope.subject || '(no subject)').slice(0, 140), tag, url: '/app' });
          else await notify(email, { title: 'New mail', body: email, tag, url: '/app' }); // sender and subject hidden
        }
      } catch { /* next time */ }
    });
    client.on('close', () => { watchers.delete(email); });
    client.idle().catch(() => {});
  } catch (e) {
    watchers.delete(email);
    if (isAuthError(e)) { await authFailed(user.email, user.password); await q.run('DELETE FROM push_subs WHERE email = ?', email); } // password changed: stop, never retry
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
