// Out-of-office, rules / block sender (Sieve via mailcow), and importing old email.
import express from 'express';
import { config } from './config.js';
import { q, userSetting, setUserSetting, audit } from './db.js';
import { requireAuth } from './session.js';
import { mailcow } from './mailcow.js';
import { assertPublicHost, accountKind } from './abuse.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status });
const SCRIPT_DESC = 'webmail: rules and automatic replies';

// ---------------------------------------------------------------- sieve generation
const str = (s) => `"${String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\n')}"`;
const multiline = (s) => `text:\n${String(s ?? '').replace(/\r/g, '').split('\n').map((l) => (l.startsWith('.') ? `.${l}` : l)).join('\n')}\n.\n`;
const FIELDS = { from: 'from', to: ['to', 'cc'], subject: 'subject' };

function cond(c) {
  const v = String(c.value || '').trim();
  if (!v) return null;
  if (c.field === 'from') return `address :contains "from" ${str(v)}`;
  if (c.field === 'to') return `address :contains ["to", "cc"] ${str(v)}`;
  if (c.field === 'subject') return `header :contains "subject" ${str(v)}`;
  if (c.field === 'body') return null; // body extension isn't guaranteed; skipped
  return null;
}

export function buildSieve({ vacation, rules }, me, orgDomains) {
  const req = new Set(['fileinto', 'imap4flags', 'copy']);
  const lines = [];
  if (vacation?.enabled && vacation.message) {
    req.add('vacation');
    const tests = [];
    if (vacation.start) { req.add('date'); req.add('relational'); tests.push(`currentdate :value "ge" "date" ${str(vacation.start)}`); }
    if (vacation.end) { req.add('date'); req.add('relational'); tests.push(`currentdate :value "le" "date" ${str(vacation.end)}`); }
    if (vacation.onlyOrg && orgDomains.length) tests.push(`address :domain :is "from" [${orgDomains.map(str).join(', ')}]`);
    tests.push('not header :contains "precedence" ["bulk", "list", "junk"]', 'not exists "list-id"');
    lines.push(`if allof(${tests.join(', ')}) {\n  vacation :days 1 :subject ${str(vacation.subject || 'Out of office')} :addresses [${str(me)}] ${multiline(vacation.message)};\n}`);
  }
  for (const r of (rules || []).filter((x) => x.enabled !== false)) {
    const tests = (r.conditions || []).map(cond).filter(Boolean);
    if (!tests.length) continue;
    const acts = [];
    for (const a of r.actions || []) {
      if (a.type === 'move' && a.folder) acts.push(`fileinto ${str(a.folder)};`);
      if (a.type === 'read') acts.push('addflag "\\\\Seen";');
      if (a.type === 'flag') acts.push('addflag "\\\\Flagged";');
      if (a.type === 'category' && a.value) acts.push(`addflag ${str(`cat_${a.value.replace(/[^A-Za-z0-9_-]/g, '')}`)};`);
      if (a.type === 'forward' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.value || '')) acts.push(`redirect :copy ${str(a.value)};`);
      if (a.type === 'junk') acts.push('fileinto "Junk";');
      if (a.type === 'trash') acts.push('fileinto "Trash";');
    }
    if (!acts.length) continue;
    // flags must be set before fileinto to land on the filed copy
    acts.sort((x, y) => (x.startsWith('addflag') ? -1 : 0) - (y.startsWith('addflag') ? -1 : 0));
    if (r.stop !== false) acts.push('stop;');
    lines.push(`# ${String(r.name || 'Rule').replace(/[\r\n]/g, ' ')}\nif ${r.match === 'all' ? 'allof' : 'anyof'}(${tests.join(', ')}) {\n  ${acts.join('\n  ')}\n}`);
  }
  if (!lines.length) return null;
  // mailcow files spam into Junk in global_sieve_after, which runs after this script. File it here first so
  // no rule can pull spam into a normal folder and automatic replies never answer spammers.
  const spamFirst = '# Spam always goes to Junk (same as mailcow), before any rule or automatic reply\nif header :contains "X-Spam-Flag" "YES" {\n  fileinto "Junk";\n  stop;\n}';
  return `require [${[...req].map(str).join(', ')}];\n\n${[spamFirst, ...lines].join('\n\n')}\n`;
}

async function sync(user) {
  const data = { vacation: await userSetting(user.email, 'vacation', null), rules: await userSetting(user.email, 'rules', []) };
  const orgDomains = (await q.all("SELECT domain FROM domains WHERE status = 'active' AND org_id = (SELECT org_id FROM domains WHERE domain = ?)", user.email.split('@')[1])).map((d) => d.domain);
  const script = buildSieve(data, user.email, orgDomains.length ? orgDomains : [user.email.split('@')[1]]);
  const existing = (await mailcow.listFilters(user.email)).find((f) => f.script_desc === SCRIPT_DESC);
  if (!script) { if (existing) await mailcow.deleteFilter(existing.id); return; }
  if (existing) await mailcow.editFilter(existing.id, { script_data: script, script_desc: SCRIPT_DESC, filter_type: 'prefilter', active: 1 });
  else await mailcow.addFilter(user.email, SCRIPT_DESC, script);
}

// ---------------------------------------------------------------- API
export const mailtools = express.Router();
mailtools.use(requireAuth);

mailtools.get('/vacation', async (req, res) => res.json(await userSetting(req.user.email, 'vacation', { enabled: false, subject: 'Out of office', message: '', start: '', end: '', onlyOrg: false })));
mailtools.put('/vacation', wrap(async (req, res) => {
  const b = req.body;
  const date = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : '');
  const v = { enabled: !!b.enabled, subject: String(b.subject || 'Out of office').slice(0, 200), message: String(b.message || '').slice(0, 5000),
    start: date(b.start), end: date(b.end), onlyOrg: !!b.onlyOrg };
  if (v.enabled && !v.message.trim()) throw fail(400, 'Write the message people will receive');
  await setUserSetting(req.user.email, 'vacation', v);
  await sync(req.user);
  await audit(req.user.email, null, v.enabled ? 'vacation.on' : 'vacation.off');
  res.json(v);
}));

/** Free accounts can't auto-forward; business users only inside the company unless an admin allows external. */
async function assertForwardAllowed(email, targets) {
  const k = await accountKind(email);
  if (!k.business) throw fail(403, 'Automatic forwarding is available on business accounts');
  const org = await q.get('SELECT allow_external_forward FROM orgs WHERE id = ?', k.orgId);
  if (org?.allow_external_forward) return;
  const internal = new Set((await q.all("SELECT domain FROM domains WHERE org_id = ? AND status = 'active'", k.orgId)).map((d) => d.domain));
  for (const t of targets) {
    const d = String(t || '').toLowerCase().split('@')[1];
    if (!d || !internal.has(d)) throw fail(403, 'Your organization only allows forwarding to addresses inside the company. Ask an admin to allow external forwarding.');
  }
}

/** Raw Sieve uploaded by users: apply the same forwarding policy and block side channels. */
async function assertSafeSieve(email, script) {
  if (/\b(notify|enotify|extlists|vnd\.)/i.test(script)) throw fail(400, 'This script uses a Sieve feature that is not allowed here');
  const redirects = [...script.matchAll(/\bredirect\b([^;]*);/gi)].map((m) => m[1]);
  if (!redirects.length) return;
  const targets = [];
  for (const r of redirects) {
    const quoted = [...r.matchAll(/"([^"]*)"/g)].map((x) => x[1]);
    if (!quoted.length || quoted.some((v) => v.includes('${'))) throw fail(400, 'Forwarding addresses must be written out in full');
    targets.push(...quoted.filter((v) => v.includes('@')));
    if (!quoted.some((v) => v.includes('@'))) throw fail(400, 'Forwarding addresses must be written out in full');
  }
  await assertForwardAllowed(email, targets);
}

const cleanRule = (r, i) => ({
  id: String(r.id || `r${Date.now()}${i}`).slice(0, 40), name: String(r.name || 'Rule').slice(0, 80), enabled: r.enabled !== false,
  match: r.match === 'all' ? 'all' : 'any', stop: r.stop !== false,
  conditions: (r.conditions || []).slice(0, 10).map((c) => ({ field: ['from', 'to', 'subject'].includes(c.field) ? c.field : 'from', value: String(c.value || '').slice(0, 200) })),
  actions: (r.actions || []).slice(0, 5).map((a) => ({ type: ['move', 'read', 'flag', 'category', 'forward', 'junk', 'trash'].includes(a.type) ? a.type : 'move', folder: String(a.folder || '').slice(0, 200), value: String(a.value || '').slice(0, 200) })),
});

mailtools.get('/rules', async (req, res) => res.json(await userSetting(req.user.email, 'rules', [])));
mailtools.put('/rules', wrap(async (req, res) => {
  const rules = (Array.isArray(req.body.rules) ? req.body.rules : []).slice(0, 100).map(cleanRule);
  // Forwarding everything out is a classic account-takeover trick
  for (const r of rules) for (const a of r.actions.filter((x) => x.type === 'forward')) await assertForwardAllowed(req.user.email, [a.value]);
  await setUserSetting(req.user.email, 'rules', rules);
  await sync(req.user);
  await audit(req.user.email, null, 'rules.update', { count: rules.length, forwards: rules.filter((r) => r.actions.some((a) => a.type === 'forward')).length });
  res.json(rules);
}));

// ---------------------------------------------------------------- advanced: all of the user's mailcow Sieve filters
mailtools.get('/filters/server', wrap(async (req, res) => {
  res.json((await mailcow.listFilters(req.user.email)).map((f) => ({
    id: f.id, desc: f.script_desc, type: f.filter_type, active: Number(f.active) === 1, script: f.script_data, managed: f.script_desc === SCRIPT_DESC,
  })));
}));
mailtools.post('/filters/server', wrap(async (req, res) => {
  const desc = String(req.body.desc || '').trim().slice(0, 120);
  const script = String(req.body.script || '');
  if (!desc || !script.trim()) throw fail(400, 'Give the filter a name and a script');
  if (desc === SCRIPT_DESC) throw fail(400, 'That name is reserved');
  if (script.length > 50000) throw fail(400, 'Script too long');
  await assertSafeSieve(req.user.email, script);
  await mailcow.addFilter(req.user.email, desc, script, req.body.type === 'postfilter' ? 'postfilter' : 'prefilter');
  await audit(req.user.email, null, 'filter.raw_add', { desc });
  res.json({ ok: true });
}));
mailtools.patch('/filters/server', wrap(async (req, res) => {
  const f = (await mailcow.listFilters(req.user.email)).find((x) => String(x.id) === String(req.body.id));
  if (!f) throw fail(404, 'Filter not found');
  const attr = {};
  if (req.body.active !== undefined) attr.active = req.body.active ? 1 : 0;
  if (req.body.script !== undefined && f.script_desc !== SCRIPT_DESC) { await assertSafeSieve(req.user.email, String(req.body.script)); attr.script_data = String(req.body.script); }
  await mailcow.editFilter(f.id, attr);
  res.json({ ok: true });
}));
mailtools.delete('/filters/server', wrap(async (req, res) => {
  const f = (await mailcow.listFilters(req.user.email)).find((x) => String(x.id) === String(req.query.id));
  if (!f) throw fail(404, 'Filter not found');
  if (f.script_desc === SCRIPT_DESC) throw fail(400, 'This filter is managed by Rules and Automatic replies. Turn those off instead.');
  await mailcow.deleteFilter(f.id);
  res.json({ ok: true });
}));
