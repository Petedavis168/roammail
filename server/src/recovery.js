// Account recovery & self-service: verified recovery emails, "forgot my address", lost-phone 2FA recovery
// with a 72-hour waiting period, admin/support 2FA resets, and the super-admin Support tools.
import express from 'express';
import crypto from 'node:crypto';
import { rateLimit } from './shared.js';
import { config } from './config.js';
import { q, security, audit, rolesFor, twoFactorPolicy } from './db.js';
import { requireAuth, unseal, revokeSessions } from './session.js';
import { mailcow } from './mailcow.js';
import { checkPassword } from './imap.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status });
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const WAIT_HOURS = Number(process.env.TWOFA_RECOVERY_WAIT_HOURS || 72);
const base = (req) => config.publicUrl || `${req.protocol}://${req.get('host')}`;
export const maskEmail = (e) => { const [l, d] = String(e || '').split('@'); return d ? `${l.slice(0, 2)}${'•'.repeat(Math.max(1, l.length - 2))}@${d}` : ''; };

let mailerPromise;
async function mailer() {
  mailerPromise ||= import('./security.js').then((m) => m.systemMailer);
  return (await mailerPromise)();
}
/** Send an email from the system no-reply mailbox. Returns false if system mail isn't configured. */
export async function sendSystemMail(to, subject, html, text) {
  const m = await mailer();
  if (!m) return false;
  await m.sendMail({ from: { name: config.appName, address: config.systemMail.from }, to, subject, html, text: text || html.replace(/<[^<>]*>/g, '').replace(/[<>]/g, '') }); // plain-text part: no markup left at all
  return true;
}
const frame = (title, body) => `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#242424;max-width:560px"><h2 style="color:#244960;margin:0 0 10px">${esc(title)}</h2>${body}<p style="color:#888;font-size:12px;margin-top:24px">${esc(config.appName)} will never ask for your password by email.</p></div>`;

// ---------------------------------------------------------------- recovery email (verified with a code)
export async function startRecoveryVerification(email, recovery) {
  const r = String(recovery || '').trim().toLowerCase();
  await security(email);
  if (!r) { await q.run('UPDATE user_security SET recovery_email = NULL, recovery_verified = 0, recovery_pending = NULL, recovery_code = NULL WHERE email = ?', email); return { cleared: true }; }
  if (!EMAIL_RE.test(r)) throw fail(400, 'Enter a valid email address');
  if (r === email.toLowerCase()) throw fail(400, 'Use a different address than this account');
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  await q.run('UPDATE user_security SET recovery_pending = ?, recovery_code = ?, recovery_code_exp = ?, recovery_code_tries = 0 WHERE email = ?', r, sha(`${email}:${code}`), Date.now() + 30 * 60e3, email);
  const sent = await sendSystemMail(r, `${code} is your ${config.appName} verification code`,
    frame('Confirm your recovery email', `<p>${esc(email)} wants to use this address to recover their account.</p><p style="font-size:28px;letter-spacing:6px;font-weight:700">${code}</p><p>Enter this code in Settings → Security. It expires in 30 minutes. If this wasn't you, ignore this email.</p>`)).catch(() => false);
  return { pending: r, sent };
}
export async function setRecoveryEmail(email, recovery) {
  if (recovery && EMAIL_RE.test(recovery)) await startRecoveryVerification(email, recovery).catch(() => {});
}

// ---------------------------------------------------------------- 2FA reset helpers
export async function resetTwoFactor(email, actor, reason) {
  await security(email);
  await q.run("UPDATE user_security SET totp_enabled = 0, totp_secret = NULL, backup_codes = '[]' WHERE email = ?", email);
  await q.run("UPDATE twofa_resets SET status = 'done' WHERE email = ? AND status = 'pending'", email);
  await revokeSessions(email);
  await audit(actor, null, 'security.2fa_reset', { email, reason: String(reason || '').slice(0, 300) });
  const html = frame('2-step verification was turned off', `<p>2-step verification for <b>${esc(email)}</b> was turned off${actor === email ? '' : ' by support or your administrator'} and you were signed out everywhere.</p><p>Sign in and turn it back on in <b>Settings → Security</b>. If you didn't ask for this, change your password right away and contact support.</p>`);
  const rec = (await q.get('SELECT recovery_email FROM user_security WHERE email = ? AND recovery_verified = 1', email))?.recovery_email;
  await sendSystemMail([email, rec].filter(Boolean), 'Security alert: 2-step verification turned off', html).catch(() => {});
}

/** Called periodically: carry out lost-phone recoveries whose waiting period has passed without a cancel. */
export async function processTwoFactorResets() {
  for (const r of await q.all("SELECT * FROM twofa_resets WHERE status = 'pending' AND execute_after <= ?", Date.now())) {
    const claim = await q.run("UPDATE twofa_resets SET status = 'done' WHERE token_hash = ? AND status = 'pending'", r.token_hash);
    if (claim.changes !== 1) continue;
    await resetTwoFactor(r.email, r.email, 'lost-phone recovery after waiting period');
  }
}

// ---------------------------------------------------------------- public routes
export const publicRecovery = express.Router();
const lim = (n) => rateLimit({ windowMs: 60 * 60 * 1000, limit: n, standardHeaders: true, legacyHeaders: false });

// "Forgot my address": list accounts that use this (verified) recovery email. Same answer either way.
publicRecovery.post('/password/forgot-address', lim(5), wrap(async (req, res) => {
  const r = String(req.body.recoveryEmail || '').trim().toLowerCase();
  res.json({ ok: true, message: 'If any accounts use that recovery email, we\'ve emailed a list of them to it.' });
  if (!EMAIL_RE.test(r)) return;
  const accounts = (await q.all('SELECT email FROM user_security WHERE recovery_email = ? AND recovery_verified = 1 LIMIT 20', r)).map((x) => x.email);
  if (!accounts.length) return;
  await sendSystemMail(r, `Your ${config.appName} addresses`, frame('Your accounts', `<p>These ${esc(config.appName)} accounts use this recovery email:</p><ul>${accounts.map((a) => `<li><b>${esc(a)}</b></li>`).join('')}</ul><p><a href="${esc(base(req))}">Sign in</a>. Forgot the password too? Use "Forgot password?" on the sign-in page.</p>`)).catch(() => {});
  await audit(r, null, 'security.forgot_address', { count: accounts.length, ip: req.ip });
}));

// Lost phone: the person already proved their password (login ticket). Start a 72-hour waiting period.
publicRecovery.post('/recovery/2fa', lim(5), wrap(async (req, res) => {
  const t = unseal(String(req.body.ticket || ''));
  if (!t || t.t !== '2fa') throw fail(401, 'Your sign-in expired. Please start again.');
  const sec = await security(t.email);
  if (!sec.totp_enabled) throw fail(400, '2-step verification is not on for this account');
  const rec = sec.recovery_verified ? sec.recovery_email : null;
  const org = await q.get("SELECT 1 FROM domains WHERE domain = ? AND status = 'active'", t.email.split('@')[1]);
  if (!rec) {
    return res.json({ ok: false, message: org ? 'Ask your administrator to reset 2-step verification for you (Admin → Users → Edit).' : 'This account has no verified recovery email. Contact support so they can confirm it\'s you.' });
  }
  const existing = await q.get("SELECT execute_after FROM twofa_resets WHERE email = ? AND status = 'pending'", t.email);
  if (existing) return res.json({ ok: true, executeAfter: existing.execute_after, message: 'A recovery is already in progress.' });
  const token = crypto.randomBytes(24).toString('base64url');
  const after = Date.now() + WAIT_HOURS * 3600e3;
  await q.run('INSERT INTO twofa_resets(token_hash, email, requested_at, execute_after, ip) VALUES(?, ?, ?, ?, ?)', sha(token), t.email, Date.now(), after, req.ip);
  const when = new Date(after).toUTCString();
  const cancel = `${base(req)}/api/recovery/2fa/cancel?token=${token}`;
  const html = frame('Account recovery started', `<p>Someone who knows the password for <b>${esc(t.email)}</b> said they lost their phone and asked to turn off 2-step verification.</p><p>For your safety it will only happen on <b>${esc(when)}</b>.</p><p><b>Was this you?</b> Then just wait.<br><b>Not you?</b> <a href="${esc(cancel)}">Cancel the recovery</a>, then change your password right away.</p>`);
  await sendSystemMail([t.email, rec], 'Security alert: account recovery started', html).catch(() => {});
  await audit(t.email, null, 'security.2fa_recovery_requested', { ip: req.ip });
  res.json({ ok: true, executeAfter: after, message: `For your safety, 2-step verification will be turned off on ${when}. We emailed ${maskEmail(rec)} and your inbox, with a link to cancel if it wasn't you.` });
}));

publicRecovery.get('/recovery/2fa/cancel', lim(20), wrap(async (req, res) => {
  const row = await q.get("SELECT * FROM twofa_resets WHERE token_hash = ? AND status = 'pending'", sha(String(req.query.token || '')));
  if (row) {
    await q.run("UPDATE twofa_resets SET status = 'canceled' WHERE token_hash = ?", row.token_hash);
    await revokeSessions(row.email);
    await audit(row.email, null, 'security.2fa_recovery_canceled', { ip: req.ip });
  }
  res.type('html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:sans-serif;max-width:520px;margin:12vh auto;padding:20px;color:#242424">
<h2>${row ? 'Recovery canceled' : 'Nothing to cancel'}</h2><p>${row ? '2-step verification stays on, and every device was signed out. If you didn\'t start this, <b>change your password now</b>: someone knows it.' : 'This link was already used or the recovery already finished.'}</p><p><a href="/">Go to sign in</a></p></body>`);
}));

// ---------------------------------------------------------------- signed-in routes
export const recovery = express.Router();
recovery.use(['/security/recovery-email', '/security/recovery-email/verify', '/security/recovery-email/resend', '/super/support'], requireAuth);

const passwordOk = (email, password) => checkPassword(email, password).catch(() => false);

recovery.put('/security/recovery-email', wrap(async (req, res) => {
  if (!(await passwordOk(req.user.email, String(req.body.password || '')))) throw fail(401, 'Enter your current password to change the recovery email');
  const r = await startRecoveryVerification(req.user.email, req.body.email);
  await audit(req.user.email, null, 'security.recovery_email', { set: !r.cleared, ip: req.ip });
  res.json({ ok: true, ...r, message: r.cleared ? 'Recovery email removed' : r.sent ? `We sent a 6-digit code to ${r.pending}.` : 'Saved. Verification emails are not set up on this server yet, so ask your administrator.' });
}));

recovery.post('/security/recovery-email/verify', wrap(async (req, res) => {
  const s = await security(req.user.email);
  if (!s.recovery_pending || !s.recovery_code) throw fail(400, 'There is no code to verify. Add a recovery email first.');
  if (s.recovery_code_exp < Date.now()) throw fail(400, 'That code expired. Send a new one.');
  if (s.recovery_code_tries >= 5) throw fail(429, 'Too many tries. Send a new code.');
  const code = String(req.body.code || '').replace(/\D/g, '');
  const ok = code.length === 6 && crypto.timingSafeEqual(Buffer.from(sha(`${req.user.email}:${code}`)), Buffer.from(s.recovery_code));
  if (!ok) { await q.run('UPDATE user_security SET recovery_code_tries = recovery_code_tries + 1 WHERE email = ?', req.user.email); throw fail(400, 'That code isn\'t right'); }
  await q.run('UPDATE user_security SET recovery_email = recovery_pending, recovery_verified = 1, recovery_pending = NULL, recovery_code = NULL WHERE email = ?', req.user.email);
  await audit(req.user.email, null, 'security.recovery_verified');
  res.json({ ok: true });
}));

recovery.post('/security/recovery-email/resend', lim(6), wrap(async (req, res) => {
  const s = await security(req.user.email);
  const target = s.recovery_pending || (!s.recovery_verified && s.recovery_email);
  if (!target) throw fail(400, 'Nothing to verify');
  const r = await startRecoveryVerification(req.user.email, target);
  res.json({ ok: true, sent: r.sent });
}));

// ---------------------------------------------------------------- super-admin Support tools
async function requireSuper(req) {
  if (!(await rolesFor(req.user.email)).superAdmin) throw fail(403, 'Super-admin only');
  if (config.requireAdmin2fa && !(await twoFactorPolicy(req.user.email)).enabled) throw fail(403, 'Admins must turn on 2-step verification first');
}

recovery.get('/super/support/lookup', wrap(async (req, res) => {
  await requireSuper(req);
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw fail(400, 'Enter a full email address');
  const box = await mailcow.getMailbox(email);
  const sec = await q.get('SELECT * FROM user_security WHERE email = ?', email) || {};
  const org = await q.get("SELECT o.id, o.name, o.plan, o.billing_status, o.suspended FROM domains d JOIN orgs o ON o.id = d.org_id WHERE d.domain = ?", email.split('@')[1]);
  await audit(req.user.email, null, 'support.lookup', { email });
  res.json({
    email, exists: !!box, active: box ? Number(box.active) === 1 : false, name: box?.name || '',
    quotaMb: box ? Math.round(Number(box.quota || 0) / 1048576) : 0, usedMb: box ? Math.round(Number(box.quota_used || 0) / 1048576) : 0,
    org: org || null, signup: await q.get('SELECT created_at, ip FROM signups WHERE email = ?', email) || null,
    twoFactor: !!sec.totp_enabled, recovery: sec.recovery_email ? maskEmail(sec.recovery_email) : null, recoveryVerified: !!sec.recovery_verified,
    pendingRecovery: await q.get("SELECT execute_after FROM twofa_resets WHERE email = ? AND status = 'pending'", email) || null,
    sessions: (await q.get('SELECT COUNT(*) AS n FROM sessions WHERE email = ?', email)).n,
    events: await q.all('SELECT ok, reason, ip, ua, at FROM login_events WHERE email = ? ORDER BY id DESC LIMIT 15', email),
    audit: await q.all("SELECT actor, action, at FROM audit WHERE actor = ? OR detail LIKE ? ORDER BY id DESC LIMIT 20", email, `%${email.replace(/[%_]/g, '')}%`),
  });
}));

recovery.post('/super/support/action', wrap(async (req, res) => {
  await requireSuper(req);
  const email = String(req.body.email || '').trim().toLowerCase();
  const reason = String(req.body.reason || '').trim();
  if (!EMAIL_RE.test(email)) throw fail(400, 'Enter a full email address');
  if (reason.length < 5) throw fail(400, 'Write down why (for the audit log)');
  switch (req.body.action) {
    case 'suspend': await mailcow.editMailbox(email, { active: 0 }); await revokeSessions(email); break;
    case 'unsuspend': await mailcow.editMailbox(email, { active: 1 }); break;
    case 'signout': await revokeSessions(email); break;
    case 'reset2fa': await resetTwoFactor(email, req.user.email, reason); break;
    case 'cancel-recovery': await q.run("UPDATE twofa_resets SET status = 'canceled' WHERE email = ? AND status = 'pending'", email); break;
    default: throw fail(400, 'Unknown action');
  }
  await audit(req.user.email, null, `support.${req.body.action}`, { email, reason: reason.slice(0, 300) });
  res.json({ ok: true });
}));
