// Groups & departments: unlimited distribution lists for businesses. Each group is one address (a mailcow alias,
// so it doesn't use a mailbox). Mail to it reaches every member; members can send as the group if allowed.
import express from 'express';
import { q, rolesFor, audit, twoFactorPolicy } from './db.js';
import { config } from './config.js';
import { requireAuth } from './session.js';
import { mailcow } from './mailcow.js';
import { getProfile } from './signatures.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status });
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const LOCAL_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const clip = (s, n) => String(s ?? '').replace(/[\r\n]/g, ' ').trim().slice(0, n);

const orgDomains = async (orgId) => (await q.all("SELECT domain FROM domains WHERE org_id = ? AND status = 'active'", orgId)).map((d) => d.domain);
const orgOfEmail = async (email) => (await q.get("SELECT org_id FROM domains WHERE domain = ? AND status = 'active'", email.split('@')[1]))?.org_id ?? null;

async function orgPeople(orgId) {
  const people = [];
  const shared = new Set((await q.all('SELECT email FROM shared_mailboxes WHERE org_id = ?', orgId)).map((r) => r.email));
  for (const d of await orgDomains(orgId)) {
    for (const m of await mailcow.listMailboxes(d).catch(() => [])) {
      if (m.active && !shared.has(m.email.toLowerCase())) people.push({ email: m.email.toLowerCase(), name: (await getProfile(m.email)).name || m.name || '', department: (await getProfile(m.email)).department || '' });
    }
  }
  return people;
}

/** Current member list of a group (computed for department / everyone groups). */
export async function membersOf(g, people) {
  const list = people || await orgPeople(g.org_id);
  if (g.kind === 'everyone') return list.map((p) => p.email);
  if (g.kind === 'department') return list.filter((p) => p.department.toLowerCase() === String(g.department || '').toLowerCase()).map((p) => p.email);
  return JSON.parse(g.members || '[]');
}

async function fallbackGoto(orgId) {
  return (await q.get('SELECT owner_email FROM orgs WHERE id = ?', orgId))?.owner_email;
}

/** Push a group's membership and options to mailcow. */
async function syncGroup(g, people) {
  const members = await membersOf(g, people);
  const goto = (members.length ? members : [await fallbackGoto(g.org_id)]).filter(Boolean).join(',');
  const domain = g.address.split('@')[1];
  const alias = (await mailcow.listAliases(domain)).find((a) => a.address.toLowerCase() === g.address);
  const opts = { internal: !!g.internal, senderAllowed: !!g.send_as, comment: `Group: ${g.name}` };
  if (!alias) await mailcow.addAlias(g.address, goto, opts);
  else if (alias.goto !== goto || alias.internal !== !!g.internal || alias.senderAllowed !== !!g.send_as) {
    await mailcow.editAlias(alias.id, { goto, internal: opts.internal ? 1 : 0, sender_allowed: opts.senderAllowed ? 1 : 0, public_comment: opts.comment });
  }
  return members;
}

/** Re-sync every dynamic group in an organization (after users or departments change). */
export async function syncOrgGroups(orgId) {
  if (!orgId) return;
  const groups = await q.all("SELECT * FROM groups WHERE org_id = ? AND kind != 'static'", orgId);
  if (!groups.length) return;
  const people = await orgPeople(orgId);
  for (const g of groups) await syncGroup(g, people).catch((e) => console.warn('group sync failed', g.address, e.message));
}
export const syncGroupsForEmail = async (email) => await syncOrgGroups(await orgOfEmail(email));

/** Addresses this user may send as (their own + groups they belong to that allow it). */
export async function identitiesFor(user) {
  const out = [{ address: user.email, name: user.name || '' }];
  const orgId = await orgOfEmail(user.email);
  if (!orgId) return out;
  const groups = await q.all('SELECT * FROM groups WHERE org_id = ? AND send_as = 1', orgId);
  if (!groups.length) return out;
  const people = await orgPeople(orgId);
  for (const g of groups) if ((await membersOf(g, people)).includes(user.email.toLowerCase())) out.push({ address: g.address, name: g.name, group: true });
  return out;
}

async function requireOrgAdmin(req, orgId) {
  const id = Number(orgId);
  if (!await q.get('SELECT 1 FROM orgs WHERE id = ?', id)) throw fail(404, 'Organization not found');
  const r = await rolesFor(req.user.email);
  if (!r.superAdmin && !r.orgs.some((o) => o.id === id && o.role === 'admin')) throw fail(403, 'You are not an admin of this organization');
  if (config.requireAdmin2fa && !(await twoFactorPolicy(req.user.email)).enabled) throw fail(403, 'Admins must turn on 2-step verification first (Settings → Security).');
  return id;
}

async function validateGroup(orgId, b, existingId) {
  const name = clip(b.name, 80);
  if (!name) throw fail(400, 'Give the group a name');
  const kind = ['static', 'department', 'everyone'].includes(b.kind) ? b.kind : 'static';
  const department = kind === 'department' ? clip(b.department, 80) : null;
  if (kind === 'department' && !department) throw fail(400, 'Choose a department');
  const domains = await orgDomains(orgId);
  const org = await q.get('SELECT allow_external_forward FROM orgs WHERE id = ?', orgId);
  let members = [];
  if (kind === 'static') {
    members = [...new Set((Array.isArray(b.members) ? b.members : []).map((m) => String(m.address || m.email || m).trim().toLowerCase()).filter((m) => EMAIL_RE.test(m)))].slice(0, 1000);
    const external = members.filter((m) => !domains.includes(m.split('@')[1]));
    if (external.length && !org?.allow_external_forward) throw fail(403, `People outside your company (${external[0]}) can only be added if an admin allows external forwarding (Admin → Security).`);
    if (!members.length) throw fail(400, 'Add at least one member');
  }
  return { name, kind, department, members, description: clip(b.description, 300), internal: b.internal === false ? 0 : 1, send_as: b.sendAs === false ? 0 : 1, domains, existingId };
}

export const groups = express.Router();
groups.use(requireAuth);

groups.get('/identities', wrap(async (req, res) => res.json(await identitiesFor(req.user))));

groups.get('/admin/orgs/:id/groups', wrap(async (req, res) => {
  const orgId = await requireOrgAdmin(req, req.params.id);
  const people = await orgPeople(orgId);
  const list = await q.all('SELECT * FROM groups WHERE org_id = ? ORDER BY name', orgId);
  const out = [];
  for (const g of list) out.push({ id: g.id, address: g.address, name: g.name, description: g.description, kind: g.kind, department: g.department, internal: !!g.internal, sendAs: !!g.send_as, members: await membersOf(g, people) });
  const departments = [...new Set([...(await q.all('SELECT name FROM departments WHERE org_id = ?', orgId)).map((d) => d.name), ...people.map((p) => p.department).filter(Boolean)])].sort();
  res.json({ groups: out, people, departments, domains: await orgDomains(orgId) });
}));

groups.post('/admin/orgs/:id/groups', wrap(async (req, res) => {
  const orgId = await requireOrgAdmin(req, req.params.id);
  const v = await validateGroup(orgId, req.body);
  const local = String(req.body.localPart || '').trim().toLowerCase();
  const domain = v.domains.includes(req.body.domain) ? req.body.domain : v.domains[0];
  if (!LOCAL_RE.test(local)) throw fail(400, 'Group addresses can use letters, numbers, dots and dashes');
  const address = `${local}@${domain}`;
  if (await q.get('SELECT 1 FROM groups WHERE address = ?', address)) throw fail(409, 'A group with that address already exists');
  if (await mailcow.getMailbox(address)) throw fail(409, 'A person already uses that address');
  if ((await mailcow.listAliases(domain)).some((a) => a.address.toLowerCase() === address)) throw fail(409, 'That address is already an alias. Remove it first (Admin → Aliases).');
  const newId = await q.insert('INSERT INTO groups(org_id, address, name, description, kind, department, members, internal, send_as) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)',
    orgId, address, v.name, v.description, v.kind, v.department, JSON.stringify(v.members), v.internal, v.send_as);
  const g = await q.get('SELECT * FROM groups WHERE id = ?', newId);
  try { await syncGroup(g); } catch (e) { await q.run('DELETE FROM groups WHERE id = ?', g.id); throw e; }
  if (v.department) await q.run('INSERT OR IGNORE INTO departments(org_id, name) VALUES(?, ?)', orgId, v.department);
  await audit(req.user.email, orgId, 'group.create', { address, kind: v.kind });
  res.json({ ok: true, address });
}));

groups.put('/admin/orgs/:id/groups/:gid', wrap(async (req, res) => {
  const orgId = await requireOrgAdmin(req, req.params.id);
  const g = await q.get('SELECT * FROM groups WHERE id = ? AND org_id = ?', Number(req.params.gid), orgId);
  if (!g) throw fail(404, 'Group not found');
  const v = await validateGroup(orgId, req.body, g.id);
  await q.run('UPDATE groups SET name = ?, description = ?, kind = ?, department = ?, members = ?, internal = ?, send_as = ? WHERE id = ?',
    v.name, v.description, v.kind, v.department, JSON.stringify(v.members), v.internal, v.send_as, g.id);
  await syncGroup(await q.get('SELECT * FROM groups WHERE id = ?', g.id));
  await audit(req.user.email, orgId, 'group.update', { address: g.address });
  res.json({ ok: true });
}));

groups.delete('/admin/orgs/:id/groups/:gid', wrap(async (req, res) => {
  const orgId = await requireOrgAdmin(req, req.params.id);
  const g = await q.get('SELECT * FROM groups WHERE id = ? AND org_id = ?', Number(req.params.gid), orgId);
  if (!g) throw fail(404, 'Group not found');
  const alias = (await mailcow.listAliases(g.address.split('@')[1])).find((a) => a.address.toLowerCase() === g.address);
  if (alias) await mailcow.deleteAlias(alias.id);
  await q.run('DELETE FROM groups WHERE id = ?', g.id);
  await audit(req.user.email, orgId, 'group.delete', { address: g.address });
  res.json({ ok: true });
}));

groups.post('/admin/orgs/:id/departments', wrap(async (req, res) => {
  const orgId = await requireOrgAdmin(req, req.params.id);
  const name = clip(req.body.name, 80);
  if (!name) throw fail(400, 'Enter a department name');
  await q.run('INSERT OR IGNORE INTO departments(org_id, name) VALUES(?, ?)', orgId, name);
  res.json({ ok: true });
}));
