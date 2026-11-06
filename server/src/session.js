// Stateless, encrypted session cookie (AES-256-GCM). The mailbox password lives only
// inside the encrypted cookie and in memory while an IMAP connection is open.
import crypto from 'node:crypto';
import { config } from './config.js';
import { security } from './db.js';

const COOKIE = 'mc_session';

export function seal(data) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', config.sessionSecret, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

export function unseal(token) {
  try {
    const raw = Buffer.from(token, 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', config.sessionSecret, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const data = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

export function setSession(res, { email, password, name, sid }) {
  const exp = Date.now() + config.sessionHours * 3600 * 1000;
  sid = sid || crypto.randomBytes(16).toString('hex');
  const epoch = security(email).session_epoch;
  res.cookie(COOKIE, seal({ email, password, name, sid, exp, epoch }), {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict',
    expires: new Date(exp),
    path: '/',
  });
}

export function clearSession(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

export function requireAuth(req, res, next) {
  const s = req.cookies?.[COOKIE] && unseal(req.cookies[COOKIE]);
  // "Sign out everywhere" / password change bump the epoch and invalidate older cookies
  if (!s || (s.epoch ?? 0) !== security(s.email).session_epoch) return res.status(401).json({ error: 'Not signed in' });
  req.user = s;
  next();
}
