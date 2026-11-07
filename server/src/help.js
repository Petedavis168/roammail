// Help centre (/help) and contact-support form. Plain pages, no scripts, readable without signing in.
import express from 'express';
import { config } from './config.js';
import { q, audit, rolesFor } from './db.js';
import { requireAuth } from './session.js';
import { rateLimit } from './shared.js';
import { sendSystemMail } from './recovery.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const APP = () => config.appName;

// Articles: [slug, title, category, html]. Kept short and in plain English.
const ARTICLES = () => [
  ['get-started', 'Getting started', 'Basics', `<p>Welcome to ${APP()}! A few things worth doing first:</p><ol>
<li><b>Add a recovery email</b> and <b>turn on 2-step verification</b> in Settings → Security. They're your way back in if you forget your password or lose your phone.</li>
<li><b>Set up your phone</b> in Settings → Phone &amp; apps. Scan the QR code and your mail, calendar and contacts set themselves up.</li>
<li><b>Make a signature</b> in Settings → Signatures.</li></ol>
<p>Keyboard fans: press <kbd>?</kbd> in your inbox to see shortcuts.</p>`],
  ['phone', 'Set up mail on your phone or computer', 'Basics', `<p>Go to <b>Settings → Phone &amp; apps</b>.</p><ul>
<li><b>iPhone / iPad / Mac:</b> scan the QR code with the camera, tap the link, then open Settings → "Profile Downloaded" → Install. Mail, calendar and contacts are all set up.</li>
<li><b>Android:</b> use the Gmail or Outlook app → Add account → "Other" and enter the details shown on that page.</li>
<li><b>Outlook / Thunderbird on a computer:</b> add an account with your email and password. They find the settings automatically.</li></ul>
<p>If you use 2-step verification, phones and desktop apps sign in with your normal password. Only the web sign-in asks for the code.</p>`],
  ['forgot-password', 'Forgot your password or lost your phone', 'Account', `<ul>
<li><b>Forgot password:</b> on the sign-in page, choose "Forgot password?". We email a reset link to your verified recovery email. It works for 30 minutes.</li>
<li><b>Forgot your email address:</b> choose "Forgot email?" and enter your recovery email. We'll send you the addresses linked to it.</li>
<li><b>Lost your phone (2-step verification):</b> use one of your backup codes. No backup codes? After entering your password, choose "Lost your phone?". For your safety we turn 2-step verification off after 72 hours, and email you a link to cancel if it wasn't you.</li>
<li><b>Business accounts:</b> your administrator can reset your password or 2-step verification in Admin → Users.</li></ul>`],
  ['business-domain', 'Use your own business domain', 'Business', `<p>Choose <b>Business email</b> in the app and follow the steps:</p><ol>
<li>Enter your domain (for example yourcompany.com).</li>
<li>Add the DNS records we show you at your domain provider (GoDaddy, Namecheap, Cloudflare, …). We check them for you and say which are missing.</li>
<li>Choose a plan (or enter your Friendly Web Services customer code), then add your people.</li></ol>
<p>Each record has a job: <b>MX</b> sends your mail to us, <b>SPF</b> and <b>DKIM</b> prove mail from us is really from you, and <b>DMARC</b> tells Gmail and Outlook to reject fakes. Together they keep your mail out of spam folders.</p>`],
  ['billing', 'Plans, billing and invoices', 'Business', `<ul>
<li>Business email is <b>$${config.billing.perUserMonthly} per person per month</b>, or $${config.billing.perUserYearly} per person per year. Friendly Web Services customers get their first mailbox free.</li>
<li>Shared mailboxes (like support@) and the company archive are free.</li>
<li>Adding a person adds a seat right away (prorated). Removing someone lowers your next bill.</li>
<li>Receipts are emailed to your admins. Invoices, card changes, switching to yearly and cancelling are all in <b>Admin → Billing → Manage billing</b>.</li>
<li>If a payment fails, we email you and try again. Accounts are only paused ${config.billing.graceDays} days after a subscription ends, and nothing is deleted.</li></ul>`],
  ['users', 'Add people, groups and shared mailboxes', 'Business', `<ul>
<li><b>One person:</b> Admin → Users → Add user. Show them the QR code to set up their phone in seconds.</li>
<li><b>Many people:</b> Admin → Users → Import from spreadsheet. Download the template, fill it in, upload it.</li>
<li><b>Groups and distribution lists:</b> Admin → Groups. A group (e.g. sales@) delivers to all its members. Department groups update themselves when people join or leave.</li>
<li><b>Shared mailboxes:</b> Admin → Shared mailboxes. One inbox (e.g. support@) that several people read and answer from. Free.</li></ul>`],
  ['spam', 'Junk, spam and blocking senders', 'Mail', `<ul>
<li>Likely spam goes to your <b>Junk</b> folder. Obvious spam and viruses are held in <b>Spam quarantine</b> (in the folder list) so they can't harm you.</li>
<li>Something good in Junk? Open it and choose <b>Not junk</b>. That teaches the filter and moves it to your inbox.</li>
<li>Block a sender from any message (⋯ → Block). Set how strict filtering is in Settings → Junk &amp; spam.</li>
<li>Getting spam <i>from</i> a ${APP()} address? <a href="/abuse">Report it here</a>.</li></ul>`],
  ['archive', 'Company archive and legal hold', 'Business', `<p>Admin → Archive &amp; legal hold keeps a copy of every message sent and received by your whole business, or just by chosen people.
Copies go to an archive that nobody can delete from, readable only by people you pick. It starts when you switch it on. Let your staff know it's on.</p>`],
  ['security', 'Keeping your account safe', 'Account', `<ul>
<li>Turn on <b>2-step verification</b> (Settings → Security). It stops almost all account takeovers.</li>
<li>Use a password you don't use anywhere else. We won't accept passwords that have appeared in known data breaches.</li>
<li>Check <b>Settings → Security → Your devices</b> now and then, and sign out anything you don't recognise.</li>
<li>We will <b>never</b> ask for your password by email. Look for the red warning banner on suspicious messages.</li></ul>`],
  ['status', 'Is something down?', 'Help', `<p>Check the <a href="/status">status page</a>. It shows whether sending, receiving and the app are working right now, plus any planned maintenance.</p>`],
];

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · ${esc(APP())} Help</title><link rel="icon" href="/favicon.png">
<style>body{font-family:Segoe UI,Arial,sans-serif;margin:0;color:#242424;line-height:1.55}header{background:#0a1e2e;color:#fff;padding:14px 24px;display:flex;align-items:center;gap:10px}header a{color:#fff;text-decoration:none;font-weight:600}main{max-width:760px;margin:0 auto;padding:24px}h1{color:#244960}a{color:#244960}.cat{color:#888;font-size:12px;text-transform:uppercase;letter-spacing:.05em;margin-top:22px}ul.list{list-style:none;padding:0}ul.list li{padding:8px 0;border-bottom:1px solid #eee}label{display:block;margin:12px 0 4px;font-weight:600}input,textarea,select{width:100%;box-sizing:border-box;padding:9px;border:1px solid #bbb;border-radius:6px;font:inherit}button{margin-top:14px;background:#244960;color:#fff;border:0;border-radius:6px;padding:10px 18px;font:inherit;cursor:pointer}.box{background:#f3f6f9;border-radius:10px;padding:16px 20px;margin:24px 0}kbd{border:1px solid #ccc;border-radius:3px;padding:0 4px}</style></head>
<body><header><img src="/roammail-mark-white.png" alt="" height="28"><a href="/help">${esc(APP())} Help</a><span style="flex:1"></span><a href="/">Open ${esc(APP())}</a></header><main>${body}</main></body></html>`;

export const help = express.Router();
help.get('/help', (req, res) => {
  const cats = {};
  for (const [slug, title, cat] of ARTICLES()) (cats[cat] ||= []).push(`<li><a href="/help/${slug}">${esc(title)}</a></li>`);
  res.set('Cache-Control', 'public, max-age=600').type('html').send(page('Help', `<h1>How can we help?</h1>
${Object.entries(cats).map(([c, l]) => `<div class="cat">${esc(c)}</div><ul class="list">${l.join('')}</ul>`).join('')}
<div class="box"><b>Still stuck?</b> <a href="/help/contact">Contact support</a>. We usually reply within one business day.</div>`));
});
help.get('/help/contact', (req, res) => res.type('html').send(page('Contact support', `<h1>Contact support</h1>
<p>Tell us what's going on and we'll get back to you by email. If you can't sign in, give an address we can reach you at.</p>
<form method="post" action="/help/contact">
<label>Your email</label><input name="email" type="email" required maxlength="200">
<label>Your ${esc(APP())} address (if different)</label><input name="account" type="email" maxlength="200">
<label>Topic</label><select name="topic"><option>Can't sign in</option><option>Setting up a device</option><option>Business domain or DNS</option><option>Billing</option><option>Missing or delayed mail</option><option>Something else</option></select>
<label>What happened?</label><textarea name="message" rows="6" required maxlength="5000"></textarea>
<button>Send</button></form>
<p style="color:#666;font-size:13px">Never include your password. We'll never ask for it.</p>`)));
help.get('/help/:slug', (req, res) => {
  const a = ARTICLES().find((x) => x[0] === req.params.slug);
  if (!a) return res.status(404).type('html').send(page('Not found', '<h1>Article not found</h1><p><a href="/help">All help articles</a></p>'));
  res.set('Cache-Control', 'public, max-age=600').type('html').send(page(a[1], `<p><a href="/help">← All help</a></p><h1>${esc(a[1])}</h1>${a[3]}<div class="box">Didn't answer your question? <a href="/help/contact">Contact support</a>.</div>`));
});

const ticketLimit = rateLimit({ windowMs: 3600e3, limit: 5 });
help.post('/help/contact', ticketLimit, express.urlencoded({ extended: false, limit: '20kb' }), wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const account = String(req.body.account || '').trim().toLowerCase();
  const message = String(req.body.message || '').trim().slice(0, 5000);
  const topic = String(req.body.topic || 'Something else').slice(0, 60);
  if (!EMAIL_RE.test(email) || !message) return res.status(400).type('html').send(page('Not sent', '<h1>Not sent</h1><p>Please give your email and a message. <a href="/help/contact">Go back</a></p>'));
  const id = await q.insert('INSERT INTO support_tickets(email, account, topic, message, ip, at) VALUES(?, ?, ?, ?, ?, ?)',
    email, EMAIL_RE.test(account) ? account : null, topic, message, req.ip, Date.now());
  if (config.legal.contact) {
    await sendSystemMail(config.legal.contact, `[Support #${id}] ${topic}`, `<p><b>From:</b> ${esc(email)}${account ? ` (account ${esc(account)})` : ''}</p><p style="white-space:pre-wrap">${esc(message)}</p>`).catch(() => {});
  }
  await sendSystemMail(email, `We got your message (#${id})`, `<p>Thanks for contacting ${esc(APP())} support. We usually reply within one business day.</p><p style="white-space:pre-wrap;color:#555">${esc(message.slice(0, 1000))}</p><p>We'll never ask for your password.</p>`).catch(() => {});
  res.type('html').send(page('Sent', `<h1>Thanks, we got it</h1><p>Your reference is <b>#${id}</b>. We've emailed you a copy.</p><p><a href="/help">Back to help</a></p>`));
}));

// Super-admin view of support requests
help.get('/api/super/tickets', requireAuth, wrap(async (req, res) => {
  if (!(await rolesFor(req.user.email)).superAdmin) throw fail(403, 'Super-admin only');
  res.json(await q.all("SELECT id, email, account, topic, message, at, status FROM support_tickets WHERE status = 'open' ORDER BY at DESC LIMIT 200"));
}));
help.post('/api/super/tickets/:id/close', requireAuth, wrap(async (req, res) => {
  if (!(await rolesFor(req.user.email)).superAdmin) throw fail(403, 'Super-admin only');
  await q.run("UPDATE support_tickets SET status = 'closed' WHERE id = ?", Number(req.params.id));
  await audit(req.user.email, null, 'support.ticket_closed', { id: Number(req.params.id) });
  res.json({ ok: true });
}));
