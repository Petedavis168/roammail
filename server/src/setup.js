// First sign-in setup (punch list item 8). A mailbox whose password was set by an admin, an invite, a reset or the
// server tool ("temporary") must choose its own password, and must turn on 2-step verification (admins and orgs that
// require it: always; everyone else may postpone 3 times, a day each). Until both are done every API call except the
// wizard's own returns 403 setup_required.
import express from 'express';
import crypto from 'node:crypto';
import { config } from './config.js';
import { q, security, rolesFor, twoFactorPolicy, audit } from './db.js';
import { verify as verifyProvisionerSig } from './provisioner.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
export const MAX_2FA_SNOOZES = 3;

async function row(email) {
  const e = String(email).toLowerCase();
  return q.get('SELECT * FROM account_setup WHERE email = ?', e);
}
/** The password was set by someone else (admin, invite, reset email, server tool): the person must replace it. */
export async function markTemporary(email, source = 'admin') {
  const e = String(email).toLowerCase();
  await q.run(`INSERT INTO account_setup(email, must_change_password, source, created_at) VALUES(?, 1, ?, ?)
    ON CONFLICT(email) DO UPDATE SET must_change_password = 1, source = excluded.source`, e, source, Date.now());
}
/** The person chose this password themselves. */
export async function markChosen(email) {
  const e = String(email).toLowerCase();
  await q.run(`INSERT INTO account_setup(email, must_change_password, source, created_at) VALUES(?, 0, 'self', ?)
    ON CONFLICT(email) DO UPDATE SET must_change_password = 0`, e, Date.now());
}
/** A mailbox signing in for the first time that the app didn't create (e.g. made directly in mailcow): treat its password as temporary. */
export async function ensureSetupRow(email) {
  const e = String(email).toLowerCase();
  if (await row(e)) return;
  // Signed up through the app before setup tracking existed: the person chose this password
  const selfSignup = await q.get('SELECT 1 FROM signups WHERE email = ?', e);
  await q.run('INSERT INTO account_setup(email, must_change_password, source, created_at) VALUES(?, ?, ?, ?) ON CONFLICT(email) DO NOTHING',
    e, selfSignup ? 0 : 1, selfSignup ? 'self' : 'external', Date.now());
}

async function twoFactorRequired(email) {
  const pol = await twoFactorPolicy(email);
  if (pol.requiredByOrg) return true;
  const r = await rolesFor(email);
  return r.superAdmin || r.orgs.some((o) => o.role === 'admin');
}

/** Which blocking steps are still to do: ['password', '2fa'] (empty = done). */
export async function setupState(email) {
  const e = String(email).toLowerCase();
  const s = (await row(e)) || { must_change_password: 0, twofa_snoozes: 0, twofa_snooze_until: 0 };
  const sec = await q.get('SELECT totp_enabled, recovery_email, recovery_verified, recovery_pending FROM user_security WHERE email = ?', e);
  const required = await twoFactorRequired(e);
  const snoozed = !required && Number(s.twofa_snooze_until || 0) > Date.now();
  const steps = [];
  if (s.must_change_password) steps.push('password');
  if (!sec?.totp_enabled && !snoozed) steps.push('2fa');
  // a recovery email given at sign-up counts (it can be confirmed later in Settings -> Security)
  const fromSignup = sec?.recovery_email || sec?.recovery_pending ? null : (await q.get('SELECT recovery_email FROM signups WHERE email = ?', e))?.recovery_email;
  return {
    setupRequired: steps,
    twoFactorRequired: required,
    snoozesLeft: required ? 0 : Math.max(0, MAX_2FA_SNOOZES - Number(s.twofa_snoozes || 0)),
    recoveryEmail: sec?.recovery_email || sec?.recovery_pending || fromSignup || '', recoveryVerified: !!sec?.recovery_verified,
    // site owners never get the optional first-sign-in tour (required steps above still apply)
    onboarded: !!s.onboarded_at || config.superAdmins.includes(e),
  };
}

// Paths the wizard needs while setup is incomplete
const WIZARD = /^\/api\/(me|logout|setup(\/.*)?|security|security\/2fa\/(setup|enable)|security\/recovery-email(\/(verify|resend))?|signup\/config|status)$/;
export async function setupGate(req, res) {
  if (WIZARD.test((req.originalUrl || '').split('?')[0])) return true;
  const st = await setupState(req.user.email);
  if (!st.setupRequired.length) return true;
  res.status(403).json({ error: 'Finish setting up your account first.', code: 'setup_required', setupRequired: st.setupRequired });
  return false;
}

const logStep = (req, email, step) => q.run('INSERT INTO login_events(email, ip, ua, ok, reason) VALUES(?, ?, ?, 1, ?)',
  email, req.ip, String(req.get('user-agent') || '').slice(0, 300), `setup:${step}`);

export const setupApi = express.Router();
setupApi.get('/setup', wrap(async (req, res) => res.json(await setupState(req.user.email))));

// Step 1: choose a password (replaces the temporary one in mailcow via the provisioner)
setupApi.post('/setup/password', wrap(async (req, res) => {
  const { mailcow } = await import('./mailcow.js');
  const { updateSessionPassword, revokeSessions } = await import('./session.js');
  const { assertNotBreached } = await import('./abuse.js');
  const pw = String(req.body.password || '');
  if (pw.length < 10 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw fail(400, 'Use at least 10 characters with letters and numbers');
  if (pw === req.user.password) throw fail(400, 'Choose a new password, not the temporary one');
  const local = req.user.email.split('@')[0].toLowerCase();
  if (local.length >= 4 && pw.toLowerCase().includes(local)) throw fail(400, 'Your password must not contain your email name'); // short names (al, emp) are inside ordinary words
  await assertNotBreached(pw, req.user.email);
  await mailcow.editMailbox(req.user.email, { password: pw, password2: pw });
  await updateSessionPassword(req.user.sid, pw);
  await revokeSessions(req.user.email, req.user.sid); // anyone holding the temporary password is signed out
  await markChosen(req.user.email);
  await logStep(req, req.user.email, 'password');
  await audit(req.user.email, null, 'setup.password');
  res.json({ ok: true, ...(await setupState(req.user.email)) });
}));

// Step 2 (postpone): free and ordinary business users may postpone 2-step verification up to 3 times, a day each
setupApi.post('/setup/2fa/remind', wrap(async (req, res) => {
  const st = await setupState(req.user.email);
  if (st.twoFactorRequired) throw fail(403, '2-step verification is required for your account');
  if (st.snoozesLeft <= 0) throw fail(403, "You've postponed this 3 times. Please turn it on now; it takes a minute.");
  await q.run(`INSERT INTO account_setup(email, must_change_password, twofa_snoozes, twofa_snooze_until, source, created_at) VALUES(?, 0, 1, ?, 'self', ?)
    ON CONFLICT(email) DO UPDATE SET twofa_snoozes = account_setup.twofa_snoozes + 1, twofa_snooze_until = excluded.twofa_snooze_until`,
  req.user.email, Date.now() + 864e5, Date.now());
  await logStep(req, req.user.email, '2fa-postponed');
  res.json({ ok: true, ...(await setupState(req.user.email)) });
}));

setupApi.post('/setup/step', wrap(async (req, res) => {
  const step = String(req.body.step || '').replace(/[^a-z0-9-]/g, '').slice(0, 30);
  if (step) await logStep(req, req.user.email, step);
  if (step === 'done') await q.run('UPDATE account_setup SET onboarded_at = ? WHERE email = ?', Date.now(), req.user.email);
  res.json({ ok: true });
}));

// Server tool / admin: make a mailbox go through setup on next sign-in (e.g. after `fwd-mail new` or a manual reset).
// Callable by an admin of that mailbox's business, a super-admin, or the server tool with a provisioner-signed request.
export const requireSetupApi = express.Router();
requireSetupApi.post('/admin/users/:email/require-setup', wrap(async (req, res, next) => {
  const email = String(req.params.email || '').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail(400, 'Invalid address');
  const signed = req.get('X-FWD-Signature') && config.provisioner.secret
    && verifyProvisionerSig(config.provisioner.secret, { ts: req.get('X-FWD-Timestamp'), signature: req.get('X-FWD-Signature'), path: req.originalUrl.split('?')[0], body: req.rawBody ? req.rawBody.toString('utf8') : '' });
  if (!signed) {
    const { requireAuth } = await import('./session.js');
    await new Promise((resolve, reject) => requireAuth(req, res, (e) => (e ? reject(e) : resolve())));
    if (res.headersSent) return;
    const r = await rolesFor(req.user.email);
    const dom = await q.get("SELECT org_id FROM domains WHERE domain = ? AND status = 'active'", email.split('@')[1]);
    if (!r.superAdmin && !(dom && r.orgs.some((o) => o.id === dom.org_id && o.role === 'admin'))) throw fail(404, 'Not found');
  }
  await markTemporary(email, signed ? 'server-tool' : 'admin');
  await audit(signed ? 'server-tool' : req.user.email, null, 'setup.required', { email });
  res.json({ ok: true });
}));

export const randomTempPassword = () => `${crypto.randomBytes(18).toString('base64url')}!a1`;
