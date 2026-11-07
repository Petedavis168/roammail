import { markChosen, markTemporary, setupState } from './setup.js';
import { renameMailboxId, ensureMailboxId, inboxUrl } from './mailboxids.js';
import { syncArchive } from './archive.js';
import { applySendingRoute, applyRate, RAMP, BUSINESS_RATE } from './outbound.js';
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
import { tempPassword } from './temppass.js';
import { isBareFirstName, FIRST_NAME_HINT } from './names.js';
import { phoneRequired, requireVerifiedPhone } from './phone.js';
import { sendSystemMail } from './recovery.js';
import { needsPaymentToActivate, seatCheck, shrinkSeats, onPaid, startBillingChecks, orgBilling, setSeats } from './billing.js';

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
  // where sign-in and the app live (the web app uses these to build links)
  rootDomain: config.rootDomain || null, loginHost: config.loginHost || null,
  // mailbox sizes (config values, in MB)
  quota: { free: config.signup.quotaMb, business: config.business.defaultQuotaMb, businessMax: config.business.maxQuotaMb },
  phoneRequired: phoneRequired(), // 5b: free sign-ups verify a mobile number by SMS
}));

async function checkCaptcha(token, ip) {
  if (!config.turnstile.secret) return;
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST', body: new URLSearchParams({ secret: config.turnstile.secret, response: String(token || ''), remoteip: ip }),
  }).then((x) => x.json()).catch(() => ({ success: false }));
  if (!r.success) throw fail(400, 'Please complete the "I am human" check');
}

/** Is local@SIGNUP_DOMAIN free? Checks mailboxes, aliases/groups, and addresses of deleted accounts (never reused). */
async function addressAvailable(local, { staff = false } = {}) {
  if (!LOCAL_RE.test(local) || RESERVED.has(local) || local.length < 3) return false;
  if (!staff && isBareFirstName(local)) return false;
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
const usernameHint = (local) => (local.length < 3 ? 'Use at least 3 characters' : !LOCAL_RE.test(local) ? 'Use only letters, numbers, dots, dashes and underscores' : RESERVED.has(local) ? 'That name is reserved' : isBareFirstName(local) ? FIRST_NAME_HINT : null);

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
  if (isBareFirstName(local)) throw fail(400, FIRST_NAME_HINT);
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
  const phoneHash = await requireVerifiedPhone(req.body.phoneToken);

  const email = `${local}@${config.signup.domain}`;
  if (!(await addressAvailable(local))) throw fail(409, 'That address is taken. Try one of the suggestions.');
  await mailcow.addMailbox({ localPart: local, domain: config.signup.domain, name, password, quotaMb: config.signup.quotaMb });
  await markChosen(`${local}@${config.signup.domain}`);
  // Send ramp (5a): new free accounts start at 25/h; the daily job raises it as the account ages
  if (config.signup.rateLimit) await applyRate(email, RAMP[0]).catch((e) => console.warn('rate limit not set:', e.message));
  await q.run('INSERT INTO signups(email, ip, recovery_email, terms_version, phone_hash) VALUES(?, ?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET ip = excluded.ip, recovery_email = excluded.recovery_email, terms_version = excluded.terms_version, created_at = excluded.created_at, phone_hash = excluded.phone_hash', email, req.ip, String(req.body.recoveryEmail || '').slice(0, 200) || null, config.legal.termsVersion, phoneHash);
  await audit(email, null, 'signup', { ip: req.ip, phoneVerified: !!phoneHash });
  await saveProfile(email, { name });
  await setRecoveryEmail(email, String(req.body.recoveryEmail || '').trim());
  deliverWelcome({ email, password, name }).catch(() => {});
  await setSession(res, { email, password, name }, req);
  const mailboxId = await ensureMailboxId(email, { name });
  res.json({ email, mailboxId, redirect: inboxUrl(mailboxId), setupRequired: (await setupState(email)).setupRequired });
}));

// =================================================================== helpers
async function orgOf(domain) {
  return await q.get('SELECT d.*, o.name AS org_name, o.suspended, o.max_mailboxes FROM domains d JOIN orgs o ON o.id = d.org_id WHERE d.domain = ?', domain);
}
async function isOrgAdmin(user, orgId) {
  const r = await rolesFor(user.email);
  return r.superAdmin || r.orgs.some((o) => o.id === orgId && o.role === 'admin');
}
export async function requireDomainAdmin(req, domain) {
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
  await syncArchive(d.org_id).catch((e) => console.error('APP_ERROR archive sync', d.domain, e.message));
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
  // 5i: "Sending: Direct / Trusted relay" comes from the mailcow domain's relayhost (set on the server by fwd-relay-sync)
  const mc = await mailcow.getDomain(d.domain).catch(() => null);
  const relay = !!(mc && Number(mc.relayhost || 0) > 0);
  const records = await checkRecords(d.domain, dkimOf(d), { relay });
  res.json({ ...base, route53, records, sending: relay ? 'relay' : 'direct', ready: records.filter((r) => !r.optional).every((r) => r.ok) });
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
  const shared = new Set((await q.all('SELECT email FROM shared_mailboxes WHERE org_id = ?', d.org_id)).map((r) => r.email));
  res.json(await Promise.all((await mailcow.listMailboxes(d.domain)).filter((m) => !shared.has(m.email.toLowerCase())).map(async (m) => {
    const p = await getProfile(m.email);
    const tf = await q.get('SELECT totp_enabled FROM user_security WHERE email = ?', m.email.toLowerCase());
    return { ...m, admin: admins.has(m.email.toLowerCase()), twoFactor: !!tf?.totp_enabled, title: p.title || '', department: p.department || '', phone: p.phone || '', mobile: p.mobile || '' };
  })));
}));

/** Create one mailbox in a business (no seat check: callers do that). */
async function createUser(req, d, body) {
  const local = String(body.localPart || '').trim().toLowerCase();
  checkLocal(local);
  checkPassword(body.password);
  await assertNotBreached(body.password, `${local}@x`);
  const quotaMb = Math.max(256, Math.min(Number(body.quotaMb) || config.business.defaultQuotaMb, config.business.maxQuotaMb));
  const email = `${local}@${d.domain}`;
  await mailcow.addMailbox({ localPart: local, domain: d.domain, name: String(body.name || '').slice(0, 100), password: body.password, quotaMb });
  await applyRate(`${local}@${d.domain}`, BUSINESS_RATE).catch((e) => console.warn('rate limit not set:', e.message)); // business: 100/h
  await markTemporary(`${local}@${d.domain}`, body.inviteEmail ? 'invite' : 'admin');
  await q.run('INSERT INTO members(email, org_id, role) VALUES(?, ?, ?) ON CONFLICT(email, org_id) DO UPDATE SET role = excluded.role', email, d.org_id, body.admin ? 'admin' : 'user');
  await saveProfile(email, { name: body.name || '', title: body.title, department: body.department, phone: body.phone, mobile: body.mobile });
  if (body.welcome !== false) deliverWelcome({ email, password: body.password, name: body.name, company: d.org_name }).catch(() => {});
  await audit(req.user.email, d.org_id, 'user.create', { email, admin: !!body.admin, bulk: !!body.bulk });
  applyDomainSpamDefaults(email).catch(() => {});
  if (body.inviteEmail) await sendInvite(req, d, email, body.name, body.inviteEmail);
  return email;
}

// ---------------------------------------------------------------- invitations
// The invite email never contains a password: it has a one-time link (7 days) where the person chooses their own.
const INVITE_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/;
const escH = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function sendInvite(req, d, email, name, to) {
  const target = String(to).trim().toLowerCase();
  if (!INVITE_RE.test(target)) throw fail(400, 'Enter a valid personal email address for the invite');
  if (target === email) throw fail(400, 'Send the invite to an address they can already read (not the new mailbox)');
  const token = crypto.randomBytes(24).toString('base64url');
  await q.run("DELETE FROM password_resets WHERE email = ? AND kind = 'invite'", email);
  await q.run("INSERT INTO password_resets(token_hash, email, expires, kind, invite_to) VALUES(?, ?, ?, 'invite', ?)",
    crypto.createHash('sha256').update(token).digest('hex'), email, Date.now() + 7 * 864e5, target);
  const link = config.loginHost ? `https://${config.loginHost}/?reset=${token}` : `${config.publicUrl || `${req.protocol}://${req.get('host')}`}/login?reset=${token}`;
  const { sendSystemMail } = await import('./recovery.js');
  const sent = await sendSystemMail(target, `${req.user.name || req.user.email} invited you to ${config.appName}`, `<div style="font-family:Arial,sans-serif;font-size:15px;color:#172C40;max-width:560px">
<h2 style="font-family:Georgia,serif;color:#172C40">You're invited to ${escH(d.org_name || config.appName)} email</h2>
<p>Hi${name ? ` ${escH(String(name).split(' ')[0])}` : ''}, your new email address is ready:</p>
<p style="font-size:18px"><b>${escH(email)}</b></p>
<p><a href="${escH(link)}" style="display:inline-block;background:#172C40;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none">Choose your password and open your inbox</a></p>
<p style="color:#52657A;font-size:13px">This link works once and expires in 7 days. If you weren't expecting this, you can ignore it.<br>${escH(config.appName)} · Your business. Delivered. · Powered by Friendly Web Services</p></div>`).catch(() => false);
  await audit(req.user.email, d.org_id, 'user.invite', { email, to: target, sent: !!sent });
  if (!sent) throw fail(502, 'The mailbox was created, but the invite email could not be sent. Use "Resend invite" or give them the password.');
}

accounts.post('/admin/users/invite', rateLimit({ windowMs: 3600e3, limit: 60 }), wrap(async (req, res) => {
  const email = String(req.body.email || '').toLowerCase();
  const d = await requireDomainAdmin(req, email.split('@')[1]);
  if (!(await mailcow.getMailbox(email))) throw fail(404, 'No such mailbox');
  await sendInvite(req, d, email, req.body.name, req.body.inviteEmail);
  res.json({ ok: true });
}));

accounts.post('/admin/users', wrap(async (req, res) => {
  const d = await requireDomainAdmin(req, req.body.domain);
  if (d.status !== 'active') throw fail(400, 'Verify the domain before adding users');
  if ((await orgMailboxCount(d.org_id)) >= d.max_mailboxes) throw fail(400, `Your plan allows ${d.max_mailboxes} users`);
  checkLocal(String(req.body.localPart || '').trim().toLowerCase());
  // Inviting by email: nobody needs to know the starting password (the person sets their own from the invite link)
  const inviting = !!String(req.body.inviteEmail || '').trim();
  if (inviting && !req.body.password) req.body.password = `${crypto.randomBytes(18).toString('base64url')}!a1`;
  checkPassword(req.body.password);
  const seat = await seatCheck(d.org_id);
  if (!seat.ok) {
    return res.status(402).json({ error: seat.hasSubscription ? 'Adding this person needs one more paid user.' : 'Choose a plan to add this person.',
      code: seat.hasSubscription ? 'seat_required' : 'checkout_required', perUser: seat.perUser, interval: seat.interval, orgId: d.org_id });
  }
  const email = await createUser(req, d, { ...req.body, welcome: inviting ? false : req.body.welcome });
  syncOrgGroups(d.org_id).catch(() => {});
  if (inviting) return res.json({ ok: true, email, invited: String(req.body.inviteEmail).trim().toLowerCase() });
  // QR code the admin can show the new hire: scan → phone set up, password included (single use, 2 hours)
  const setup = await createSetupLink(req, email, req.body.password, 120);
  res.json({ ok: true, email, setup });
}));

// ---------------------------------------------------------------- bulk import from a spreadsheet (CSV)
/** Minimal RFC 4180 CSV parser (quotes, commas and line breaks inside quotes). */
export function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let quoted = false;
  const s = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = ''; if (row.some((x) => x.trim())) rows.push(row); row = [];
    } else field += c;
  }
  row.push(field); if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}
const COLS = { name: ['name', 'full name', 'display name'], email: ['email', 'email address', 'username', 'user', 'address'], title: ['title', 'job title'],
  department: ['department', 'dept', 'team'], invite: ['personal email', 'invite email', 'invite', 'private email'], phone: ['phone', 'work phone'], mobile: ['mobile', 'cell', 'mobile phone'], admin: ['admin', 'is admin', 'role'], password: ['password'] };
const genPassword = tempPassword; // shown to the admin; the person must change it at first sign-in

accounts.post('/admin/users/import', rateLimit({ windowMs: 3600e3, limit: 20 }), wrap(async (req, res) => {
  const d = await requireDomainAdmin(req, req.body.domain);
  if (d.status !== 'active') throw fail(400, 'Verify the domain before adding users');
  const rows = parseCsv(req.body.csv);
  if (rows.length < 2) throw fail(400, 'The file needs a header row (name, email, ...) and at least one person');
  if (rows.length > 501) throw fail(400, 'Import up to 500 people at a time');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = Object.fromEntries(Object.entries(COLS).map(([k, names]) => [k, header.findIndex((h) => names.includes(h))]));
  if (col.email < 0) throw fail(400, 'Add an "email" column (the address, or just the part before the @)');
  const existing = new Set((await mailcow.listMailboxes(d.domain)).map((m) => m.email.toLowerCase()));
  const seen = new Set();
  const people = rows.slice(1).map((r, i) => {
    const get = (k) => (col[k] >= 0 ? String(r[col[k]] ?? '').trim() : '');
    let local = get('email').toLowerCase();
    let error = '';
    if (local.includes('@')) { const [l, dom] = local.split('@'); if (dom !== d.domain) error = `Address must end in @${d.domain}`; local = l; }
    try { checkLocal(local); } catch (e) { error ||= e.message; }
    const email = `${local}@${d.domain}`;
    if (!error && existing.has(email)) error = 'Already exists';
    if (!error && seen.has(email)) error = 'Listed twice';
    seen.add(email);
    const password = get('password') || genPassword();
    if (!error && get('password')) { try { checkPassword(password); } catch (e) { error = e.message; } }
    return { row: i + 2, email, localPart: local, name: get('name').slice(0, 100), title: get('title'), department: get('department'), phone: get('phone'), mobile: get('mobile'),
      admin: /^(yes|y|true|1|admin)$/i.test(get('admin')), password, generated: !get('password'), inviteEmail: get('invite').toLowerCase(), error };
  });
  const valid = people.filter((p) => !p.error);
  const current = await orgMailboxCount(d.org_id);
  if (current + valid.length > d.max_mailboxes) throw fail(400, `Your plan allows ${d.max_mailboxes} users (you have ${current})`);
  // Seats: everyone counts after the free allowance
  const b = config.billing.enabled ? await orgBilling(d.org_id) : null;
  const seatsNeeded = b ? Math.max(0, current + valid.length - b.free) : 0;
  const extraSeats = b ? Math.max(0, seatsNeeded - b.paid_seats) : 0;
  const preview = { total: people.length, valid: valid.length, problems: people.filter((p) => p.error).map(({ row, email, error }) => ({ row, email, error })), extraSeats,
    perUser: b ? (b.billing_interval === 'year' ? config.billing.perUserYearly : config.billing.perUserMonthly) : 0, interval: b?.billing_interval || 'month',
    hasSubscription: !!(b?.stripe_subscription && b.billing_status !== 'canceled') };
  if (req.body.dryRun) return res.json({ preview, people: people.map(({ password, ...p }) => p) });
  if (extraSeats > 0) {
    if (!preview.hasSubscription) return res.status(402).json({ error: 'Choose a plan first, then import.', code: 'checkout_required', orgId: d.org_id, preview });
    if (!req.body.confirmSeats) return res.status(402).json({ error: `This adds ${extraSeats} paid user(s). Confirm to continue.`, code: 'seat_required', preview });
    await setSeats(d.org_id, b.paid_seats + extraSeats, 'bulk import');
  }
  const results = [];
  for (const p of valid) {
    try {
      await createUser(req, d, { ...p, welcome: req.body.welcome !== false, bulk: true });
      results.push({ email: p.email, name: p.name, ...(p.inviteEmail ? { invited: p.inviteEmail } : { password: p.password }), ok: true });
    } catch (e) { results.push({ email: p.email, name: p.name, ok: false, error: e.message }); }
  }
  syncOrgGroups(d.org_id).catch(() => {});
  await audit(req.user.email, d.org_id, 'user.bulk_import', { created: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
  res.json({ ok: true, results, problems: preview.problems });
}));

accounts.patch('/admin/users', wrap(async (req, res) => {
  const email = String(req.body.email || '').toLowerCase();
  const d = await requireDomainAdmin(req, email.split('@')[1]);
  const attr = {};
  if (req.body.name !== undefined) { attr.name = String(req.body.name).slice(0, 100); await renameMailboxId(email, attr.name); }
  if (req.body.password) { checkPassword(req.body.password); attr.password = req.body.password; attr.password2 = req.body.password; await markTemporary(email, 'admin-reset'); }
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

// "Send temporary password" (4a): a new easy-to-type temporary password, emailed from no-reply to the person's own
// recovery address. They must replace it at the next sign-in; every device using the old password is signed out.
const maskEmail = (e) => e.replace(/^(.)(.*)(@.*)$/, (m, a, b, c) => `${a}${'•'.repeat(Math.min(6, b.length))}${c}`);
accounts.post('/admin/users/temp-password', rateLimit({ windowMs: 3600e3, limit: 30 }), wrap(async (req, res) => {
  const email = String(req.body.email || '').toLowerCase();
  const d = await requireDomainAdmin(req, email.split('@')[1]);
  if (email === req.user.email) throw fail(400, 'Change your own password in Settings → Security');
  const sec = await q.get('SELECT recovery_email, recovery_verified FROM user_security WHERE email = ?', email);
  const invite = await q.get("SELECT invite_to FROM password_resets WHERE email = ? AND kind = 'invite' AND invite_to IS NOT NULL ORDER BY expires DESC LIMIT 1", email);
  // Only an address the person confirmed themselves, or the one their admin invited them at
  const to = (sec?.recovery_verified && sec.recovery_email) || invite?.invite_to || null;
  const password = tempPassword();
  await mailcow.editMailbox(email, { password, password2: password });
  await markTemporary(email, 'admin-reset');
  await revokeSessions(email);
  let sent = false;
  if (to) {
    const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    sent = await sendSystemMail(to, `Your temporary ${config.appName} password`,
      `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#242424;max-width:560px"><h2 style="color:#173D56">Your temporary password</h2>
      <p>An administrator of ${esc(d.org_name || d.domain)} set a temporary password for <b>${esc(email)}</b>:</p>
      <p style="font:600 22px/1.4 ui-monospace,Menlo,Consolas,monospace;letter-spacing:1px;background:#F2F5F8;padding:12px 16px;border-radius:8px;display:inline-block">${esc(password)}</p>
      <p>Sign in at <a href="${esc(config.publicUrl || '')}/app">${esc(config.appName)}</a>. You'll be asked to choose your own password straight away.</p>
      <p style="color:#888;font-size:12px">If you didn't expect this, contact your administrator.</p></div>`).catch(() => false);
  }
  await audit(req.user.email, d.org_id, 'user.temp_password', { email, emailed: sent });
  // Only when it couldn't be emailed is it shown to the admin (once) to hand over in person
  res.json(sent ? { ok: true, sent: true, to: maskEmail(to) } : { ok: true, sent: false, password });
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

// Staff addresses (anti-impersonation rule): only Roammail staff get a bare-first-name address on the free domain.
// Created by a super-admin with a temporary password the person must replace at first sign-in.
accounts.post('/super/staff-mailboxes', requireSuper, rateLimit({ windowMs: 3600e3, limit: 30 }), wrap(async (req, res) => {
  if (!config.signup.domain) throw fail(400, 'No free domain is set up');
  const local = String(req.body.localPart || '').trim().toLowerCase();
  const name = String(req.body.name || '').trim().slice(0, 100);
  checkLocal(local);
  if (RESERVED.has(local)) throw fail(400, 'That name is reserved for system addresses');
  if (!name) throw fail(400, "Enter the staff member's name");
  if (!(await addressAvailable(local, { staff: true }))) throw fail(409, 'That address is taken (or belonged to someone before)');
  const email = `${local}@${config.signup.domain}`;
  const password = tempPassword();
  await mailcow.addMailbox({ localPart: local, domain: config.signup.domain, name, password, quotaMb: config.business.defaultQuotaMb });
  await markTemporary(email, 'staff');
  await applyRate(email, BUSINESS_RATE).catch(() => {});
  await q.run('INSERT INTO signups(email, ip, recovery_email, terms_version) VALUES(?, ?, ?, ?) ON CONFLICT(email) DO NOTHING', email, 'staff', null, config.legal.termsVersion);
  await saveProfile(email, { name });
  await audit(req.user.email, null, 'staff.mailbox_created', { email });
  res.json({ ok: true, email, password });
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
