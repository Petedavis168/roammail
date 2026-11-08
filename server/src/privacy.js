import { LEGAL_DOCS, legalBody } from './legaltext.js';
// Privacy & legal: mail export (mbox), account deletion, legal pages, security.txt, log retention.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { q, audit, setting } from './db.js';
import { requireAuth, revokeSessions, clearSession } from './session.js';
import { makeClient, closeClient } from './imap.js';
import { mailcow } from './mailcow.js';
import { accountKind } from './abuse.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------- public pages
export const legalPages = express.Router();

legalPages.get('/.well-known/security.txt', (req, res) => {
  const expires = new Date(Date.now() + 300 * 864e5).toISOString();
  const base = config.publicUrl || `${req.protocol}://${req.get('host')}`;
  res.type('text/plain').send([
    config.legal.security && `Contact: mailto:${config.legal.security}`,
    config.legal.abuse && `Contact: mailto:${config.legal.abuse}`,
    `Expires: ${expires}`,
    `Policy: ${base}/legal/security`,
    'Preferred-Languages: en',
    `Canonical: ${base}/.well-known/security.txt`,
  ].filter(Boolean).join('\n') + '\n');
});

const DOCS = LEGAL_DOCS;
const body = legalBody;

legalPages.get('/legal/:doc', async (req, res) => {
  const doc = req.params.doc;
  if (!DOCS[doc]) return res.status(404).send('Not found');
  // Operators can replace any page with their own lawyer-reviewed HTML: DATA_DIR/legal/<doc>.html,
  // or (several servers) the setting legal:<doc> in the database
  const custom = path.join(config.dataDir, 'legal', `${doc}.html`);
  const stored = await setting(`legal:${doc}`, null);
  const content = stored || (fs.existsSync(custom) ? fs.readFileSync(custom, 'utf8') : body(doc));
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(DOCS[doc])} · ${esc(config.appName)}</title><link rel="icon" href="/favicon.png">
<style>table{border-collapse:collapse;width:100%;margin:10px 0;font-size:14px}th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top;overflow-wrap:anywhere}@media(max-width:600px){table{font-size:13px}th,td{padding:5px}}th{background:#f0f3f6}body{margin:0;font:16px/1.6 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#242424;background:#f5f5f5}
main{max-width:760px;margin:0 auto;padding:32px 22px 60px;background:#fff;min-height:100vh}h1{font-size:28px;margin:0 0 4px}
h2{font-size:18px;margin:26px 0 6px}a{color:#244960}nav{font-size:14px;margin-bottom:24px}nav a{margin-right:14px}.muted{color:#666;font-size:14px}</style></head>
<body><main><a href="/" style="display:flex;align-items:center;gap:10px;text-decoration:none;color:#0a1e2e;font:700 22px Georgia,serif;margin-bottom:12px"><img src="/roammail-mark.png" alt="" style="width:40px;height:auto">${esc(config.appName)}</a><nav><a href="/">← Back to ${esc(config.appName)}</a>${Object.entries(DOCS).map(([k, v]) => `<a href="/legal/${k}">${esc(v)}</a>`).join('')}</nav>
<h1>${esc(DOCS[doc])}</h1><p class="muted">${esc(config.legal.company)} · Version ${esc(config.legal.termsVersion)}</p>${content}</main></body></html>`);
});

// ---------------------------------------------------------------- export & deletion
export const privacy = express.Router();
privacy.use(requireAuth);

/** Download every folder as one standard mbox file (importable into Gmail/Thunderbird/Apple Mail). */
privacy.get('/export', wrap(async (req, res) => {
  const client = makeClient(req.user); // dedicated connection so the export doesn't block the UI
  await client.connect();
  const name = `${req.user.email.replace(/[^\w.@-]/g, '')}-${new Date().toISOString().slice(0, 10)}.mbox`;
  res.setHeader('Content-Type', 'application/mbox');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  await audit(req.user.email, null, 'privacy.export', { ip: req.ip });
  let aborted = false;
  req.on('close', () => { aborted = true; });
  try {
    const folders = (await client.list()).filter((f) => !f.flags.has?.('\\Noselect') && !(f.flags || []).includes?.('\\Noselect'));
    for (const f of folders) {
      if (aborted) break;
      const lock = await client.getMailboxLock(f.path, { readOnly: true });
      try {
        if (!client.mailbox.exists) continue;
        for await (const m of client.fetch('1:*', { source: true, internalDate: true, envelope: true })) {
          if (aborted) break;
          const from = (m.envelope?.from?.[0]?.address || 'MAILER-DAEMON').replace(/\s/g, '');
          const date = (m.internalDate || new Date()).toUTCString().replace(/,/g, '');
          // mboxrd: escape lines that look like "From " separators
          const src = m.source.toString('binary').replace(/\r\n/g, '\n').replace(/^(>*From )/gm, '>$1');
          const ok = res.write(`From ${from} ${date}\nX-Folder: ${f.path}\n${src}${src.endsWith('\n') ? '' : '\n'}\n`, 'binary');
          if (!ok) await new Promise((r) => res.once('drain', r));
        }
      } finally { lock.release(); }
    }
  } finally {
    res.end();
    client.logout().catch(() => {});
  }
}));

privacy.post('/account/delete', wrap(async (req, res) => {
  const k = await accountKind(req.user.email);
  if (k.business) throw fail(403, 'Business mailboxes are managed by your organization. Ask your administrator to remove your account.');
  if (String(req.body.confirm || '') !== 'DELETE') throw fail(400, 'Type DELETE to confirm');
  const c = makeClient({ email: req.user.email, password: String(req.body.password || '') });
  try { await c.connect(); await c.logout(); } catch { throw fail(401, 'Wrong password'); }
  const owns = await q.get('SELECT 1 FROM orgs WHERE owner_email = ?', req.user.email);
  if (owns) throw fail(400, 'You own a business on this service. Transfer or remove it first (Admin → Domains).');
  await closeClient(req.user.sid);
  await mailcow.deleteMailbox(req.user.email);
  const e = req.user.email;
  for (const t of ['user_security', 'user_settings', 'user_signatures', 'profiles', 'jobs', 'password_resets', 'setup_tokens', 'tasks', 'notes', 'followups']) await q.run(`DELETE FROM ${t} WHERE email = ?`, e);
  await q.run('DELETE FROM members WHERE email = ?', e);
  await q.run("UPDATE signups SET recovery_email = NULL WHERE email = ?", e); // keep the row for sign-up abuse limits only
  await revokeSessions(e);
  await audit(e, null, 'account.deleted', { ip: req.ip });
  await clearSession(req, res);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- retention
export async function startRetention() {
  const run = async () => {
    const d = `-${config.legal.retentionDays} days`;
    await q.run("DELETE FROM login_events WHERE at < datetime('now', ?)", d);
    await q.run("DELETE FROM audit WHERE at < datetime('now', '-400 days')");
    await q.run('DELETE FROM password_resets WHERE expires < ?', Date.now());
    await q.run('DELETE FROM setup_tokens WHERE expires < ?', Date.now());
    await q.run("DELETE FROM signups WHERE created_at < datetime('now', '-400 days')");
    const twoYears = Date.now() - 730 * 864e5;
    await q.run("DELETE FROM support_tickets WHERE status = 'closed' AND at < ?", twoYears);
    await q.run("DELETE FROM abuse_reports WHERE status = 'closed' AND at < ?", twoYears);
    await q.run('DELETE FROM push_subs WHERE created_at < ?', Date.now() - 30 * 864e5);
  };
  await run();
  setInterval(() => run().catch((e) => console.error('APP_ERROR retention', e.message)), 6 * 3600e3).unref();
}
