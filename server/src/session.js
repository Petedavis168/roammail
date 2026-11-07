import { broadcast, onBroadcast, counter } from './shared.js';
import { resolveMailboxId } from './mailboxids.js';
import { onStoredCredentialsRejected } from './imap.js';
import { setupGate } from './setup.js';
// Server-side sessions. The browser cookie is an opaque random token; the mailbox password
// is stored only on the server, encrypted (AES-256-GCM) with a key derived from SESSION_SECRET.
import crypto from 'node:crypto';
import { config } from './config.js';
import { q, twoFactorPolicy, rolesFor, userIdFor } from './db.js';

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

// Domain=.roammail.net so login.roammail.net and roammail.net share the sign-in; Lax so links from email open signed in.
const baseOpts = () => ({ httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/', ...(config.cookieDomain ? { domain: config.cookieDomain } : {}) });
const cookieOpts = (expires) => ({ ...baseOpts(), ...(expires ? { expires: new Date(expires) } : {}) });

// One cookie can hold up to 10 signed-in mailboxes ("tokenA.tokenB"); the URL's mailbox ID picks which one is used.
export const MAX_ACCOUNTS = 10;
const tokensOf = (req) => String(req.cookies?.[COOKIE] || '').split('.').filter((t) => /^[A-Za-z0-9_-]{43}$/.test(t)).slice(0, MAX_ACCOUNTS);
function writeTokens(res, tokens, remember = false) {
  if (tokens.length) res.cookie(COOKIE, tokens.join('.'), cookieOpts(Date.now() + (remember ? REMEMBER_MS : config.sessionHours * 3600 * 1000)));
  else res.clearCookie(COOKIE, baseOpts());
}

/** Create a session for a signed-in user and set the cookie. Returns the session id. */
export const REMEMBER_MS = 30 * 864e5; // "Keep me signed in": 30 days, extended each time the mailbox is used
const idleLimit = (s) => (s.remember ? REMEMBER_MS : config.sessionIdleHours * 3600 * 1000);
export async function setSession(res, { email, password, name, remember = false }, req) {
  const token = crypto.randomBytes(32).toString('base64url');
  const id = sha(token);
  const now = Date.now();
  const expires = now + (remember ? REMEMBER_MS : config.sessionHours * 3600 * 1000);
  await q.run('INSERT INTO sessions(id, email, creds, name, ip, ua, created, last_seen, expires, user_id, remember) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, email.toLowerCase(), seal({ password }), name || '', req?.ip || null, String(req?.get?.('user-agent') || '').slice(0, 300), now, now, expires, await userIdFor(email), remember ? 1 : 0);
  // Signing in again to the same mailbox replaces its old session; the newest account becomes the default
  const keep = [];
  for (const t of tokensOf(req)) {
    const old = await q.get('SELECT email FROM sessions WHERE id = ?', sha(t));
    if (old && old.email === email.toLowerCase()) await q.run('DELETE FROM sessions WHERE id = ?', sha(t));
    else if (old) keep.push(t);
  }
  writeTokens(res, [token, ...keep].slice(0, MAX_ACCOUNTS), remember || (await anyRemembered(keep)));
  return id;
}

async function anyRemembered(tokens) {
  for (const t of tokens) if ((await q.get('SELECT remember FROM sessions WHERE id = ?', sha(t)))?.remember) return true;
  return false;
}

/** Sign out the current mailbox only (or every mailbox in this browser with all=true). */
export async function clearSession(req, res, { all = false } = {}) {
  const tokens = tokensOf(req);
  const current = req.user?.sid;
  const keep = [];
  for (const t of tokens) {
    if (all || !current || sha(t) === current) await q.run('DELETE FROM sessions WHERE id = ?', sha(t));
    else keep.push(t);
  }
  writeTokens(res, keep, await anyRemembered(keep));
}

/** Sign a user out everywhere (optionally keeping one session). */
/** Run fn(email) on every server whenever someone's sessions are revoked (used to drop their live connections). */
export function onRevoke(fn) { onBroadcast('revoke', (email) => { try { fn(email); } catch { /* ignore */ } }); }
export async function revokeSessions(email, exceptId) {
  await q.run('DELETE FROM sessions WHERE email = ? AND id != ?', email.toLowerCase(), exceptId || '');
  broadcast('revoke', email.toLowerCase());
}

/** Store a new password in the current session (after a password change). */
export async function updateSessionPassword(id, password) {
  await q.run('UPDATE sessions SET creds = ? WHERE id = ?', seal({ password }), id);
}

export const sessionPublicId = (id) => id.slice(0, 16);

// A session whose saved password the mail server rejects is ended (the person signs in again once).
onStoredCredentialsRejected(async (user) => {
  if (user.sharedBy) return; // shared mailbox: its own password is managed by the app, nothing to end
  await q.run('DELETE FROM sessions WHERE id = ?', String(user.sid).split('|')[0]);
});

/** Emails of the mailboxes signed in on this browser (read-only; for page routing). */
export async function browserMailboxes(req) {
  const now = Date.now(); const out = [];
  for (const t of tokensOf(req)) {
    const s = await q.get('SELECT email, expires, last_seen, remember FROM sessions WHERE id = ?', sha(t));
    if (s && s.expires > now && s.last_seen > now - idleLimit(s)) out.push(s.email);
  }
  return out;
}

let lastSweep = 0;
export async function requireAuth(req, res, next) {
  const tokens = tokensOf(req);
  if (!tokens.length) return res.status(401).json({ error: 'Not signed in' });
  const now = Date.now();
  if (now - lastSweep > 10 * 60 * 1000) {
    lastSweep = now;
    await q.run('DELETE FROM sessions WHERE expires < ? OR (last_seen < ? AND remember = 0) OR last_seen < ?', now, now - config.sessionIdleHours * 3600 * 1000, now - REMEMBER_MS);
  }
  const live = [];
  for (const t of tokens) {
    const s = await q.get('SELECT * FROM sessions WHERE id = ?', sha(t));
    if (!s || s.expires < now || s.last_seen < now - idleLimit(s)) { if (s) await q.run('DELETE FROM sessions WHERE id = ?', s.id); continue; }
    live.push({ t, s });
  }
  const remembered = live.some((x) => x.s.remember);
  if (live.length !== tokens.length) writeTokens(res, live.map((x) => x.t), remembered);
  if (!live.length) return res.status(401).json({ error: 'Your session ended. Please sign in again.' });

  // Which mailbox? The public ID from the URL (X-Mailbox-Id header, or ?mid= for live updates). It is only a name:
  // it must belong to one of this browser's signed-in mailboxes, or to a shared mailbox one of them may open.
  const wantId = String(req.get('X-Mailbox-Id') || req.query.mid || '');
  let pick = live[0];
  req.delegatedMailbox = null;
  if (wantId) {
    const r = await resolveMailboxId(wantId);
    const own = r && live.find((x) => x.s.email === r.email);
    if (own) pick = own;
    else {
      let delegate = null;
      if (r) for (const x of live) if (await q.get('SELECT 1 FROM shared_access WHERE mailbox = ? AND member = ?', r.email, x.s.email)) { delegate = x; break; }
      if (!delegate) {
        if (await counter.hit(`idmiss:${req.ip}`, 10 * 60 * 1000) > 30) return res.status(429).json({ error: 'Too many requests' });
        return res.status(404).json({ error: 'Not found' }); // never reveal whether the ID exists
      }
      pick = delegate;
      req.delegatedMailbox = r.email;
    }
  }
  const s = pick.s; const id = s.id;
  const creds = unseal(s.creds);
  if (!creds) return res.status(401).json({ error: 'Please sign in again.' });
  if (now - s.last_seen > 60 * 1000) {
    await q.run('UPDATE sessions SET last_seen = ?, ip = ?, expires = CASE WHEN remember = 1 THEN ? ELSE expires END WHERE id = ?', now, req.ip, now + REMEMBER_MS, id);
    if (s.remember && now - s.last_seen > 3600 * 1000) writeTokens(res, live.map((x) => x.t), true); // rolling: keep the cookie alive too
  }
  // sid doubles as the IMAP connection-pool key
  req.user = { email: s.email, password: creds.password, name: s.name, sid: id, userId: s.user_id || null };
  req.accounts = live.map((x) => ({ email: x.s.email, name: x.s.name }));
  // Every signed-in mailbox on this browser (All inboxes, unread badges); passwords are unsealed only when used
  req.liveSessions = live.map((x) => x.s);

  // First sign-in setup: temporary password replaced + 2-step verification (see setup.js)
  if (!(await setupGate(req, res))) return;
  next();
}
