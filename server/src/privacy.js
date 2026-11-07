// Privacy & legal: mail export (mbox), account deletion, legal pages, security.txt, log retention.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { q, audit } from './db.js';
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

const DOCS = {
  terms: 'Terms of Service',
  privacy: 'Privacy Policy',
  'acceptable-use': 'Acceptable Use Policy',
  security: 'Security & Responsible Disclosure',
};

function body(doc) {
  const L = config.legal; const app = esc(config.appName); const co = esc(L.company);
  const mail = (a) => (a ? `<a href="mailto:${esc(a)}">${esc(a)}</a>` : 'our support team');
  switch (doc) {
    case 'terms': return `
<p>These terms apply to your use of ${app}, operated by ${co} ("we"). By creating or using an account you agree to them.</p>
<h2>Your account</h2><ul><li>You must be at least 16 years old (or the age of digital consent where you live).</li>
<li>Keep your password safe and turn on 2-step verification. You're responsible for activity on your account.</li>
<li>Free accounts are for personal use and have limits on storage and sending. Business accounts are managed by the business's administrators, who can create, suspend and delete their users' mailboxes.</li></ul>
<h2>Acceptable use</h2><p>You must follow our <a href="/legal/acceptable-use">Acceptable Use Policy</a>. We may limit, suspend or close accounts that break it, especially for spam, phishing or malware.</p>
<h2>Your content</h2><p>Your email belongs to you. We store and process it only to provide the service (for example: delivering mail, filtering spam and viruses, search, backups). See our <a href="/legal/privacy">Privacy Policy</a>.</p>
<h2>Availability</h2><p>We work hard to keep the service running and your data safe, with encrypted storage and daily backups, but the service is provided "as is" without guarantees of uninterrupted availability. Keep copies of anything critical; you can download all your mail at any time (Settings → Privacy).</p>
<h2>Ending your account</h2><p>You can delete a free account at any time in Settings → Privacy. Inactive free accounts may be closed after 12 months of no sign-ins, after a warning email.</p>
<h2>Liability</h2><p>To the extent permitted by law, ${co} is not liable for indirect or consequential losses. Nothing in these terms limits rights you have under consumer law.</p>
<h2>Changes</h2><p>We'll announce material changes in advance. Version: ${esc(L.termsVersion)}. Governing law: ${esc(L.country)}.</p>
<h2>Contact</h2><p>${mail(L.contact)}</p>`;
    case 'privacy': return `
<p>This policy explains what ${co} ("we") collects when you use ${app}, and why.</p>
<h2>What we store</h2><ul>
<li><b>Your email and folders</b>, to provide the service. Stored encrypted on our servers.</li>
<li><b>Account details</b>: your name, address, optional recovery email, and (for business users) job title and phone numbers set by your administrator.</li>
<li><b>Security records</b>: sign-in times, IP addresses and device type, kept for ${L.retentionDays} days to protect your account and investigate abuse.</li>
<li><b>Settings</b> such as signatures, rules and spam preferences.</li></ul>
<h2>What we don't do</h2><ul><li>We don't sell your data or show ads.</li><li>We don't read your email. Automated systems scan messages only to filter spam and viruses.</li>
<li>Remote images in emails are blocked until you allow them, so senders can't track when you open their messages.</li></ul>
<h2>Who processes data for us</h2><p>Our servers run on Amazon Web Services. If enabled, password checks use the Have I Been Pwned range API, which only receives the first 5 characters of a hashed password, and the sign-up check uses Cloudflare Turnstile.</p>
<h2>Business accounts</h2><p>If your address belongs to a business, that business is the data controller for your mailbox and its administrators can manage it.</p>
<h2>Your rights</h2><p>You can download all your mail (Settings → Privacy → Download), correct your details, and delete a free account at any time. For other requests contact ${mail(L.contact)}. Depending on where you live (for example under GDPR or CCPA) you may also complain to your data protection authority.</p>
<h2>Retention</h2><p>Deleted accounts are removed from live systems immediately and from backups within 30 days. Security logs are deleted after ${L.retentionDays} days.</p>`;
    case 'acceptable-use': return `
<p>To keep ${app} safe and our mail trusted by other providers, you must not use it to:</p>
<ul><li>Send spam, bulk unsolicited mail, or mail to purchased or scraped lists.</li>
<li>Send phishing, scams, malware, or impersonate other people or organizations.</li>
<li>Harass, threaten or abuse anyone, or send illegal content.</li>
<li>Try to break into other accounts or our systems, or get around sending limits.</li></ul>
<p>Free accounts have daily sending limits, and new accounts start lower. We may suspend accounts that cause spam complaints or blocklistings, sometimes automatically.</p>
<h2>Reporting abuse</h2><p>Report spam or phishing sent from our service to ${mail(L.abuse)}. Please include the full message headers.</p>`;
    case 'security': return `
<p>We take the security of ${app} and your data seriously. Highlights:</p>
<ul><li>All connections use HTTPS/TLS; data and backups are encrypted at rest.</li>
<li>2-step verification (authenticator app) with backup codes; administrators are required to use it.</li>
<li>Email content is sanitized and shown in an isolated frame; remote content is blocked by default.</li>
<li>Passwords are checked against known data breaches; repeated failed sign-ins are throttled.</li>
<li>You can see and sign out your devices and get alerts about sign-ins from new devices.</li></ul>
<h2>Reporting a vulnerability</h2><p>Please email ${mail(L.security)} with details and steps to reproduce. We'll acknowledge within 3 business days and keep you updated. Please give us reasonable time to fix issues before disclosure, don't access other people's data, and don't degrade the service. We won't take legal action against good-faith research that follows these rules.</p>`;
    default: return '';
  }
}

legalPages.get('/legal/:doc', (req, res) => {
  const doc = req.params.doc;
  if (!DOCS[doc]) return res.status(404).send('Not found');
  // Operators can replace any page with their own lawyer-reviewed HTML: DATA_DIR/legal/<doc>.html
  const custom = path.join(config.dataDir, 'legal', `${doc}.html`);
  const content = fs.existsSync(custom) ? fs.readFileSync(custom, 'utf8') : body(doc);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(DOCS[doc])} · ${esc(config.appName)}</title><link rel="icon" href="/favicon.png">
<style>body{margin:0;font:16px/1.6 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#242424;background:#f5f5f5}
main{max-width:760px;margin:0 auto;padding:32px 22px 60px;background:#fff;min-height:100vh}h1{font-size:28px;margin:0 0 4px}
h2{font-size:18px;margin:26px 0 6px}a{color:#244960}nav{font-size:14px;margin-bottom:24px}nav a{margin-right:14px}.muted{color:#666;font-size:14px}</style></head>
<body><main><a href="/"><img src="/roammail-logo.png" alt="${esc(config.appName)}" style="width:180px;height:auto;margin-bottom:10px"></a><nav><a href="/">← Back to ${esc(config.appName)}</a>${Object.entries(DOCS).map(([k, v]) => `<a href="/legal/${k}">${esc(v)}</a>`).join('')}</nav>
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
  audit(req.user.email, null, 'privacy.export', { ip: req.ip });
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
  const k = accountKind(req.user.email);
  if (k.business) throw fail(403, 'Business mailboxes are managed by your organization. Ask your administrator to remove your account.');
  if (String(req.body.confirm || '') !== 'DELETE') throw fail(400, 'Type DELETE to confirm');
  const c = makeClient({ email: req.user.email, password: String(req.body.password || '') });
  try { await c.connect(); await c.logout(); } catch { throw fail(401, 'Wrong password'); }
  const owns = q.get('SELECT 1 FROM orgs WHERE owner_email = ?', req.user.email);
  if (owns) throw fail(400, 'You own a business on this service. Transfer or remove it first (Admin → Domains).');
  await closeClient(req.user.sid);
  await mailcow.deleteMailbox(req.user.email);
  const e = req.user.email;
  for (const t of ['user_security', 'user_settings', 'user_signatures', 'profiles', 'jobs', 'password_resets', 'setup_tokens']) q.run(`DELETE FROM ${t} WHERE email = ?`, e);
  q.run('DELETE FROM members WHERE email = ?', e);
  q.run("UPDATE signups SET recovery_email = NULL WHERE email = ?", e); // keep the row for sign-up abuse limits only
  revokeSessions(e);
  audit(e, null, 'account.deleted', { ip: req.ip });
  clearSession(req, res);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- retention
export function startRetention() {
  const run = () => {
    const d = `-${config.legal.retentionDays} days`;
    q.run("DELETE FROM login_events WHERE at < datetime('now', ?)", d);
    q.run("DELETE FROM audit WHERE at < datetime('now', '-400 days')");
    q.run('DELETE FROM password_resets WHERE expires < ?', Date.now());
    q.run('DELETE FROM setup_tokens WHERE expires < ?', Date.now());
    q.run("DELETE FROM signups WHERE created_at < datetime('now', '-400 days')");
  };
  run();
  setInterval(run, 6 * 3600e3).unref();
}
