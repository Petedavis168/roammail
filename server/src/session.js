// Server-side sessions. The browser cookie is an opaque random token; the mailbox password
// is stored only on the server, encrypted (AES-256-GCM) with a key derived from SESSION_SECRET.
import crypto from 'node:crypto';
import { config } from './config.js';
import { q, twoFactorPolicy, rolesFor } from './db.js';

const COOKIE = 'mc_session';
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

export function seal(data) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', config.sealKey, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

export function unseal(token) {
  return unsealWith(config.sealKey, token) ?? (config.sealKeyPrevious ? unsealWith(config.sealKeyPrevious, token) : null);
}
/** True if the token only opens with the previous key (so the caller can re-seal it). */
export const sealedWithOldKey = (token) => !!config.sealKeyPrevious && !unsealWith(config.sealKey, token) && !!unsealWith(config.sealKeyPrevious, token);

function unsealWith(key, token) {
  try {
    const raw = Buffer.from(String(token), 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const data = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
    if (data.exp && data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

const cookieOpts = (expires) => ({ httpOnly: true, secure: config.cookieSecure, sameSite: 'strict', path: '/', ...(expires ? { expires: new Date(expires) } : {}) });

/** Create a session for a signed-in user and set the cookie. Returns the session id. */
export function setSession(res, { email, password, name }, req) {
  const token = crypto.randomBytes(32).toString('base64url');
  const id = sha(token);
  const now = Date.now();
  const expires = now + config.sessionHours * 3600 * 1000;
  q.run('INSERT INTO sessions(id, email, creds, name, ip, ua, created, last_seen, expires) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, email.toLowerCase(), seal({ password }), name || '', req?.ip || null, String(req?.get?.('user-agent') || '').slice(0, 300), now, now, expires);
  res.cookie(COOKIE, token, cookieOpts(expires));
  return id;
}

export function clearSession(req, res) {
  const token = req.cookies?.[COOKIE];
  if (token) q.run('DELETE FROM sessions WHERE id = ?', sha(token));
  res.clearCookie(COOKIE, { path: '/' });
}

/** Sign a user out everywhere (optionally keeping one session). */
export function revokeSessions(email, exceptId) {
  q.run('DELETE FROM sessions WHERE email = ? AND id != ?', email.toLowerCase(), exceptId || '');
}

/** Store a new password in the current session (after a password change). */
export function updateSessionPassword(id, password) {
  q.run('UPDATE sessions SET creds = ? WHERE id = ?', seal({ password }), id);
}

export const sessionPublicId = (id) => id.slice(0, 16);

let lastSweep = 0;
export function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE];
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  const now = Date.now();
  if (now - lastSweep > 10 * 60 * 1000) {
    lastSweep = now;
    q.run('DELETE FROM sessions WHERE expires < ? OR last_seen < ?', now, now - config.sessionIdleHours * 3600 * 1000);
  }
  const id = sha(token);
  const s = q.get('SELECT * FROM sessions WHERE id = ?', id);
  if (!s || s.expires < now || s.last_seen < now - config.sessionIdleHours * 3600 * 1000) {
    if (s) q.run('DELETE FROM sessions WHERE id = ?', id);
    res.clearCookie(COOKIE, { path: '/' });
    return res.status(401).json({ error: 'Your session ended. Please sign in again.' });
  }
  const creds = unseal(s.creds);
  if (!creds) return res.status(401).json({ error: 'Please sign in again.' });
  if (now - s.last_seen > 60 * 1000) q.run('UPDATE sessions SET last_seen = ?, ip = ? WHERE id = ?', now, req.ip, id);
  // sid doubles as the IMAP connection-pool key
  req.user = { email: s.email, password: creds.password, name: s.name, sid: id };

  // 2-step verification enforcement
  const path = (req.originalUrl || '').split('?')[0];
  const setupPaths = /^\/api\/(me|logout|events|security(\/2fa\/(setup|enable))?|security\/sessions|signup\/config)$/;
  const pol = twoFactorPolicy(s.email);
  if (!pol.enabled) {
    if (pol.requiredByOrg && !setupPaths.test(path)) {
      return res.status(403).json({ error: 'Your organization requires 2-step verification. Set it up to continue.', code: '2fa_required' });
    }
    if (config.requireAdmin2fa && /^\/api\/(admin|super)\//.test(path)) {
      const r = rolesFor(s.email);
      if (r.superAdmin || r.orgs.some((o) => o.role === 'admin')) {
        return res.status(403).json({ error: 'Admins must turn on 2-step verification first (Settings → Security).', code: 'admin_2fa_required' });
      }
    }
  }
  next();
}
