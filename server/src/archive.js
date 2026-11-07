// Company archive and legal hold (journaling).
// mailcow copies every message sent by or to the chosen people (or whole domains) into one archive mailbox.
// Nobody knows the archive's password, and inside Roammail it is read-only, so people can't delete their way out
// of a dispute: deleting from your own mailbox doesn't touch the archived copy.
import express from 'express';
import crypto from 'node:crypto';
import { config } from './config.js';
import { q, audit, rolesFor, twoFactorPolicy, setting, setSetting } from './db.js';
import { requireAuth, seal } from './session.js';
import { mailcow } from './mailcow.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status });

async function requireOrgAdmin(req, orgId) {
  const id = Number(orgId);
  if (!await q.get('SELECT 1 FROM orgs WHERE id = ?', id)) throw fail(404, 'Organization not found');
  const r = await rolesFor(req.user.email);
  if (!r.superAdmin && !r.orgs.some((o) => o.id === id && o.role === 'admin')) throw fail(403, 'You are not an admin of this organization');
  if (config.requireAdmin2fa && !(await twoFactorPolicy(req.user.email)).enabled) throw fail(403, 'Admins must turn on 2-step verification first (Settings → Security).');
  return id;
}
const activeDomains = async (orgId) => (await q.all("SELECT domain FROM domains WHERE org_id = ? AND status = 'active'", orgId)).map((d) => d.domain);

/** Make mailcow's BCC maps match the archive settings (adds missing maps, removes stale ones). */
export async function syncArchive(orgId) {
  const cfg = await setting(`archive:${orgId}`, null);
  const all = await mailcow.listBcc().catch(() => []);
  const mine = cfg ? all.filter((b) => b.bccDest === cfg.mailbox) : [];
  if (!cfg?.enabled) { if (mine.length) await mailcow.deleteBcc(mine.map((b) => b.id)); return { maps: 0 }; }
  const targets = cfg.scope === 'all' ? await activeDomains(orgId) : cfg.people;
  const want = new Set(targets.flatMap((t) => [`${t}|sender`, `${t}|rcpt`]));
  const have = new Set(mine.map((b) => `${b.localDest}|${b.type}`));
  for (const k of want) if (!have.has(k)) { const [dest, type] = k.split('|'); await mailcow.addBcc(dest, cfg.mailbox, type); }
  const stale = mine.filter((b) => !want.has(`${b.localDest}|${b.type}`));
  if (stale.length) await mailcow.deleteBcc(stale.map((b) => b.id));
  return { maps: want.size };
}

export const archive = express.Router();
archive.use('/admin/orgs/:id/archive', requireAuth);

archive.get('/admin/orgs/:id/archive', wrap(async (req, res) => {
  const orgId = await requireOrgAdmin(req, req.params.id);
  const cfg = await setting(`archive:${orgId}`, null);
  const viewers = cfg ? (await q.all('SELECT member FROM shared_access WHERE mailbox = ?', cfg.mailbox)).map((r) => r.member) : [];
  res.json(cfg ? { ...cfg, viewers } : { enabled: false, scope: 'all', people: [], viewers: [] });
}));

archive.put('/admin/orgs/:id/archive', wrap(async (req, res) => {
  const orgId = await requireOrgAdmin(req, req.params.id);
  const domains = await activeDomains(orgId);
  if (!domains.length) throw fail(400, 'Activate a domain first');
  const prev = await setting(`archive:${orgId}`, null);
  const scope = req.body.scope === 'people' ? 'people' : 'all';
  const people = [...new Set([].concat(req.body.people || []).map((e) => String(e).trim().toLowerCase()))].slice(0, 1000);
  for (const p of people) if (!domains.includes(p.split('@')[1])) throw fail(400, `${p} isn't in your business`);
  if (scope === 'people' && req.body.enabled && !people.length) throw fail(400, 'Choose at least one person to hold');
  const viewers = [...new Set([].concat(req.body.viewers || []).map((e) => String(e).trim().toLowerCase()))].slice(0, 20);
  for (const v of viewers) if (!domains.includes(v.split('@')[1])) throw fail(400, `${v} isn't in your business`);
  // Create the archive mailbox once
  let mailbox = prev?.mailbox;
  if (!mailbox) {
    const local = `archive-${crypto.randomBytes(3).toString('hex')}`;
    mailbox = `${local}@${domains[0]}`;
    const password = `${crypto.randomBytes(24).toString('base64url')}!Aa1`;
    await mailcow.addMailbox({ localPart: local, domain: domains[0], name: 'Company archive', password, quotaMb: config.business.maxQuotaMb });
    await q.run("INSERT INTO shared_mailboxes(email, org_id, name, creds, created_by, kind) VALUES(?, ?, ?, ?, ?, 'archive')", mailbox, orgId, 'Company archive', seal({ password }), req.user.email);
  }
  await q.run('DELETE FROM shared_access WHERE mailbox = ?', mailbox);
  for (const v of viewers) await q.run('INSERT INTO shared_access(mailbox, member, can_send) VALUES(?, ?, 0)', mailbox, v);
  const cfg = { enabled: !!req.body.enabled, scope, people: scope === 'people' ? people : [], mailbox, since: prev?.enabled ? prev.since : (req.body.enabled ? Date.now() : null) };
  await setSetting(`archive:${orgId}`, cfg);
  const r = await syncArchive(orgId);
  await audit(req.user.email, orgId, 'archive.settings', { enabled: cfg.enabled, scope, people: cfg.people, viewers });
  res.json({ ok: true, ...cfg, viewers, maps: r.maps });
}));
