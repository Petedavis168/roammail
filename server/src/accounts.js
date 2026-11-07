import { applySendingRoute } from './outbound.js';
// Free sign-up, business domains, and the admin / super-admin portals.
import express from 'express';
import crypto from 'node:crypto';
import { rateLimit } from './shared.js';
import { config } from './config.js';
import { q, rolesFor, audit, setting, setSetting } from './db.js';
import { mailcow } from './mailcow.js';
import { setSession, requireAuth, revokeSessions } from './session.js';
import { verifyRecord, requiredRecords, checkVerification, checkRecords } from './dns.js';
import { findZone, applyRecords } from './route53.js';
import { saveProfile, getProfile, deleteUserData } from './signatures.js';
import { setRecoveryEmail } from './security.js';
import { deliverWelcome } from './welcome.js';
import { createSetupLink } from './devicesetup.js';
import { applyDomainSpamDefaults } from './spam.js';
import { assertNotBreached, topSenders } from './abuse.js';
import { resetTwoFactor } from './recovery.js';
import { syncOrgGroups } from './groups.js';
import { needsPaymentToActivate, seatCheck, shrinkSeats, onPaid, startBillingChecks, orgBilling } from './billing.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status });

const RESERVED = new Set(['admin', 'administrator', 'root', 'postmaster', 'abuse', 'hostmaster', 'webmaster', 'security',
  'support', 'info', 'noreply', 'no-reply', 'mailer-daemon', 'billing', 'help', 'sales', 'contact', 'system', 'test']);
// Big providers nobody should be able to claim.
const BLOCKED_DOMAINS = /(^|\.)(gmail|googlemail|google|outlook|hotmail|live|msn|microsoft|yahoo|icloud|me|mac|aol|proton|protonmail|yandex|gmx|zoho|amazon|apple)\.[a-z.]+$/;
const LOCAL_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const DOMAIN_RE = /^(?=.{4,253}$)(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/;

function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10) throw fail(400, 'Password must be at least 10 characters');
  if (!/[a-z]/i.test(pw) || !/[0-9]/.test(pw)) throw fail(400, 'Password must contain letters and numbers');
}
function checkLocal(local) {
  if (!LOCAL_RE.test(local) || /\.\.|^[._-]|[._-]$/.test(local)) throw fail(400, 'Usernames can use letters, numbers, dots, dashes and underscores');
}

// =================================================================== public
export const publicAccounts = express.Router();

publicAccounts.get('/signup/config', async (req, res) => res.json({
  enabled: config.signup.enabled && await setting('signupEnabled', true) && !!config.signup.domain,
  domain: config.signup.domain,
  turnstileSiteKey: config.turnstile.siteKey || null,
}));

async function checkCaptcha(token, ip) {
  if (!config.turnstile.secret) return;
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST', body: new URLSearchParams({ secret: config.turnstile.secret, response: String(token || ''), remoteip: ip }),
  }).then((x) => x.json()).catch(() => ({ success: false }));
  if (!r.success) throw fail(400, 'Please complete the "I am human" check');
}

/** Is local@SIGNUP_DOMAIN free? Checks mailboxes, aliases/groups, and addresses of deleted accounts (never reused). */
async function addressAvailable(local) {
  if (!LOCAL_RE.test(local) || RESERVED.has(local) || local.length < 3) return false;
  const email = `${local}@${config.signup.domain}`;
  if (await q.get('SELECT 1 FROM signups WHERE email = ?', email)) return false;
  if (await q.get('SELECT 1 FROM groups WHERE address = ?', email)) return false;
  if (await mailcow.getMailbox(email)) return false;
  if ((await aliasesCached()).has(email)) return false;
  return true;
}
let aliasCache = { at: 0, set: new Set() };
async function aliasesCached() {
  if (Date.now() - aliasCache.at > 60_000) {
    aliasCache = { at: Date.now(), set: new Set((await mailcow.listAliases(config.signup.domain).catch(() => [])).map((a) => a.address.toLowerCase())) };
  }
  return aliasCache.set;
}
const usernameHint = (local) => (local.length < 3 ? 'Use at least 3 characters' : !LOCAL_RE.test(local) ? 'Use only letters, numbers, dots, dashes and underscores' : RESERVED.has(local) ? 'That name is reserved' : null);

publicAccounts.get('/signup/check', rateLimit({ windowMs: 60_000, limit: 60 }), wrap(async (req, res) => {
  const local = String(req.query.username || '').toLowerCase().trim();
  const hint = usernameHint(local);
  if (hint) return res.json({ available: false, reason: hint });
  res.json({ available: await addressAvailable(local) });
}));

// Gmail-style suggestions from the person's name
publicAccounts.get('/signup/suggest', rateLimit({ windowMs: 60_000, limit: 30 }), wrap(async (req, res) => {
  const norm = (s) => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
  const f = norm(req.query.first); const l = norm(req.query.last);
  const year = new Date().getFullYear();
  const ideas = [...new Set([f && l && `${f}.${l}`, f && l && `${f}${l}`, f && l && `${f[0]}${l}`, f && l && `${f}.${l[0]}`, f && l && `${f}${l}${year % 100}`,
    f && `${f}${l ? `.${l}` : ''}${Math.floor(10 + Math.random() * 89)}`, f && l && `${l}.${f}`, f && `${f}${year}`].filter(Boolean))];
  const out = [];
  for (const i of ideas) { if (out.length >= 3) break; if (await addressAvailable(i)) out.push(i); }
  res.json({ domain: config.signup.domain, suggestions: out });
}));

publicAccounts.post('/signup', rateLimit({ windowMs: 60 * 60_000, limit: 10 }), wrap(async (req, res) => {
  if (!config.signup.enabled || !await setting('signupEnabled', true) || !config.signup.domain) throw fail(403, 'Sign-ups are currently closed');
  const local = String(req.body.username || '').trim().toLowerCase();
  const name = String(req.body.name || '').trim().slice(0, 100);
  const password = String(req.body.password || '');
  checkLocal(local);
  if (RESERVED.has(local)) throw fail(400, 'That username is reserved');
  if (local.length < 3) throw fail(400, 'Use at least 3 characters for your address');
  if (!name) throw fail(400, 'Please enter your name');
  checkPassword(password);
  const today = (await q.get("SELECT COUNT(*) AS n FROM signups WHERE ip = ? AND created_at > datetime('now', '-1 day')", req.ip)).n;
  if (today >= config.signup.perIpPerDay) throw fail(429, 'Too many accounts created from your network today');
  if (req.body.acceptTerms !== true) throw fail(400, 'Please accept the Terms of Service and Privacy Policy');
  const lastHour = (await q.get("SELECT COUNT(*) AS n FROM signups WHERE created_at > datetime('now', '-1 hour')")).n;
  if (lastHour >= config.limits.signupsPerHour) throw fail(429, 'Sign-ups are very busy right now. Please try again in a little while.');
  await assertNotBreached(password, `${local}@x`);
  await checkCaptcha(req.body.captcha, req.ip);

  const email = `${local}@${config.signup.domain}`;
  if (!(await addressAvailable(local))) throw fail(409, 'That address is taken. Try one of the suggestions.');
  await mailcow.addMailbox({ localPart: local, domain: config.signup.domain, name, password, quotaMb: config.signup.quotaMb });
  const rl = /^(\d+)\/([smhd])$/.exec(config.signup.rateLimit);
  if (rl) await mailcow.setMailboxRateLimit(email, rl[1], rl[2]).catch((e) => console.warn('rate limit not set:', e.message));
  await q.run('INSERT INTO signups(email, ip, recovery_email, terms_version) VALUES(?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET ip = excluded.ip, recovery_email = excluded.recovery_email, terms_version = excluded.terms_version, created_at = excluded.created_at', email, req.ip, String(req.body.recoveryEmail || '').slice(0, 200) || null, config.legal.termsVersion);
  await audit(email, null, 'signup', { ip: req.ip });
  await saveProfile(email, { name });
  await setRecoveryEmail(email, String(req.body.recoveryEmail || '').trim());
  deliverWelcome({ email, password, name }).catch(() => {});
  await setSession(res, { email, password, name }, req);
  res.json({ email });
}));

// =================================================================== helpers
async function orgOf(domain) {
  return await q.get('SELECT d.*, o.name AS org_name, o.suspended, o.max_mailboxes FROM domains d JOIN orgs o ON o.id = d.org_id WHERE d.domain = ?', domain);
}
async function isOrgAdmin(user, orgId) {
  const r = await rolesFor(user.email);
  return r.superAdmin || r.orgs.some((o) => o.id === orgId && o.role === 'admin');
}
async function requireDomainAdmin(req, domain) {
  const d = await orgOf(String(domain || '').toLowerCase());
  if (!d) throw fail(404, 'Domain not found');
  if (!await isOrgAdmin(req.user, d.org_id)) throw fail(403, 'You are not an admin of this domain');
  if (d.suspended && !(await rolesFor(req.user.email)).superAdmin) throw fail(403, 'This organization is suspended');
  return d;
}
async function requireOrgAdmin(req, orgId) {
  const o = await q.get('SELECT * FROM orgs WHERE id = ?', Number(orgId));
  if (!o) throw fail(404, 'Organization not found');
  if (!await isOrgAdmin(req.user, o.id)) throw fail(403, 'You are not an admin of this organization');
  return o;
}
async function requireSuper(req, res, next) {
  if (!(await rolesFor(req.user.email)).superAdmin) return res.status(403).json({ error: 'Super-admin only' });
  next();
}
async function orgMailboxCount(orgId) {
  let n = 0;
  for (const d of await q.all("SELECT domain FROM domains WHERE org_id = ? AND status = 'active'", orgId)) {
    n += (await mailcow.listMailboxes(d.domain)).length;
  }
  return n;
}

async function activateDomain(d, actor) {
  const existing = await mailcow.getDomain(d.domain);
  if (!existing) {
    await mailcow.addDomain(d.domain, {
      description: `${d.org_name} (managed)`,
      mailboxes: d.max_mailboxes,
      defquota: config.business.defaultQuotaMb,
      maxquota: config.business.maxQuotaMb,
      quota: config.business.totalQuotaMb,
    });
  }
  let dkim = await mailcow.getDkim(d.domain);
  if (!dkim) {
    await mailcow.addDkim(d.domain);
    dkim = await mailcow.getDkim(d.domain);
  }
  await q.run("UPDATE domains SET status = 'active', verified_at = datetime('now'), dkim_txt = ?, dkim_selector = ? WHERE domain = ?",
    dkim?.txt || null, dkim?.selector || null, d.domain);
  await audit(actor, d.org_id, 'domain.activate', { domain: d.domain });
  await applySendingRoute(d.domain).catch((e) => console.error('APP_ERROR sending route', d.domain, e.message));
}

const dkimOf = (d) => (d.dkim_txt ? { txt: d.dkim_txt, selector: d.dkim_selector || 'dkim' } : null);

onPaid(async (orgId) => {
  for (const row of await q.all("SELECT domain FROM domains WHERE org_id = ? AND status = 'verified'", orgId)) {
    await activateDomain(await orgOf(row.domain), 'billing');
  }
});
export async function suspendOrg(orgId) {
  await q.run('UPDATE orgs SET suspended = 1 WHERE id = ?', orgId);
  for (const d of await q.all("SELECT domain FROM domains WHERE org_id = ? AND status = 'active'", orgId)) await mailcow.editDomain(d.domain, { active: 0 });
}
startBillingChecks(suspendOrg);

// =================================================================== domains
export const accounts = express.Router();
accounts.use(requireAuth);

accounts.get('/domains', wrap(async (req, res) => {
  const r = await rolesFor(req.user.email);
  const rows = r.superAdmin
    ? await q.all('SELECT d.domain, d.status, d.org_id, o.name AS org_name, d.created_at FROM domains d JOIN orgs o ON o.id = d.org_id ORDER BY d.created_at DESC')
    : await q.all(`SELECT d.domain, d.status, d.org_id, o.name AS org_name, d.created_at FROM domains d JOIN orgs o ON o.id = d.org_id
             JOIN members m ON m.org_id = o.id AND m.email = ? AND m.role = 'admin' ORDER BY d.created_at DESC`, req.user.email);
  res.json(rows);
}));

// Step 1: claim a domain (creates the organization if needed)
accounts.post('/domains', rateLimit({ windowMs: 60 * 60_000, limit: 20 }), wrap(async (req, res) => {
  const domain = String(req.body.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  if (!DOMAIN_RE.test(domain)) throw fail(400, 'That doesn\'t look like a domain name (e.g. mybusiness.com)');
  if (BLOCKED_DOMAINS.test(domain) || domain === config.signup.domain || domain.endsWith(`.${config.mailHostname}`) || domain === config.mailHostname) {
    throw fail(400, 'That domain can\'t be added');
  }
  if (await q.get('SELECT 1 FROM domains WHERE domain = ?', domain)) throw fail(409, 'That domain is already registered here');
  const pending = (await q.get("SELECT COUNT(*) AS n FROM domains d JOIN orgs o ON o.id = d.org_id WHERE o.owner_email = ? AND d.status = 'pending'", req.user.email)).n;
  if (pending >= 5 && !(await rolesFor(req.user.email)).superAdmin) throw fail(429, 'Finish verifying your other domains first (5 pending at most)');
  const superAdmin = (await rolesFor(req.user.email)).superAdmin;
  if (!superAdmin && (await mailcow.getDomain(domain))) throw fail(409, 'That domain already exists on this mail server');

  let orgId = req.body.orgId ? (await requireOrgAdmin(req, req.body.orgId)).id : null;
  if (!orgId) {
    const name = String(req.body.orgName || domain).trim().slice(0, 120);
    orgId = await q.insert('INSERT INTO orgs(name, owner_email, max_mailboxes) VALUES(?, ?, ?)', name, req.user.email, config.business.maxMailboxes);
    await q.run("INSERT INTO members(email, org_id, role) VALUES(?, ?, 'admin')", req.user.email, orgId);
    await audit(req.user.email, orgId, 'org.create', { name });
  }
  const token = crypto.randomBytes(12).toString('hex');
  await q.run('INSERT INTO domains(domain, org_id, verify_token) VALUES(?, ?, ?)', domain, orgId, token);
  await audit(req.user.email, orgId, 'domain.add', { domain });
  res.json({ domain, orgId, status: 'pending', verify: verifyRecord(domain, token), route53: superAdmin && !!(await findZone(domain)) });
}));

accounts.get('/domains/:domain', wrap(async (req, res) => {
  const d = await requireDomainAdmin(req, req.params.domain);
  const superAdmin = (await rolesFor(req.user.email)).superAdmin;
  const base = { domain: d.domain, orgId: d.org_id, orgName: d.org_name, status: d.status, mailHostname: config.mailHostname };
  const route53 = superAdmin && !!(await findZone(d.domain));
  if (d.status === 'verified') {
    const b = await orgBilling(d.org_id);
    return res.json({ ...base, route53: false, needsPayment: await needsPaymentToActivate(d.org_id), plan: b.plan, records: requiredRecords(d.domain, null) });
  }
  if (d.status === 'pending') {
    return res.json({ ...base, route53, verify: { ...verifyRecord(d.domain, d.verify_token), ok: await checkVerification(d.domain, d.verify_token) }, records: requiredRecords(d.domain, null) });
  }
  const records = await checkRecords(d.domain, dkimOf(d));
  res.json({ ...base, route53, records, ready: records.filter((r) => !r.optional).every((r) => r.ok) });
}));

// Step 2: verify ownership -> domain is created in mailcow with a DKIM key
accounts.post('/domains/:domain/verify', wrap(async (req, res) => {
  const d = await requireDomainAdmin(req, req.params.domain);
  if (d.status === 'active') return res.json({ ok: true, status: 'active' });
  const skip = req.body?.skipVerification && (await rolesFor(req.user.email)).superAdmin;
  if (!skip && !(await checkVerification(d.domain, d.verify_token))) {
    return res.json({ ok: false, error: 'We can\'t see the verification TXT record yet. DNS changes can take a few minutes (sometimes up to an hour) to appear.' });
  }
  if (await needsPaymentToActivate(d.org_id) && !(await rolesFor(req.user.email)).superAdmin) {
    await q.run("UPDATE domains SET status = 'verified', verified_at = datetime('now') WHERE domain = ?", d.domain);
    await audit(req.user.email, d.org_id, 'domain.verified', { domain: d.domain });
    return res.json({ ok: true, status: 'verified', needsPayment: true });
  }
  await activateDomain(d, req.user.email);
  res.json({ ok: true, status: 'active' });
}));

// One click DNS (super-admin, zone hosted in your AWS Route 53)
accounts.post('/domains/:domain/auto-dns', requireSuper, wrap(async (req, res) => {
  const d = await requireDomainAdmin(req, req.params.domain);
  const zone = await findZone(d.domain);
  if (!zone) throw fail(400, 'No public Route 53 hosted zone for this domain in your AWS account');
  // The zone is in your own AWS account, so ownership is proven.
  if (d.status === 'pending') await activateDomain(d, req.user.email);
  const fresh = await orgOf(d.domain);
  await applyRecords(zone, d.domain, requiredRecords(d.domain, dkimOf(fresh)));
  await audit(req.user.email, d.org_id, 'domain.route53', { domain: d.domain, zone });
  res.json({ ok: true });
}));

accounts.delete('/domains/:domain', wrap(async (req, res) => {
  const d = await requireDomainAdmin(req, req.params.domain);
  if (d.status === 'active') {
    const boxes = await mailcow.listMailboxes(d.domain);
    if (boxes.length) throw fail(400, `Delete the ${boxes.length} user(s) on this domain first`);
    for (const a of await mailcow.listAliases(d.domain)) await mailcow.deleteAlias(a.id);
    if (await mailcow.getDomain(d.domain)) await mailcow.deleteDomain(d.domain);
  }
  await q.run('DELETE FROM domains WHERE domain = ?', d.domain);
  await audit(req.user.email, d.org_id, 'domain.delete', { domain: d.domain });
  res.json({ ok: true });
}));

// =================================================================== org admin portal
accounts.get('/admin/orgs', wrap(async (req, res) => {
  const r = await rolesFor(req.user.email);
  const orgs = r.superAdmin
    ? await q.all('SELECT * FROM orgs ORDER BY created_at DESC')
    : await q.all("SELECT o.* FROM orgs o JOIN members m ON m.org_id = o.id WHERE m.email = ? AND m.role = 'admin'", req.user.email);
  res.json(await Promise.all(orgs.map(async (o) => ({ ...o, domains: await q.all('SELECT domain, status FROM domains WHERE org_id = ?', o.id) }))));
}));

accounts.get('/admin/orgs/:id', wrap(async (req, res) => {
  const o = await requireOrgAdmin(req, req.params.id);
  const domains = await q.all('SELECT domain, status, created_at, verified_at FROM domains WHERE org_id = ?', o.id);
  const admins = (await q.all("SELECT email FROM members WHERE org_id = ? AND role = 'admin'", o.id)).map((m) => m.email);
  res.json({ ...o, domains, admins });
}));

accounts.patch('/admin/orgs/:id', wrap(async (req, res) => {
  const o = await requireOrgAdmin(req, req.params.id);
  if (req.body.name) await q.run('UPDATE orgs SET name = ? WHERE id = ?', String(req.body.name).slice(0, 120), o.id);
  if (req.body.require2fa !== undefined) await q.run('UPDATE orgs SET require_2fa = ? WHERE id = ?', req.body.require2fa ? 1 : 0, o.id);
  if (req.body.allowExternalForward !== undefined) await q.run('UPDATE orgs SET allow_external_forward = ? WHERE id = ?', req.body.allowExternalForward ? 1 : 0, o.id);
  await audit(req.user.email, o.id, 'org.update', { name: req.body.name, require2fa: req.body.require2fa, allowExternalForward: req.body.allowExternalForward });
  res.json({ ok: true });
}));

accounts.get('/admin/orgs/:id/audit', wrap(async (req, res) => {
  const o = await requireOrgAdmin(req, req.params.id);
  res.json((await q.all('SELECT actor, action, detail, at FROM audit WHERE org_id = ? ORDER BY id DESC LIMIT 200', o.id))
    .map((a) => ({ ...a, detail: JSON.parse(a.detail || '{}') })));
}));

accounts.get('/admin/users', wrap(async (req, res) => {
  const d = await requireDomainAdmin(req, req.query.domain);
  if (d.status !== 'active') return res.json([]);
  const admins = new Set((await q.all("SELECT email FROM members WHERE org_id = ? AND role = 'admin'", d.org_id)).map((m) => m.email));
  res.json(await Promise.all((await mailcow.listMailboxes(d.domain)).map(async (m) => {
    const p = await getProfile(m.email);
    const tf = await q.get('SELECT totp_enabled FROM user_security WHERE email = ?', m.email.toLowerCase());
    return { ...m, admin: admins.has(m.email.toLowerCase()), twoFactor: !!tf?.totp_enabled, title: p.title || '', department: p.department || '', phone: p.phone || '', mobile: p.mobile || '' };
  })));
}));

accounts.post('/admin/users', wrap(async (req, res) => {
  const d = await requireDomainAdmin(req, req.body.domain);
  if (d.status !== 'active') throw fail(400, 'Verify the domain before adding users');
  const local = String(req.body.localPart || '').trim().toLowerCase();
  checkLocal(local);
  checkPassword(req.body.password);
  await assertNotBreached(req.body.password, `${local}@x`);
  if ((await orgMailboxCount(d.org_id)) >= d.max_mailboxes) throw fail(400, `Your plan allows ${d.max_mailboxes} users`);
  const seat = await seatCheck(d.org_id);
  if (!seat.ok) {
    return res.status(402).json({ error: seat.hasSubscription ? 'Adding this person needs one more paid user.' : 'Choose a plan to add this person.',
      code: seat.hasSubscription ? 'seat_required' : 'checkout_required', perUser: seat.perUser, interval: seat.interval, orgId: d.org_id });
  }
  const quotaMb = Math.max(256, Math.min(Number(req.body.quotaMb) || config.business.defaultQuotaMb, config.business.maxQuotaMb));
  const email = `${local}@${d.domain}`;
  await mailcow.addMailbox({ localPart: local, domain: d.domain, name: String(req.body.name || '').slice(0, 100), password: req.body.password, quotaMb });
  await q.run('INSERT INTO members(email, org_id, role) VALUES(?, ?, ?) ON CONFLICT(email, org_id) DO UPDATE SET role = excluded.role', email, d.org_id, req.body.admin ? 'admin' : 'user');
  await saveProfile(email, { name: req.body.name || '', title: req.body.title, department: req.body.department, phone: req.body.phone, mobile: req.body.mobile });
  if (req.body.welcome !== false) deliverWelcome({ email, password: req.body.password, name: req.body.name, company: d.org_name }).catch(() => {});
  await audit(req.user.email, d.org_id, 'user.create', { email, admin: !!req.body.admin });
  applyDomainSpamDefaults(email).catch(() => {});
  syncOrgGroups(d.org_id).catch(() => {});
  // QR code the admin can show the new hire: scan → phone set up, password included (single use, 2 hours)
  const setup = await createSetupLink(req, email, req.body.password, 120);
  res.json({ ok: true, email, setup });
}));

accounts.patch('/admin/users', wrap(async (req, res) => {
  const email = String(req.body.email || '').toLowerCase();
  const d = await requireDomainAdmin(req, email.split('@')[1]);
  const attr = {};
  if (req.body.name !== undefined) attr.name = String(req.body.name).slice(0, 100);
  if (req.body.password) { checkPassword(req.body.password); attr.password = req.body.password; attr.password2 = req.body.password; }
  if (req.body.quotaMb !== undefined) attr.quota = Math.max(256, Math.min(Number(req.body.quotaMb) || config.business.defaultQuotaMb, config.business.maxQuotaMb));
  if (req.body.active !== undefined) {
    if (email === req.user.email && !req.body.active) throw fail(400, 'You can\'t suspend yourself');
    attr.active = req.body.active ? 1 : 0;
  }
  if (Object.keys(attr).length) await mailcow.editMailbox(email, attr);
  if (req.body.reset2fa === true) {
    if (email === req.user.email) throw fail(400, 'Turn your own 2-step verification off in Settings → Security');
    await resetTwoFactor(email, req.user.email, 'reset by organization admin');
  }
  const prof = {};
  for (const k of ['name', 'title', 'department', 'phone', 'mobile']) if (req.body[k] !== undefined) prof[k] = req.body[k];
  if (Object.keys(prof).length) await saveProfile(email, prof);
  if (attr.password || attr.active === 0) await revokeSessions(email); // password reset or suspension signs the user out everywhere
  if (prof.department !== undefined || attr.active !== undefined || prof.name !== undefined) syncOrgGroups(d.org_id).catch(() => {});
  if (req.body.admin !== undefined) {
    if (email === req.user.email && !req.body.admin) throw fail(400, 'You can\'t remove your own admin rights');
    await q.run('INSERT INTO members(email, org_id, role) VALUES(?, ?, ?) ON CONFLICT(email, org_id) DO UPDATE SET role = excluded.role', email, d.org_id, req.body.admin ? 'admin' : 'user');
  }
  await audit(req.user.email, d.org_id, 'user.update', { email, fields: Object.keys(req.body).filter((k) => k !== 'password' && k !== 'email'), passwordReset: !!req.body.password });
  res.json({ ok: true });
}));

accounts.delete('/admin/users', wrap(async (req, res) => {
  const email = String(req.query.email || '').toLowerCase();
  const d = await requireDomainAdmin(req, email.split('@')[1]);
  if (email === req.user.email) throw fail(400, 'You can\'t delete your own account here');
  const o = await q.get('SELECT owner_email FROM orgs WHERE id = ?', d.org_id);
  if (o.owner_email === email) throw fail(400, 'The organization owner can\'t be deleted');
  await mailcow.deleteMailbox(email);
  await q.run('DELETE FROM members WHERE email = ? AND org_id = ?', email, d.org_id);
  await deleteUserData(email);
  await revokeSessions(email);
  shrinkSeats(d.org_id).catch(() => {});
  syncOrgGroups(d.org_id).catch(() => {});
  // remove the person from static groups too
  for (const g of await q.all("SELECT * FROM groups WHERE org_id = ? AND kind = 'static'", d.org_id)) {
    const m = JSON.parse(g.members || '[]');
    if (m.includes(email)) await q.run('UPDATE groups SET members = ? WHERE id = ?', JSON.stringify(m.filter((x) => x !== email)), g.id);
  }
  await audit(req.user.email, d.org_id, 'user.delete', { email });
  res.json({ ok: true });
}));

accounts.get('/admin/aliases', wrap(async (req, res) => {
  const d = await requireDomainAdmin(req, req.query.domain);
  const groupAddrs = new Set((await q.all('SELECT address FROM groups WHERE org_id = ?', d.org_id)).map((g) => g.address));
  res.json(d.status === 'active' ? (await mailcow.listAliases(d.domain)).filter((a) => !groupAddrs.has(a.address.toLowerCase())) : []);
}));

accounts.post('/admin/aliases', wrap(async (req, res) => {
  const address = String(req.body.address || '').trim().toLowerCase();
  const d = await requireDomainAdmin(req, address.split('@')[1]);
  const goto = String(req.body.goto || '').split(/[\s,;]+/).filter(Boolean);
  if (!goto.length || !goto.every((g) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(g))) throw fail(400, 'Enter at least one valid destination address');
  await mailcow.addAlias(address, goto.join(','));
  await audit(req.user.email, d.org_id, 'alias.create', { address, goto });
  res.json({ ok: true });
}));

accounts.delete('/admin/aliases', wrap(async (req, res) => {
  const d = await requireDomainAdmin(req, req.query.domain);
  const alias = (await mailcow.listAliases(d.domain)).find((a) => String(a.id) === String(req.query.id));
  if (!alias) throw fail(404, 'Alias not found');
  await mailcow.deleteAlias(alias.id);
  await audit(req.user.email, d.org_id, 'alias.delete', { address: alias.address });
  res.json({ ok: true });
}));

// =================================================================== super admin
accounts.get('/super/overview', requireSuper, wrap(async (req, res) => {
  res.json({
    settings: { signupEnabled: await setting('signupEnabled', true), signupDomain: config.signup.domain, route53: config.route53Enabled, mailHostname: config.mailHostname },
    counts: {
      orgs: (await q.get('SELECT COUNT(*) AS n FROM orgs')).n,
      domains: (await q.get("SELECT COUNT(*) AS n FROM domains WHERE status = 'active'")).n,
      pendingDomains: (await q.get("SELECT COUNT(*) AS n FROM domains WHERE status = 'pending'")).n,
      signups: (await q.get('SELECT COUNT(*) AS n FROM signups')).n,
      signupsToday: (await q.get("SELECT COUNT(*) AS n FROM signups WHERE created_at > datetime('now', '-1 day')")).n,
    },
    recentSignups: await q.all('SELECT email, ip, created_at FROM signups ORDER BY created_at DESC LIMIT 50'),
    topSenders: await topSenders(),
    recentActivity: (await q.all('SELECT actor, org_id, action, detail, at FROM audit ORDER BY id DESC LIMIT 50')).map((a) => ({ ...a, detail: JSON.parse(a.detail || '{}') })),
  });
}));

accounts.patch('/super/settings', requireSuper, wrap(async (req, res) => {
  if (req.body.signupEnabled !== undefined) await setSetting('signupEnabled', !!req.body.signupEnabled);
  await audit(req.user.email, null, 'settings.update', req.body);
  res.json({ ok: true });
}));

accounts.patch('/super/orgs/:id', requireSuper, wrap(async (req, res) => {
  const o = await requireOrgAdmin(req, req.params.id);
  if (req.body.maxMailboxes !== undefined) {
    const n = Math.max(1, Number(req.body.maxMailboxes));
    await q.run('UPDATE orgs SET max_mailboxes = ? WHERE id = ?', n, o.id);
    for (const d of await q.all("SELECT domain FROM domains WHERE org_id = ? AND status = 'active'", o.id)) await mailcow.editDomain(d.domain, { mailboxes: n });
  }
  if (req.body.suspended !== undefined) {
    const s = req.body.suspended ? 1 : 0;
    await q.run('UPDATE orgs SET suspended = ? WHERE id = ?', s, o.id);
    for (const d of await q.all("SELECT domain FROM domains WHERE org_id = ? AND status = 'active'", o.id)) await mailcow.editDomain(d.domain, { active: s ? 0 : 1 });
  }
  await audit(req.user.email, o.id, 'org.super_update', req.body);
  res.json({ ok: true });
}));

accounts.post('/super/signups/suspend', requireSuper, wrap(async (req, res) => {
  const email = String(req.body.email || '').toLowerCase();
  await mailcow.editMailbox(email, { active: req.body.active ? 1 : 0 });
  if (!req.body.active) await revokeSessions(email);
  await audit(req.user.email, null, req.body.active ? 'signup.unsuspend' : 'signup.suspend', { email });
  res.json({ ok: true });
}));
