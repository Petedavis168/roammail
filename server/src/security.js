import { ensureSetupRow, setupState, markChosen } from './setup.js';
import { ensureMailboxId, inboxUrl } from './mailboxids.js';
// Sign-in security: 2-step verification (TOTP), lockout, sign-in history,
// password change / reset, sign out everywhere.
import express from 'express';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import QRCode from 'qrcode';
import { rateLimit } from './shared.js';
import { config } from './config.js';
import { q, security, audit } from './db.js';
import { seal, unseal, sealedWithOldKey, setSession, requireAuth, revokeSessions, updateSessionPassword, sessionPublicId } from './session.js';
import { makeClient, closeClient, checkPassword as checkMailPassword } from './imap.js';
import { mailcow } from './mailcow.js';
import { loginBlocked, loginFailed, loginSucceeded, assertNotBreached } from './abuse.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status });
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const MAX_FAILS = 10;
const LOCK_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------- TOTP (RFC 6238)
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function unbase32(s) {
  let bits = 0, value = 0; const out = [];
  for (const c of s.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(c); if (i < 0) continue;
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export function totp(secret, counter) {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
export function verifyTotp(secret, code) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  const now = Math.floor(Date.now() / 30000);
  return [-1, 0, 1].some((d) => crypto.timingSafeEqual(Buffer.from(totp(secret, now + d)), Buffer.from(c)));
}

// ---------------------------------------------------------------- helpers
async function logEvent(req, email, ok, reason) {
  await q.run('INSERT INTO login_events(email, ip, ua, ok, reason) VALUES(?, ?, ?, ?, ?)', email, req.ip, String(req.get('user-agent') || '').slice(0, 300), ok ? 1 : 0, reason || null);
}
async function bumpEpoch(email, keepId) {
  await revokeSessions(email, keepId);
}
function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10) throw fail(400, 'Password must be at least 10 characters');
  if (!/[a-z]/i.test(pw) || !/[0-9]/.test(pw)) throw fail(400, 'Password must contain letters and numbers');
}
// One guarded attempt (see authguard.js): never retries, never lets failures pile up against the mail server
const imapLogin = (email, password) => checkMailPassword(email, password);
export function systemMailer() {
  if (!config.systemMail.user) return null;
  return nodemailer.createTransport({
    host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure,
    auth: { user: config.systemMail.user, pass: config.systemMail.pass }, tls: { rejectUnauthorized: config.tlsRejectUnauthorized },
  });
}

// ---------------------------------------------------------------- public: login, 2FA, reset
export const publicSecurity = express.Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

publicSecurity.post('/login', loginLimiter, wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password) throw fail(400, 'Email and password are required');
  const domain = email.split('@')[1];
  if (config.allowedDomains.length && !config.allowedDomains.includes(domain)) throw fail(403, 'This email domain is not allowed on this server');

  const sec = await security(email);
  const wait = await loginBlocked(email, req.ip);
  if (wait) {
    await logEvent(req, email, false, 'locked');
    throw fail(429, `Too many failed attempts. Try again in ${wait} minutes, or reset your password.`);
  }
  if (!(await imapLogin(email, password))) {
    await loginFailed(email, req.ip);
    await logEvent(req, email, false, 'password');
    throw fail(401, 'Wrong email or password');
  }
  if (sec.totp_enabled) {
    // Password OK: hand back a short-lived ticket; the session is only issued after the code
    const ticket = seal({ email, password, exp: Date.now() + 5 * 60 * 1000, t: '2fa' });
    return res.json({ twoFactor: true, ticket });
  }
  await loginSucceeded(email, req.ip);
  await logEvent(req, email, true);
  await setSession(res, { email, password, name: '' }, req);
  await newDeviceCheck(req, email, password);
  const mailboxId = await ensureMailboxId(email);
  await ensureSetupRow(email);
  res.json({ email, mailboxId, redirect: inboxUrl(mailboxId), setupRequired: (await setupState(email)).setupRequired });
}));

publicSecurity.post('/login/2fa', loginLimiter, wrap(async (req, res) => {
  const t = unseal(String(req.body.ticket || ''));
  if (!t || t.t !== '2fa') throw fail(401, 'Your sign-in expired. Please start again.');
  const sec = await security(t.email);
  if (await loginBlocked(t.email, req.ip)) throw fail(429, 'Too many failed attempts. Try again later.');
  const code = String(req.body.code || '').trim();
  let ok = false;
  const secret = sec.totp_secret && unseal(sec.totp_secret)?.secret;
  if (secret && verifyTotp(secret, code)) {
    ok = true;
    if (sealedWithOldKey(sec.totp_secret)) await q.run('UPDATE user_security SET totp_secret = ? WHERE email = ?', seal({ secret }), t.email); // finish key rotation
  }
  else {
    // Backup codes are single use
    const codes = JSON.parse(sec.backup_codes || '[]');
    const h = sha(code.replace(/[\s-]/g, '').toLowerCase());
    if (codes.includes(h)) {
      ok = true;
      await q.run('UPDATE user_security SET backup_codes = ? WHERE email = ?', JSON.stringify(codes.filter((c) => c !== h)), t.email);
      await audit(t.email, null, 'security.backup_code_used');
    }
  }
  if (!ok) {
    await loginFailed(t.email, req.ip);
    await logEvent(req, t.email, false, '2fa');
    throw fail(401, 'That code isn\'t right. Check your authenticator app and try again.');
  }
  await loginSucceeded(t.email, req.ip);
  await logEvent(req, t.email, true, '2fa');
  await setSession(res, { email: t.email, password: t.password, name: '' }, req);
  await newDeviceCheck(req, t.email, t.password);
  const mailboxId = await ensureMailboxId(t.email);
  await ensureSetupRow(t.email);
  res.json({ email: t.email, mailboxId, redirect: inboxUrl(mailboxId), setupRequired: (await setupState(t.email)).setupRequired });
}));

const resetLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10 });
publicSecurity.post('/password/forgot', resetLimiter, wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  // Always answer the same way so nobody can probe which accounts exist
  res.json({ ok: true, message: 'If that account has a recovery email, we\'ve sent a reset link to it.' });
  const sec = await q.get('SELECT recovery_email FROM user_security WHERE email = ? AND recovery_verified = 1', email);
  const mailer = systemMailer();
  if (!sec?.recovery_email || !mailer) return;
  const token = crypto.randomBytes(24).toString('base64url');
  await q.run('DELETE FROM password_resets WHERE email = ? OR expires < ?', email, Date.now());
  await q.run('INSERT INTO password_resets(token_hash, email, expires) VALUES(?, ?, ?)', sha(token), email, Date.now() + 30 * 60 * 1000);
  // Reset links open the sign-in host (login.roammail.net) in production
  const link = config.loginHost ? `https://${config.loginHost}/?reset=${token}` : `${config.publicUrl || `${req.protocol}://${req.get('host')}`}/login?reset=${token}`;
  await mailer.sendMail({
    from: { name: config.appName, address: config.systemMail.from }, to: sec.recovery_email,
    subject: `Reset your ${config.appName} password`,
    text: `Someone asked to reset the password for ${email}.\n\nReset it here (valid for 30 minutes):\n${link}\n\nIf this wasn't you, ignore this email - your password won't change.`,
    html: `<p>Someone asked to reset the password for <b>${email}</b>.</p><p><a href="${link}" style="background:#244960;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Reset password</a></p><p style="color:#666">The link is valid for 30 minutes. If this wasn't you, ignore this email - your password won't change.</p>`,
  }).catch((e) => console.warn('reset mail failed:', e.message));
  await audit(email, null, 'security.reset_requested', { ip: req.ip });
}));

publicSecurity.post('/password/reset', resetLimiter, wrap(async (req, res) => {
  const row = await q.get('SELECT * FROM password_resets WHERE token_hash = ?', sha(String(req.body.token || '')));
  if (!row || row.expires < Date.now()) throw fail(400, 'This reset link has expired. Please request a new one.');
  checkPassword(req.body.password);
  await assertNotBreached(req.body.password, row.email);
  await mailcow.editMailbox(row.email, { password: req.body.password, password2: req.body.password });
  await q.run('DELETE FROM password_resets WHERE email = ?', row.email);
  await markChosen(row.email);
  await q.run('UPDATE user_security SET failed_count = 0, locked_until = 0 WHERE email = ?', row.email);
  await bumpEpoch(row.email);
  if (row.kind === 'invite') {
    // They proved they own the address the invite went to: make it their verified recovery email and sign them in
    if (row.invite_to) { await security(row.email); await q.run('UPDATE user_security SET recovery_email = ?, recovery_verified = 1 WHERE email = ?', row.invite_to, row.email); }
    await audit(row.email, null, 'security.invite_accepted', { ip: req.ip });
    await setSession(res, { email: row.email, password: req.body.password, name: '' }, req);
    const mailboxId = await ensureMailboxId(row.email);
    return res.json({ ok: true, email: row.email, mailboxId, redirect: inboxUrl(mailboxId), setupRequired: (await setupState(row.email)).setupRequired });
  }
  await audit(row.email, null, 'security.password_reset', { ip: req.ip });
  res.json({ ok: true, email: row.email });
}));

// ---------------------------------------------------------------- new-device alerts
// A sign-in from a browser/network not seen in the last 90 days puts a warning in the user's own inbox.
function deviceKey(ip, ua) {
  const net = String(ip || '').includes(':') ? String(ip).split(':').slice(0, 4).join(':') : String(ip || '').split('.').slice(0, 3).join('.');
  const b = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Other';
  const os = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : 'Other';
  return { net, label: `${b} on ${os}`, b, os };
}
async function newDeviceCheck(req, email, password) {
  const ua = String(req.get('user-agent') || '');
  const me = deviceKey(req.ip, ua);
  const prior = await q.all("SELECT ip, ua FROM login_events WHERE email = ? AND ok = 1 AND at > datetime('now', '-90 days') ORDER BY id DESC LIMIT 200 OFFSET 1", email);
  if (!prior.length) return; // first ever sign-in (new account)
  const seen = prior.some((e) => { const d = deviceKey(e.ip, e.ua || ''); return d.label === me.label && d.net === me.net; });
  if (seen) return;
  const when = new Date().toUTCString();
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#242424;max-width:560px">
<h2 style="margin:0 0 8px">New sign-in to your account</h2>
<p>Your account <b>${email}</b> was just used to sign in from a new device or location.</p>
<table cellpadding="4" style="font-size:13px"><tr><td style="color:#666">Device</td><td>${me.label}</td></tr><tr><td style="color:#666">IP address</td><td>${String(req.ip).replace(/[<>&]/g, '')}</td></tr><tr><td style="color:#666">Time</td><td>${when}</td></tr></table>
<p><b>Was this you?</b> Then you don't need to do anything.</p>
<p><b>Not you?</b> Open <b>Settings → Security</b> now: change your password, choose <b>Sign out of all other devices</b>, and turn on 2-step verification.</p></div>`;
  import('nodemailer/lib/mail-composer/index.js').then(({ default: MailComposer }) => new Promise((resolve, reject) => new MailComposer({
    from: { name: `${config.appName} Security`, address: `no-reply@${email.split('@')[1]}` }, to: email, subject: 'New sign-in to your account', html,
  }).compile().build((e, m) => (e ? reject(e) : resolve(m))))).then(async (raw) => {
    const c = makeClient({ email, password });
    await c.connect(); await c.append('INBOX', raw, []); await c.logout();
  }).catch(() => {});
  await audit(email, null, 'security.new_device', { device: me.label, ip: req.ip });
}

// ---------------------------------------------------------------- signed-in: security settings
export const securityApi = express.Router();
securityApi.use(requireAuth);

securityApi.get('/security', wrap(async (req, res) => {
  const s = await security(req.user.email);
  res.json({
    twoFactor: !!s.totp_enabled,
    backupCodesLeft: JSON.parse(s.backup_codes || '[]').length,
    recoveryEmail: s.recovery_email || '', recoveryVerified: !!s.recovery_verified, recoveryPending: s.recovery_pending || '',
    resetAvailable: !!config.systemMail.user,
    events: await q.all('SELECT ip, ua, ok, reason, at FROM login_events WHERE email = ? ORDER BY id DESC LIMIT 25', req.user.email),
  });
}));

// Step 1: create a secret + QR code (not active until confirmed)
// Signed-in devices
securityApi.get('/security/sessions', async (req, res) => {
  res.json((await q.all('SELECT id, ip, ua, created, last_seen FROM sessions WHERE email = ? ORDER BY last_seen DESC', req.user.email))
    .map((s) => ({ id: sessionPublicId(s.id), ip: s.ip, ua: s.ua, created: s.created, lastSeen: s.last_seen, current: s.id === req.user.sid })));
});
securityApi.delete('/security/sessions', wrap(async (req, res) => {
  const pub = String(req.query.id || '');
  const s = (await q.all('SELECT id FROM sessions WHERE email = ?', req.user.email)).find((x) => sessionPublicId(x.id) === pub);
  if (!s) throw fail(404, 'That device is already signed out');
  await q.run('DELETE FROM sessions WHERE id = ?', s.id);
  await closeClient(s.id);
  await audit(req.user.email, null, 'security.signout_device', { ip: req.ip });
  res.json({ ok: true });
}));

securityApi.post('/security/2fa/setup', wrap(async (req, res) => {
  // security() creates the row for accounts that have never signed in before (e.g. right after sign-up)
  if ((await security(req.user.email)).totp_enabled) throw fail(400, '2-step verification is already on');
  const secret = base32(crypto.randomBytes(20));
  await q.run('UPDATE user_security SET totp_secret = ? WHERE email = ? AND totp_enabled = 0', seal({ secret }), req.user.email);
  const label = encodeURIComponent(`${config.appName}:${req.user.email}`);
  const uri = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(config.appName)}&algorithm=SHA1&digits=6&period=30`;
  res.json({ secret, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) });
}));

const newBackupCodes = () => Array.from({ length: 10 }, () => crypto.randomBytes(5).toString('hex').replace(/(.{5})/, '$1-'));

// Step 2: confirm with a code -> enabled, returns backup codes once
securityApi.post('/security/2fa/enable', wrap(async (req, res) => {
  const s = await security(req.user.email);
  const secret = s.totp_secret && unseal(s.totp_secret)?.secret;
  if (!secret || !verifyTotp(secret, req.body.code)) throw fail(400, 'That code isn\'t right. Make sure your phone\'s clock is correct.');
  const codes = newBackupCodes();
  await q.run('UPDATE user_security SET totp_enabled = 1, backup_codes = ? WHERE email = ?', JSON.stringify(codes.map((c) => sha(c.replace('-', '')))), req.user.email);
  await audit(req.user.email, null, 'security.2fa_on');
  res.json({ ok: true, backupCodes: codes });
}));

securityApi.post('/security/2fa/disable', wrap(async (req, res) => {
  if (!(await imapLogin(req.user.email, String(req.body.password || '')))) throw fail(401, 'Wrong password');
  await q.run("UPDATE user_security SET totp_enabled = 0, totp_secret = NULL, backup_codes = '[]' WHERE email = ?", req.user.email);
  await audit(req.user.email, null, 'security.2fa_off');
  res.json({ ok: true });
}));

securityApi.post('/security/backup-codes', wrap(async (req, res) => {
  if (!(await security(req.user.email)).totp_enabled) throw fail(400, 'Turn on 2-step verification first');
  if (!(await imapLogin(req.user.email, String(req.body.password || '')))) throw fail(401, 'Enter your current password to make new backup codes');
  const codes = newBackupCodes();
  await q.run('UPDATE user_security SET backup_codes = ? WHERE email = ?', JSON.stringify(codes.map((c) => sha(c.replace('-', '')))), req.user.email);
  res.json({ backupCodes: codes });
}));

securityApi.post('/security/password', wrap(async (req, res) => {
  const { current, next } = req.body;
  if (!(await imapLogin(req.user.email, String(current || '')))) throw fail(401, 'Your current password is wrong');
  checkPassword(next);
  await assertNotBreached(next, req.user.email);
  if (next === current) throw fail(400, 'Choose a password you haven\'t used here before');
  await mailcow.editMailbox(req.user.email, { password: next, password2: next });
  await markChosen(req.user.email);
  await closeClient(req.user.sid);
  await bumpEpoch(req.user.email, req.user.sid);  // signs out every other device
  await updateSessionPassword(req.user.sid, next);
  await audit(req.user.email, null, 'security.password_change', { ip: req.ip });
  res.json({ ok: true });
}));

securityApi.post('/security/signout-all', wrap(async (req, res) => {
  await bumpEpoch(req.user.email, req.user.sid); // keep this device signed in
  await audit(req.user.email, null, 'security.signout_all', { ip: req.ip });
  res.json({ ok: true });
}));

export { setRecoveryEmail } from './recovery.js';
