// Shared mailboxes (e.g. support@ or info@ that a team works from together).
// Each is a normal mailcow mailbox whose password nobody knows: the app keeps it sealed and opens the mailbox
// for members after checking they have access. Like Microsoft 365, shared mailboxes don't use a paid seat.
import express from 'express';
import crypto from 'node:crypto';
import { config } from './config.js';
import { q, audit, rolesFor, twoFactorPolicy } from './db.js';
import { requireAuth, seal, unseal } from './session.js';
import { mailcow } from './mailcow.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status });
const LIMIT = Number(process.env.SHARED_MAILBOX_LIMIT || 25);

export async function isSharedMailbox(email) {
  return !!(await q.get('SELECT 1 FROM shared_mailboxes WHERE email = ?', String(email).toLowerCase()));
}
export async function sharedMailboxSet() {
  return new Set((await q.all('SELECT email FROM shared_mailboxes')).map((r) => r.email));
}

/** Shared mailboxes this person can open. */
export async function sharedFor(email) {
  return q.all(`SELECT s.email, s.name, s.kind, a.can_send FROM shared_access a JOIN shared_mailboxes s ON s.email = a.mailbox
    WHERE a.member = ? ORDER BY s.name`, String(email).toLowerCase());
}

/**
 * Middleware for the mail API: with header X-Mailbox (or ?mailbox= for live updates) the request works on a shared
 * mailbox instead of the person's own. req.actor keeps the real person for audit and permissions.
 */
// Only these mail paths can act on a shared mailbox. Everything else (security, settings, admin, billing...)
// always runs as the signed-in person, even if the header is sent.
const MAIL_PATHS = ['/attachment', '/copy', '/delete', '/drafts', '/empty', '/events', '/flags', '/folders', '/mark-all-read',
  '/message', '/messages', '/move', '/raw', '/scheduled', '/search', '/send', '/snooze', '/snoozed', '/thread'];
export function sharedMailboxContext({ sendPaths = ['/send', '/drafts', '/scheduled', '/snooze'] } = {}) {
  return wrap(async (req, res, next) => {
    req.actor = req.user;
    if (!MAIL_PATHS.some((p) => req.path === p || req.path.startsWith(`${p}/`))) return next();
    const want = String(req.get('X-Mailbox') || req.query.mailbox || '').toLowerCase();
    req.actor = req.user;
    if (!want || want === req.user.email.toLowerCase()) return next();
    const row = await q.get(`SELECT s.email, s.name, s.creds, s.kind, a.can_send FROM shared_access a JOIN shared_mailboxes s ON s.email = a.mailbox
      WHERE a.mailbox = ? AND a.member = ?`, want, req.user.email.toLowerCase());
    if (!row) throw fail(403, 'You don\'t have access to that mailbox');
    // The company archive is evidence: it can be read and searched, never changed or emptied
    if (row.kind === 'archive' && req.method !== 'GET') throw fail(403, 'The archive is read-only');
    if (!row.can_send && req.method !== 'GET' && sendPaths.some((p) => req.path.startsWith(p))) throw fail(403, 'You can read this mailbox but not send from it');
    const creds = unseal(row.creds);
    if (!creds) throw fail(500, 'This shared mailbox needs to be reset by an admin');
    req.user = { email: row.email, password: creds.password, name: row.name, sid: `${req.actor.sid}|${row.email}`, sharedBy: req.actor.email };
    next();
  });
}

// ---------------------------------------------------------------- API
export const sharedboxes = express.Router();
sharedboxes.use(['/shared-mailboxes', '/admin/orgs/:id/shared-mailboxes'], requireAuth);

sharedboxes.get('/shared-mailboxes', wrap(async (req, res) => {
  res.json((await sharedFor(req.user.email)).map((r) => ({ email: r.email, name: r.name, canSend: !!r.can_send && r.kind !== 'archive', archive: r.kind === 'archive' })));
}));

async function requireOrgAdmin(req, orgId) {
  const id = Number(orgId);
  if (!await q.get('SELECT 1 FROM orgs WHERE id = ?', id)) throw fail(404, 'Organization not found');
  const r = await rolesFor(req.user.email);
  if (!r.superAdmin && !r.orgs.some((o) => o.id === id && o.role === 'admin')) throw fail(403, 'You are not an admin of this organization');
  if (config.requireAdmin2fa && !(await twoFactorPolicy(req.user.email)).enabled) throw fail(403, 'Admins must turn on 2-step verification first (Settings → Security).');
  return id;
}
async function cleanMembers(orgId, list) {
  const domains = new Set((await q.all("SELECT domain FROM domains WHERE org_id = ? AND status = 'active'", orgId)).map((d) => d.domain));
  const shared = await sharedMailboxSet();
  const out = new Map();
  for (const m of [].concat(list || []).slice(0, 500)) {
    const email = String(m.email || m).trim().toLowerCase();
    if (!domains.has(email.split('@')[1]) || shared.has(email)) throw fail(400, `${email} isn't a person in your business`);
    out.set(email, { email, canSend: m.canSend !== false });
  }
  return [...out.values()];
}
async function setMembers(mailbox, members) {
  await q.run('DELETE FROM shared_access WHERE mailbox = ?', mailbox);
  for (const m of members) await q.run('INSERT INTO shared_access(mailbox, member, can_send) VALUES(?, ?, ?)', mailbox, m.email, m.canSend ? 1 : 0);
}

sharedboxes.get('/admin/orgs/:id/shared-mailboxes', wrap(async (req, res) => {
  const orgId = await requireOrgAdmin(req, req.params.id);
  const boxes = await q.all("SELECT email, name, created_at FROM shared_mailboxes WHERE org_id = ? AND kind = 'shared' ORDER BY name", orgId);
  for (const b of boxes) b.members = (await q.all('SELECT member AS email, can_send FROM shared_access WHERE mailbox = ? ORDER BY member', b.email)).map((m) => ({ email: m.email, canSend: !!m.can_send }));
  res.json({ boxes, limit: LIMIT });
}));

sharedboxes.post('/admin/orgs/:id/shared-mailboxes', wrap(async (req, res) => {
  const orgId = await requireOrgAdmin(req, req.params.id);
  const domain = String(req.body.domain || '').toLowerCase();
  if (!await q.get("SELECT 1 FROM domains WHERE domain = ? AND org_id = ? AND status = 'active'", domain, orgId)) throw fail(400, 'Pick one of your active domains');
  const local = String(req.body.localPart || '').trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/.test(local)) throw fail(400, 'Use letters, numbers, dots, dashes or underscores');
  if ((await q.get('SELECT COUNT(*) AS n FROM shared_mailboxes WHERE org_id = ? AND kind = \'shared\'', orgId)).n >= LIMIT) throw fail(400, `You can have up to ${LIMIT} shared mailboxes`);
  const email = `${local}@${domain}`;
  if (await mailcow.getMailbox(email)) throw fail(409, 'That address is already a mailbox');
  if (await q.get('SELECT 1 FROM groups WHERE address = ?', email)) throw fail(409, 'That address is already a group');
  const members = await cleanMembers(orgId, req.body.members);
  const name = String(req.body.name || local).slice(0, 80);
  const password = `${crypto.randomBytes(24).toString('base64url')}!Aa1`; // nobody ever sees it
  await mailcow.addMailbox({ localPart: local, domain, name, password, quotaMb: config.business.defaultQuotaMb });
  await q.run('INSERT INTO shared_mailboxes(email, org_id, name, creds, created_by) VALUES(?, ?, ?, ?, ?)', email, orgId, name, seal({ password }), req.user.email);
  await setMembers(email, members);
  await audit(req.user.email, orgId, 'shared.create', { email, members: members.length });
  res.json({ ok: true, email });
}));

sharedboxes.put('/admin/orgs/:id/shared-mailboxes/:email', wrap(async (req, res) => {
  const orgId = await requireOrgAdmin(req, req.params.id);
  const email = String(req.params.email).toLowerCase();
  if (!await q.get('SELECT 1 FROM shared_mailboxes WHERE email = ? AND org_id = ?', email, orgId)) throw fail(404, 'Not found');
  const members = await cleanMembers(orgId, req.body.members);
  await setMembers(email, members);
  if (req.body.name) {
    await q.run('UPDATE shared_mailboxes SET name = ? WHERE email = ?', String(req.body.name).slice(0, 80), email);
    await mailcow.editMailbox(email, { name: String(req.body.name).slice(0, 80) }).catch(() => {});
  }
  await audit(req.user.email, orgId, 'shared.members', { email, members: members.map((m) => m.email) });
  res.json({ ok: true });
}));

sharedboxes.delete('/admin/orgs/:id/shared-mailboxes/:email', wrap(async (req, res) => {
  const orgId = await requireOrgAdmin(req, req.params.id);
  const email = String(req.params.email).toLowerCase();
  if (!await q.get('SELECT 1 FROM shared_mailboxes WHERE email = ? AND org_id = ?', email, orgId)) throw fail(404, 'Not found');
  if (req.body?.confirm !== email) throw fail(400, 'Type the address to confirm: its mail will be deleted');
  await mailcow.deleteMailbox(email);
  await q.run('DELETE FROM shared_access WHERE mailbox = ?', email);
  await q.run('DELETE FROM shared_mailboxes WHERE email = ?', email);
  await audit(req.user.email, orgId, 'shared.delete', { email });
  res.json({ ok: true });
}));
