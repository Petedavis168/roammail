// Sign in with Microsoft or Google, for businesses (single sign-on).
//
// 1. A business admin connects the company's Microsoft 365 (Entra ID) or Google Workspace: they sign in once with
//    their work account and we remember which company (tenant) it belongs to.
// 2. Each person links their Roammail mailbox to their work account once, after typing their Roammail password.
//    The mail server still needs that password to open the mailbox, so it's kept encrypted with the link, like
//    passkeys and "keep me signed in". Only accounts from the company's own tenant can be linked or used.
// 3. After that, "Sign in with Microsoft / Google" signs them in. Their company's sign-in rules (its 2-step
//    verification, blocked accounts) apply; when the company blocks someone there, they can't get in here either.
// A password change, "sign out everywhere", the admin disconnecting the company or switching provider removes links.
//
// We use the authorization-code flow with our client secret; the ID token comes straight from Microsoft or Google
// over TLS, so (as OpenID Connect allows) its claims are trusted without fetching signing keys. Each flow carries a
// sealed state with a one-time nonce. Settings: MS_CLIENT_ID / MS_CLIENT_SECRET (the same Entra app as Outlook
// imports) and GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET. Redirect URIs: {PUBLIC_URL}/api/sso/callback/microsoft and
// {PUBLIC_URL}/api/sso/callback/google.
import express from 'express';
import crypto from 'node:crypto';
import { config } from './config.js';
import { q, audit, rolesFor } from './db.js';
import { seal, unseal, requireAuth, onRevoke } from './session.js';
import { checkPassword as checkMailPassword } from './imap.js';
import { loginBlocked, loginFailed } from './abuse.js';
import { logEvent, finishLoginSession } from './security.js';
import { requireOrgAdmin } from './accounts.js';
import { rateLimit } from './shared.js';
import { loginUrl } from './hosts.js';
import { ensureMailboxId, appBase } from './mailboxids.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status });
const prod = process.env.NODE_ENV === 'production';
const env = process.env;
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

const PROVIDERS = {
  microsoft: {
    name: 'Microsoft',
    id: () => env.MS_CLIENT_ID, secret: () => env.MS_CLIENT_SECRET,
    base: () => (!prod && env.SSO_MS_BASE) || 'https://login.microsoftonline.com',
    authorize: (b) => `${b}/organizations/oauth2/v2.0/authorize`, token: (b) => `${b}/organizations/oauth2/v2.0/token`,
    issuer: (b, c) => `${b}/${c.tid}/v2.0`,
    // the company and the person: tenant ID, and the person's object ID in it (stable, unlike their email)
    tenant: (c) => c.tid, subject: (c) => (c.tid && c.oid ? `${c.tid}:${c.oid}` : ''), label: (c) => c.email || c.preferred_username || '',
  },
  google: {
    name: 'Google',
    id: () => env.GOOGLE_CLIENT_ID, secret: () => env.GOOGLE_CLIENT_SECRET,
    base: () => (!prod && env.SSO_GOOGLE_BASE) || '',
    authorize: (b) => (b ? `${b}/o/oauth2/v2/auth` : 'https://accounts.google.com/o/oauth2/v2/auth'),
    token: (b) => (b ? `${b}/token` : 'https://oauth2.googleapis.com/token'),
    issuer: (b) => (b || 'https://accounts.google.com'),
    // Google Workspace accounts carry hd (the company's domain); personal Gmail accounts don't and can't be used
    tenant: (c) => c.hd, subject: (c) => c.sub || '', label: (c) => c.email || '',
  },
};
const enabled = (p) => !!(PROVIDERS[p] && PROVIDERS[p].id() && PROVIDERS[p].secret());
const pick = (p) => { if (!enabled(p)) throw fail(400, 'This sign-in option isn’t set up on this server yet.'); return PROVIDERS[p]; };
const base = (req) => config.publicUrl || (prod ? '' : `${req.protocol}://${req.get('host')}`);
const redirectUri = (req, p) => `${base(req)}/api/sso/callback/${p}`;

// Each flow is tied to the browser that started it (a short-lived cookie), so nobody can send someone a ready-made
// sign-in link that lands them in another person's mailbox.
const BIND = 'mc_sso';
const bindCookie = (res, v) => res.cookie(BIND, v, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: 10 * 60e3, path: '/api/sso', ...(config.cookieDomain ? { domain: config.cookieDomain } : {}) });
const cookieOf = (req, name) => { for (const c of String(req.headers.cookie || '').split(/;\s*/)) { const i = c.indexOf('='); if (c.slice(0, i) === name) return decodeURIComponent(c.slice(i + 1)); } return ''; };

function authUrl(req, res, p, purpose, extra) {
  const P = pick(p);
  const nonce = crypto.randomBytes(16).toString('base64url');
  const bind = crypto.randomBytes(16).toString('base64url');
  bindCookie(res, bind);
  const state = seal({ t: 'sso', p, purpose, nonce, bind, exp: Date.now() + 10 * 60e3, ...extra });
  const u = new URL(P.authorize(P.base()));
  u.search = new URLSearchParams({ client_id: P.id(), response_type: 'code', redirect_uri: redirectUri(req, p), scope: 'openid email profile', state, nonce, prompt: 'select_account', ...(extra.hint ? { login_hint: extra.hint } : {}) }).toString();
  return u.toString();
}

/** Trade the code for the person's identity, checking it's for us, fresh and from this flow. */
async function identity(req, p, code, nonce) {
  const P = pick(p);
  const r = await fetch(P.token(P.base()), {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: P.id(), client_secret: P.secret(), grant_type: 'authorization_code', code, redirect_uri: redirectUri(req, p) }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.id_token) throw new Error('token');
  let c;
  try { c = JSON.parse(Buffer.from(String(d.id_token).split('.')[1], 'base64url').toString()); } catch { throw new Error('token'); }
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(P.id()) || c.nonce !== nonce || !(Number(c.exp) * 1000 > Date.now())) throw new Error('token');
  if (c.iss !== P.issuer(P.base(), c) && !(p === 'google' && c.iss === 'accounts.google.com')) throw new Error('token');
  return { tenant: String(P.tenant(c) || '').toLowerCase(), subject: String(P.subject(c)), label: String(P.label(c)).toLowerCase().slice(0, 200) };
}

async function orgFor(email) {
  return q.get('SELECT o.* FROM orgs o JOIN domains d ON d.org_id = o.id WHERE d.domain = ?', String(email).split('@')[1]);
}
async function stillAdmin(email, orgId) {
  const r = await rolesFor(email);
  return r.superAdmin || r.orgs.some((o) => o.id === Number(orgId) && o.role === 'admin');
}

// ---------------------------------------------------------------- public
export const ssoPublic = express.Router();
const limiter = rateLimit({ windowMs: 10 * 60e3, limit: 40, standardHeaders: true, legacyHeaders: false });

// The sign-in page asks which buttons to show
ssoPublic.get('/sso/options', (req, res) => res.json({ microsoft: enabled('microsoft'), google: enabled('google') }));

// "Sign in with Microsoft / Google" (a normal link, so it also works in the phone apps)
ssoPublic.get('/sso/login/:p', limiter, (req, res) => {
  if (!enabled(req.params.p)) return res.redirect(302, loginUrl('/?sso=unavailable'));
  res.redirect(302, authUrl(req, res, req.params.p, 'login', { remember: req.query.remember === '1' }));
});

ssoPublic.get('/sso/callback/:p', limiter, wrap(async (req, res) => {
  const p = req.params.p;
  const st = unseal(String(req.query.state || ''));
  const toLogin = (why) => res.redirect(302, loginUrl(`/?sso=${why}`));
  if (!PROVIDERS[p] || !st || st.t !== 'sso' || st.p !== p || st.exp < Date.now()) return toLogin('expired');
  const bound = cookieOf(req, BIND);
  if (!bound || !crypto.timingSafeEqual(Buffer.from(sha(bound)), Buffer.from(sha(st.bind || '')))) return toLogin('expired'); // started in another browser
  res.clearCookie(BIND, { path: '/api/sso', ...(config.cookieDomain ? { domain: config.cookieDomain } : {}) });
  // admins go back to Admin, people linking to Settings → Security
  const page = st.purpose === 'org' ? 'admin' : st.purpose === 'link' ? 'settings' : '';
  const id = page && st.email ? await ensureMailboxId(st.email) : '';
  const back = page ? (why) => res.redirect(302, `${appBase()}/${id}/${page}?sso=${why}`) : toLogin;
  if (req.query.error || !req.query.code) return back('cancelled');
  let who;
  try { who = await identity(req, p, String(req.query.code), st.nonce); } catch { return back('failed'); }
  if (!who.subject) return back('failed');

  if (st.purpose === 'org') {
    // An admin connected the company: remember its tenant (a Google account must be a Workspace account)
    if (!(await stillAdmin(st.email, st.orgId))) return back('failed');
    if (!who.tenant) return back('personal-account');
    const prev = await q.get('SELECT sso_provider, sso_tenant FROM orgs WHERE id = ?', st.orgId);
    await q.run('UPDATE orgs SET sso_provider = ?, sso_tenant = ? WHERE id = ?', p, who.tenant, st.orgId);
    if (prev?.sso_provider && (prev.sso_provider !== p || prev.sso_tenant !== who.tenant)) await dropOrgLinks(st.orgId);
    await audit(st.email, st.orgId, 'sso.connected', { provider: p, tenant: who.tenant, by: who.label });
    return back('connected');
  }

  if (st.purpose === 'link') {
    const org = await orgFor(st.email);
    if (!org || org.sso_provider !== p || !who.tenant || org.sso_tenant !== who.tenant) return back('wrong-company');
    await q.run('DELETE FROM sso_links WHERE email = ? OR (provider = ? AND subject = ?)', st.email, p, who.subject);
    await q.run('INSERT INTO sso_links(provider, subject, email, tenant, label, creds, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)',
      p, who.subject, st.email, who.tenant, who.label, seal({ password: st.password }), Date.now());
    await audit(st.email, org.id, 'sso.linked', { provider: p, account: who.label });
    return back('linked');
  }

  // Signing in
  const link = await q.get('SELECT * FROM sso_links WHERE provider = ? AND subject = ?', p, who.subject);
  if (!link) return toLogin('not-linked');
  if (await loginBlocked(link.email, req.ip)) return toLogin('blocked');
  const org = await orgFor(link.email);
  if (!org || org.sso_provider !== p || org.sso_tenant !== link.tenant || who.tenant !== link.tenant) {
    await q.run('DELETE FROM sso_links WHERE email = ?', link.email);
    return toLogin('not-linked');
  }
  const password = unseal(link.creds)?.password;
  if (!password || !(await checkMailPassword(link.email, password))) {
    await q.run('DELETE FROM sso_links WHERE email = ?', link.email); // password changed elsewhere (e.g. by an admin)
    await loginFailed(link.email, req.ip);
    await logEvent(req, link.email, false, p);
    return toLogin('password-changed');
  }
  await q.run('UPDATE sso_links SET last_used = ?, label = ? WHERE provider = ? AND subject = ?', Date.now(), who.label || link.label, p, who.subject);
  const { redirect } = await finishLoginSession(req, res, { email: link.email, password, remember: !!st.remember, how: p });
  res.redirect(302, redirect);
}));

async function dropOrgLinks(orgId) {
  for (const d of await q.all('SELECT domain FROM domains WHERE org_id = ?', orgId)) await q.run('DELETE FROM sso_links WHERE email LIKE ?', `%@${d.domain}`);
}

// ---------------------------------------------------------------- signed in
export const ssoApi = express.Router();
ssoApi.use('/sso', requireAuth);

// What the person sees in Settings → Security
ssoApi.get('/sso/me', wrap(async (req, res) => {
  const org = await orgFor(req.user.email);
  const link = await q.get('SELECT provider, label, created_at, last_used FROM sso_links WHERE email = ?', req.user.email);
  const p = org?.sso_provider && enabled(org.sso_provider) ? org.sso_provider : null;
  res.json({ provider: p, providerName: p ? PROVIDERS[p].name : null, company: org?.name || null,
    linked: link && link.provider === p ? { account: link.label, created: link.created_at, lastUsed: link.last_used } : null });
}));

ssoApi.post('/sso/link', rateLimit({ windowMs: 3600e3, limit: 20 }), wrap(async (req, res) => {
  if (req.delegatedMailbox) throw fail(403, 'Link your own mailbox');
  const org = await orgFor(req.user.email);
  if (!org?.sso_provider || !enabled(org.sso_provider)) throw fail(400, 'Your company hasn’t turned on Microsoft or Google sign-in.');
  const password = String(req.body.password || '');
  if (!(await checkMailPassword(req.user.email, password))) throw fail(401, 'Wrong password');
  res.json({ url: authUrl(req, res, org.sso_provider, 'link', { email: req.user.email, password }) });
}));

ssoApi.delete('/sso/link', wrap(async (req, res) => {
  await q.run('DELETE FROM sso_links WHERE email = ?', req.user.email);
  await audit(req.user.email, null, 'sso.unlinked');
  res.json({ ok: true });
}));

// Business admins: connect (or disconnect) the company's Microsoft 365 or Google Workspace
ssoApi.get('/sso/org/:orgId', wrap(async (req, res) => {
  const o = await requireOrgAdmin(req, req.params.orgId);
  const domains = (await q.all('SELECT domain FROM domains WHERE org_id = ?', o.id)).map((d) => d.domain);
  let linked = 0;
  for (const d of domains) linked += Number((await q.get('SELECT COUNT(*) AS n FROM sso_links WHERE email LIKE ?', `%@${d}`))?.n || 0);
  res.json({ available: { microsoft: enabled('microsoft'), google: enabled('google') }, provider: o.sso_provider || null, tenant: o.sso_tenant || null, linked });
}));

ssoApi.post('/sso/org/:orgId/connect', wrap(async (req, res) => {
  const o = await requireOrgAdmin(req, req.params.orgId);
  const p = String(req.body.provider || '');
  pick(p);
  res.json({ url: authUrl(req, res, p, 'org', { email: req.user.email, orgId: o.id }) });
}));

ssoApi.delete('/sso/org/:orgId', wrap(async (req, res) => {
  const o = await requireOrgAdmin(req, req.params.orgId);
  await q.run('UPDATE orgs SET sso_provider = NULL, sso_tenant = NULL WHERE id = ?', o.id);
  await dropOrgLinks(o.id);
  await audit(req.user.email, o.id, 'sso.disconnected');
  res.json({ ok: true });
}));

// Password changed or "sign out everywhere": the stored password is wrong or must not be used any more
onRevoke((email) => { q.run('DELETE FROM sso_links WHERE email = ?', email).catch(() => {}); });
