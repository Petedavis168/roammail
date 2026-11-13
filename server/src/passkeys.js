// Passkeys: sign in with Face ID, fingerprint, Windows Hello or a security key instead of a password and code.
// A passkey can't be phished: the browser only uses it on roammail.net, so it also replaces the 2-step code.
//
// The mail server still needs the mailbox password to open the mailbox. When someone adds a passkey (after typing
// their password), that password is stored encrypted with the passkey, like a "keep me signed in" session.
// A password change or "sign out everywhere" removes all passkeys; the person adds them again with the new password.
import express from 'express';
import crypto from 'node:crypto';
import {
  generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { config } from './config.js';
import { q, audit } from './db.js';
import { seal, unseal, requireAuth, onRevoke } from './session.js';
import { checkPassword as checkMailPassword } from './imap.js';
import { loginBlocked, loginFailed } from './abuse.js';
import { finishLogin, logEvent } from './security.js';
import { rateLimit } from './shared.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status });
const MAX_PER_USER = 10;

// The passkey belongs to the main domain, so it works on roammail.net and login.roammail.net (and in the apps)
const rpID = (req) => config.rootDomain || req.hostname;
const origins = (req) => {
  const o = new Set([`${req.protocol}://${req.get('host')}`]);
  if (config.rootDomain) { o.add(`https://${config.rootDomain}`); if (config.loginHost) o.add(`https://${config.loginHost}`); if (config.adminHost) o.add(`https://${config.adminHost}`); }
  return [...o];
};
const deviceName = (ua = '') => (/iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone'
  : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : /CrOS/.test(ua) ? 'Chromebook' : 'This device');

// ---------------------------------------------------------------- managing passkeys (signed in)
export const passkeysApi = express.Router();
passkeysApi.use('/passkeys', requireAuth);

passkeysApi.get('/passkeys', wrap(async (req, res) => {
  const rows = await q.all('SELECT id, name, created_at, last_used FROM passkeys WHERE email = ? ORDER BY created_at', req.user.email);
  res.json(rows.map((r) => ({ id: r.id, name: r.name, created: r.created_at, lastUsed: r.last_used })));
}));

passkeysApi.post('/passkeys/register/options', wrap(async (req, res) => {
  const password = String(req.body.password || '');
  if (!(await checkMailPassword(req.user.email, password))) throw fail(401, 'Wrong password');
  const existing = await q.all('SELECT id, transports FROM passkeys WHERE email = ?', req.user.email);
  if (existing.length >= MAX_PER_USER) throw fail(400, `You can have up to ${MAX_PER_USER} passkeys. Remove one first.`);
  const options = await generateRegistrationOptions({
    rpName: config.appName, rpID: rpID(req), userName: req.user.email, userDisplayName: req.user.name || req.user.email,
    userID: new TextEncoder().encode(crypto.createHash('sha256').update(`passkey:${req.user.email}`).digest('hex').slice(0, 32)),
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: JSON.parse(c.transports || '[]') })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  res.json({ options, token: seal({ t: 'pk-reg', email: req.user.email, password, challenge: options.challenge, exp: Date.now() + 5 * 60e3 }) });
}));

passkeysApi.post('/passkeys/register/verify', wrap(async (req, res) => {
  const t = unseal(String(req.body.token || ''));
  if (!t || t.t !== 'pk-reg' || t.exp < Date.now() || t.email !== req.user.email) throw fail(400, 'That took too long. Please try again.');
  let v;
  try {
    v = await verifyRegistrationResponse({ response: req.body.response, expectedChallenge: t.challenge, expectedOrigin: origins(req), expectedRPID: rpID(req), requireUserVerification: true });
  } catch { throw fail(400, "Your device couldn't create the passkey. Please try again."); }
  if (!v.verified) throw fail(400, "Your device couldn't create the passkey. Please try again.");
  const c = v.registrationInfo.credential;
  const name = String(req.body.name || '').trim().slice(0, 60) || deviceName(req.get('user-agent'));
  await q.run('INSERT INTO passkeys(id, email, public_key, counter, transports, name, creds, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
    c.id, req.user.email, Buffer.from(c.publicKey).toString('base64url'), c.counter || 0, JSON.stringify(c.transports || []), name, seal({ password: t.password }), Date.now());
  await audit(req.user.email, null, 'security.passkey_added', { name });
  res.json({ ok: true, name });
}));

passkeysApi.delete('/passkeys', wrap(async (req, res) => {
  await q.run('DELETE FROM passkeys WHERE email = ? AND id = ?', req.user.email, String(req.query.id || ''));
  await audit(req.user.email, null, 'security.passkey_removed');
  res.json({ ok: true });
}));

// Password changed or "sign out everywhere": the stored password is wrong or must not be used any more
onRevoke((email) => { q.run('DELETE FROM passkeys WHERE email = ?', email).catch(() => {}); });

// ---------------------------------------------------------------- signing in with a passkey
export const passkeyLogin = express.Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

passkeyLogin.post('/login/passkey/options', limiter, wrap(async (req, res) => {
  // No email needed: the device shows the passkeys it has for roammail.net
  const options = await generateAuthenticationOptions({ rpID: rpID(req), userVerification: 'required', allowCredentials: [] });
  res.json({ options, token: seal({ t: 'pk-auth', challenge: options.challenge, exp: Date.now() + 5 * 60e3 }) });
}));

passkeyLogin.post('/login/passkey', limiter, wrap(async (req, res) => {
  const t = unseal(String(req.body.token || ''));
  if (!t || t.t !== 'pk-auth' || t.exp < Date.now()) throw fail(400, 'That took too long. Please try again.');
  const id = String(req.body.response?.id || '');
  const pk = id && await q.get('SELECT * FROM passkeys WHERE id = ?', id);
  if (!pk) throw fail(401, "This passkey isn't set up for Roammail any more. Sign in with your password, then add it again in Settings → Security.");
  if (await loginBlocked(pk.email, req.ip)) throw fail(429, 'Too many failed attempts. Try again later.');
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response: req.body.response, expectedChallenge: t.challenge, expectedOrigin: origins(req), expectedRPID: rpID(req), requireUserVerification: true,
      credential: { id: pk.id, publicKey: Buffer.from(pk.public_key, 'base64url'), counter: Number(pk.counter || 0), transports: JSON.parse(pk.transports || '[]') },
    });
  } catch { v = null; }
  if (!v?.verified) {
    await loginFailed(pk.email, req.ip);
    await logEvent(req, pk.email, false, 'passkey');
    throw fail(401, "That passkey didn't work. Try again or sign in with your password.");
  }
  const password = unseal(pk.creds)?.password;
  if (!password || !(await checkMailPassword(pk.email, password))) {
    await q.run('DELETE FROM passkeys WHERE email = ?', pk.email); // password changed elsewhere (e.g. by an admin)
    throw fail(401, 'Your password has changed since you added this passkey. Sign in with your password, then add the passkey again.');
  }
  await q.run('UPDATE passkeys SET counter = ?, last_used = ? WHERE id = ?', v.authenticationInfo.newCounter, Date.now(), pk.id);
  await finishLogin(req, res, { email: pk.email, password, remember: req.body.remember === true, how: 'passkey' });
}));
