// Hide-my-email aliases: make a new address for every site you sign up to (e.g. amber.reef.7f3a@roammail.net). Mail to
// it arrives in your inbox; switch it off when it starts getting spam, and you'll know exactly who leaked or sold it.
// Aliases live on the free domain so they never reveal your own domain or name. Created on the mail server (through
// the provisioner, like every other change there); delivery happens there too, so they work in every app.
import express from 'express';
import crypto from 'node:crypto';
import { config } from './config.js';
import { q, audit } from './db.js';
import { requireAuth } from './session.js';
import { mailcow } from './mailcow.js';
import { rateLimit } from './shared.js';
import { WORDS } from './temppass.js';
import { premiumState } from './premium.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const FREE_LIMIT = Number(process.env.ALIASES_FREE || 10);
const PAID_LIMIT = Number(process.env.ALIASES_PAID || 200);
const domain = () => config.signup.domain;

async function limitFor(email) {
  if ((await premiumState(email)).active) return PAID_LIMIT;
  const inOrg = await q.get("SELECT 1 FROM domains WHERE domain = ? AND status = 'active'", email.split('@')[1]);
  return inOrg ? PAID_LIMIT : FREE_LIMIT; // business mailboxes are paid
}
const randomLocal = () => {
  const w = () => WORDS[crypto.randomInt(WORDS.length)].toLowerCase();
  return `${w()}.${w()}.${crypto.randomBytes(2).toString('hex')}`;
};
const view = (r) => ({ id: r.id, address: r.address, note: r.note || '', active: !!r.active, created: Number(r.created_at) });

export const aliasesApi = express.Router();
aliasesApi.use('/aliases', requireAuth);

aliasesApi.get('/aliases', wrap(async (req, res) => {
  const rows = await q.all('SELECT * FROM user_aliases WHERE email = ? ORDER BY created_at DESC', req.user.email);
  res.json({ domain: domain(), limit: await limitFor(req.user.email), aliases: rows.map(view) });
}));

aliasesApi.post('/aliases', rateLimit({ windowMs: 3600e3, limit: 30 }), wrap(async (req, res) => {
  if (req.delegatedMailbox) throw fail(403, 'Make aliases from your own mailbox');
  if (!domain()) throw fail(400, 'Aliases aren’t available on this server');
  const n = (await q.get('SELECT COUNT(*) AS n FROM user_aliases WHERE email = ?', req.user.email)).n;
  const limit = await limitFor(req.user.email);
  if (n >= limit) throw fail(402, limit === FREE_LIMIT ? `Free accounts can have ${FREE_LIMIT} aliases. Premium gives you ${PAID_LIMIT}.` : `You can have up to ${limit} aliases. Delete one you no longer use.`);
  const note = String(req.body.note || '').trim().slice(0, 100);
  for (let i = 0; i < 5; i++) {
    const address = `${randomLocal()}@${domain()}`;
    if (await mailcow.getMailbox(address)) continue;
    const r = await mailcow.addAlias(address, req.user.email, { comment: `hide-my-email for ${req.user.email}` });
    if (JSON.stringify(r || '').includes('alias_exists')) continue;
    const created = (await mailcow.listAliases(domain())).find((a) => a.address === address);
    if (!created) throw fail(502, 'The mail server didn’t create the alias. Please try again.');
    const id = await q.insert('INSERT INTO user_aliases(email, address, mailcow_id, note, active, created_at) VALUES(?, ?, ?, ?, 1, ?)', req.user.email, address, String(created.id), note, Date.now());
    await audit(req.user.email, null, 'alias.created', { address });
    return res.json(view(await q.get('SELECT * FROM user_aliases WHERE id = ?', id)));
  }
  throw fail(503, 'Couldn’t find a free address. Please try again.');
}));

async function mine(req) {
  const r = await q.get('SELECT * FROM user_aliases WHERE id = ? AND email = ?', Number(req.params.id), req.user.email);
  if (!r) throw fail(404, 'Alias not found');
  return r;
}
aliasesApi.patch('/aliases/:id', wrap(async (req, res) => {
  const r = await mine(req);
  if (typeof req.body.active === 'boolean' && req.body.active !== !!r.active) {
    await mailcow.editAlias(r.mailcow_id, { active: req.body.active ? 1 : 0 });
    await q.run('UPDATE user_aliases SET active = ? WHERE id = ?', req.body.active ? 1 : 0, r.id);
    await audit(req.user.email, null, req.body.active ? 'alias.enabled' : 'alias.disabled', { address: r.address });
  }
  if (typeof req.body.note === 'string') await q.run('UPDATE user_aliases SET note = ? WHERE id = ?', req.body.note.trim().slice(0, 100), r.id);
  res.json(view(await q.get('SELECT * FROM user_aliases WHERE id = ?', r.id)));
}));
aliasesApi.delete('/aliases/:id', wrap(async (req, res) => {
  const r = await mine(req);
  await mailcow.deleteAlias(r.mailcow_id).catch((e) => console.error('APP_ERROR alias delete', e.message));
  await q.run('DELETE FROM user_aliases WHERE id = ?', r.id);
  await audit(req.user.email, null, 'alias.deleted', { address: r.address });
  res.json({ ok: true });
}));

/** Account deletion: remove the person's aliases from the mail server too. */
export async function deleteAliasesFor(email) {
  for (const r of await q.all('SELECT * FROM user_aliases WHERE email = ?', email)) await mailcow.deleteAlias(r.mailcow_id).catch(() => {});
  await q.run('DELETE FROM user_aliases WHERE email = ?', email);
}
