// Password-protected emails, for people on any email service.
//
// The real email (subject, text, attachments) is encrypted with a key made from the password the sender chose
// (scrypt + AES-256-GCM) and kept on our server. We don't keep the password, so we can't open it either. The
// recipient gets an email with a link and an optional hint, never the password; the sender sends the password
// separately (another email a few minutes later, a text message, or by phone). On the link's page the recipient
// types the password to read it, download attachments and reply securely.
//
// Safety: 5 wrong passwords lock it for 15 minutes, 20 lock it for good; it expires (1 to 30 days); the sender
// sees when it was opened and can revoke it at any time, which deletes the encrypted copy.
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import sanitizeHtml from 'sanitize-html';
import { config } from './config.js';
import { q, audit } from './db.js';
import { seal, unseal, requireAuth } from './session.js';
import { rateLimit } from './shared.js';
import { sendSystemMail } from './recovery.js';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { userTransport } from './imap.js';
import { checkSendQuota } from './abuse.js';
import { addJob } from './jobs.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const base = (req) => config.publicUrl || (process.env.NODE_ENV === 'production' ? '' : `${req.protocol}://${req.get('host')}`);
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const deriveKey = (password, salt) => new Promise((resolve, reject) => crypto.scrypt(String(password), salt, 32, SCRYPT, (e, k) => (e ? reject(e) : resolve(k))));

export function checkSecurePassword(pw) {
  const p = String(pw || '');
  if (p.length < 8) throw fail(400, 'Use a password of at least 8 characters for a protected email');
  if (p.length > 200) throw fail(400, 'That password is too long');
  return p;
}

/** Encrypt an outgoing email; returns the id. mail = nodemailer message (subject/html/text/attachments). */
export async function protectEmail(req, mail, { password, hint, days, hours, burn, linkKey, recipients }) {
  const content = JSON.stringify({
    subject: mail.subject || '', html: mail.html || '', text: mail.text || '',
    from: { name: req.user.name || '', address: req.user.email }, sentAt: Date.now(),
    attachments: (mail.attachments || []).map((a) => ({ filename: a.filename, contentType: a.contentType, data: Buffer.from(a.content).toString('base64') })),
  });
  if (content.length > 40 * 1024 * 1024) throw fail(413, 'Protected emails can be up to 25 MB');
  const salt = crypto.randomBytes(16); const iv = crypto.randomBytes(12);
  const key = await deriveKey(password, salt);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(content, 'utf8'), c.final()]);
  const id = crypto.randomBytes(16).toString('base64url');
  // self-destructing emails can last as little as an hour
  const expires = hours ? Date.now() + Math.min(24 * 30, Math.max(1, Number(hours))) * 3600e3 : Date.now() + Math.min(30, Math.max(1, Number(days) || 7)) * 864e5;
  await q.run(`INSERT INTO secure_messages(id, owner, sender_name, data, salt, iv, tag, hint, recipients, expires_at, created_at, attempts, revoked)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`, id, req.user.email, req.user.name || '', enc.toString('base64'), salt.toString('base64'), iv.toString('base64'),
  c.getAuthTag().toString('base64'), String(hint || '').slice(0, 200), JSON.stringify(recipients.slice(0, 100)), expires, Date.now());
  await q.run('UPDATE secure_messages SET data = NULL WHERE expires_at < ? AND data IS NOT NULL', Date.now()); // tidy up expired ones
  if (burn) await q.run('UPDATE secure_messages SET burn = 1 WHERE id = ?', id);
  await audit(req.user.email, null, 'secure.created', { id, recipients: recipients.length, selfDestruct: !!linkKey });
  // Self-destructing: the key travels in the link itself, after the # (browsers never send that part to the server)
  return { id, url: `${base(req)}/secure/${id}${linkKey ? `#k=${encodeURIComponent(password)}` : ''}`, expires, selfDestruct: !!linkKey, burn: !!burn };
}

/** The email the recipient actually receives: who, a link, the hint. Never the password or the content. */
export function noticeMail(mail, user, sec, hint) {
  const who = user.name ? `${user.name} (${user.email})` : user.email;
  if (sec.selfDestruct) {
    const when = sec.burn ? 'after you read it' : `on ${new Date(sec.expires).toUTCString().replace(/:\d\d GMT$/, ' UTC')}`;
    const text = `${who} sent you a private message that disappears ${when}.\n\nRead it here: ${sec.url}\n`;
    const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1f2937;max-width:520px">
<p><b>${esc(who)}</b> sent you a private message that disappears ${esc(when)}.</p>
<p style="margin:22px 0"><a href="${esc(sec.url)}" style="background:#7c3aed;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold;display:inline-block">&#9203; Read the message</a></p>
<p style="color:#6b7280;font-size:13px">Sent with Roammail. After that, it's gone for good.</p></div>`;
    return { ...mail, subject: `⏳ ${user.name || user.email} sent you a disappearing message`, html, text, attachments: [], headers: { ...(mail.headers || {}), 'X-Roammail-Secure-Id': sec.id } };
  }
  const until = new Date(sec.expires).toUTCString().replace(/ \d\d:\d\d:\d\d GMT$/, '');
  const text = `${who} sent you a password-protected email.\n\nOpen it here: ${sec.url}\n\nYou'll need the password, which ${user.name || 'they'} will send you separately.${hint ? `\nPassword hint: ${hint}` : ''}\n\nThis link works until ${until}.\n`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1f2937;max-width:520px">
<p><b>${esc(who)}</b> sent you a password-protected email.</p>
<p style="margin:22px 0"><a href="${esc(sec.url)}" style="background:#1d4ed8;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold;display:inline-block">&#128274; Open the protected email</a></p>
<p>You'll need the password, which ${esc(user.name || 'they')} will send you separately.${hint ? `<br>Password hint: <i>${esc(hint)}</i>` : ''}</p>
<p style="color:#6b7280;font-size:13px">This link works until ${esc(until)}. Sent securely with Roammail.</p></div>`;
  return { ...mail, subject: `🔒 ${user.name || user.email} sent you a protected email`, html, text, attachments: [], headers: { ...(mail.headers || {}), 'X-Roammail-Secure-Id': sec.id } };
}

// ---------------------------------------------------------------- sender: status, revoke, send the password
export const secureApi = express.Router();
secureApi.use('/secure', requireAuth);
const ownRow = async (req) => {
  const r = await q.get('SELECT * FROM secure_messages WHERE id = ? AND owner = ?', String(req.params.id), req.user.email);
  if (!r) throw fail(404, 'Protected email not found');
  return r;
};
secureApi.get('/secure/:id', wrap(async (req, res) => {
  const r = await ownRow(req);
  res.json({ id: r.id, url: `${base(req)}/secure/${r.id}`, openedAt: Number(r.opened_at) || null, opens: Number(r.opens || 0), expiresAt: Number(r.expires_at),
    expired: Number(r.expires_at) < Date.now(), revoked: !!r.revoked, locked: Number(r.attempts) >= 20, recipients: JSON.parse(r.recipients || '[]') });
}));
secureApi.post('/secure/:id/revoke', wrap(async (req, res) => {
  const r = await ownRow(req);
  await q.run('UPDATE secure_messages SET revoked = 1, data = NULL WHERE id = ?', r.id);
  await audit(req.user.email, null, 'secure.revoked', { id: r.id });
  res.json({ ok: true });
}));

// Send the password in its own email (no link in it), now or a few minutes later. We don't keep the password:
// the sender's app passes it once, for this email only.
secureApi.post('/secure/:id/send-password', rateLimit({ windowMs: 3600e3, limit: 30 }), wrap(async (req, res) => {
  const r = await ownRow(req);
  if (!live(r)) throw fail(410, 'This protected email has expired or was withdrawn');
  const password = checkSecurePassword(req.body.password);
  // it must be the right password: check it opens the email, without counting as an open
  try { await decrypt(r, password); } catch { throw fail(400, 'That isn’t the password this email was protected with'); }
  const to = JSON.parse(r.recipients || '[]');
  if (!to.length) throw fail(400, 'No recipients');
  await checkSendQuota(req.user.email, to.length);
  const mail = {
    from: req.user.name ? { name: req.user.name, address: req.user.email } : req.user.email, to: to.join(', '),
    subject: 'The password for my protected email',
    text: `Hi,\n\nHere's the password for the protected email I sent you:\n\n${password}\n\nOpen the other email and click "Open the protected email" to use it.\n`,
  };
  const delay = Math.min(60, Math.max(0, Number(req.body.delayMinutes) || 0));
  if (delay) {
    const raw = await new Promise((resolve, reject) => new MailComposer(mail).compile().build((e, m) => (e ? reject(e) : resolve(m))));
    await addJob(req.user, 'send', Date.now() + delay * 60e3, { raw: raw.toString('base64'), envelope: { from: req.user.email, to } }, { subject: mail.subject, to: mail.to });
  } else {
    await userTransport(nodemailer, req.user).sendMail(mail);
  }
  await audit(req.user.email, null, 'secure.password_sent', { id: r.id, delay });
  res.json({ ok: true, scheduled: !!delay });
}));

// ---------------------------------------------------------------- recipient (public)
export const securePublic = express.Router();
const tries = rateLimit({ windowMs: 15 * 60e3, limit: 30, standardHeaders: true, legacyHeaders: false });
const SAFE_HTML = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'span', 'font', 'center', 'h1', 'h2', 'h5', 'h6']),
  allowedAttributes: { a: ['href', 'title'], img: ['src', 'alt', 'width', 'height'], '*': ['style', 'align', 'width', 'bgcolor', 'colspan', 'rowspan', 'valign'] },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'], allowedSchemesByTag: { img: ['data'] }, // no remote images: they'd tell the sender's tracker when it's read
};
const live = (r) => r && !r.revoked && r.data && Number(r.expires_at) > Date.now();

securePublic.get('/public/secure/:id', tries, wrap(async (req, res) => {
  const r = await q.get('SELECT * FROM secure_messages WHERE id = ?', String(req.params.id));
  if (!r) throw fail(404, 'This protected email doesn’t exist');
  res.json({ from: r.sender_name || r.owner, address: r.owner, hint: r.hint || '', expiresAt: Number(r.expires_at),
    state: r.revoked ? 'revoked' : Number(r.expires_at) < Date.now() || !r.data ? 'expired' : Number(r.attempts) >= 20 ? 'locked' : Number(r.locked_until || 0) > Date.now() ? 'wait' : 'ok' });
}));

async function decrypt(r, password) {
  const key = await deriveKey(password, Buffer.from(r.salt, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(r.iv, 'base64'));
  d.setAuthTag(Buffer.from(r.tag, 'base64'));
  return { content: JSON.parse(Buffer.concat([d.update(Buffer.from(r.data, 'base64')), d.final()]).toString('utf8')), key };
}
async function openWith(id, { password, token }) {
  const r = await q.get('SELECT * FROM secure_messages WHERE id = ?', String(id));
  if (!live(r)) throw fail(410, 'This protected email has expired or was withdrawn by the sender');
  if (token) {
    const t = unseal(String(token));
    if (!t || t.t !== 'sec' || t.id !== r.id || t.exp < Date.now()) throw fail(401, 'Please enter the password again');
    const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(t.k, 'base64'), Buffer.from(r.iv, 'base64'));
    d.setAuthTag(Buffer.from(r.tag, 'base64'));
    return { r, content: JSON.parse(Buffer.concat([d.update(Buffer.from(r.data, 'base64')), d.final()]).toString('utf8')), key: Buffer.from(t.k, 'base64') };
  }
  if (Number(r.attempts) >= 20) throw fail(423, 'Too many wrong passwords. Ask the sender to send it again.');
  if (Number(r.locked_until || 0) > Date.now()) throw fail(429, 'Too many wrong passwords. Try again in 15 minutes.');
  try {
    const { content, key } = await decrypt(r, password);
    await q.run('UPDATE secure_messages SET opened_at = COALESCE(opened_at, ?), opens = COALESCE(opens, 0) + 1 WHERE id = ?', Date.now(), r.id);
    // burn after reading: 10 minutes to read it and download attachments, then it's gone
    if (Number(r.burn) === 1 && !r.opened_at) await q.run('UPDATE secure_messages SET expires_at = ? WHERE id = ? AND expires_at > ?', Date.now() + 10 * 60e3, r.id, Date.now() + 10 * 60e3);
    if (!r.opened_at) {
      await sendSystemMail(r.owner, 'Your protected email was opened', `<p>Your protected email "${esc(content.subject)}" was opened just now.</p><p>You can withdraw it any time from the email in your Sent folder.</p>`).catch(() => {});
    }
    return { r, content, key };
  } catch {
    const n = Number(r.attempts || 0) + 1;
    await q.run('UPDATE secure_messages SET attempts = ?, locked_until = ? WHERE id = ?', n, n % 5 === 0 ? Date.now() + 15 * 60e3 : r.locked_until || null, r.id);
    throw fail(401, n >= 20 ? 'Too many wrong passwords. Ask the sender to send it again.' : 'That password isn’t right');
  }
}

securePublic.post('/public/secure/:id/open', tries, wrap(async (req, res) => {
  const { r, content, key } = await openWith(req.params.id, { password: String(req.body.password || '') });
  res.json({
    subject: content.subject, from: content.from, sentAt: content.sentAt, expiresAt: Number(r.expires_at),
    html: content.html ? sanitizeHtml(content.html, SAFE_HTML) : '', text: content.text,
    attachments: content.attachments.map((a, i) => ({ index: i, filename: a.filename, contentType: a.contentType, size: Math.round(a.data.length * 0.75) })),
    // lets this browser download the attachments and reply for 30 minutes without the password travelling again
    token: seal({ t: 'sec', id: r.id, k: key.toString('base64'), exp: Date.now() + 30 * 60e3 }),
  });
}));

securePublic.post('/public/secure/:id/attachment', tries, wrap(async (req, res) => {
  const { content } = await openWith(req.params.id, { token: req.body.token });
  const a = content.attachments[Number(req.body.index)];
  if (!a) throw fail(404, 'Attachment not found');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(a.filename || 'attachment')}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.type('application/octet-stream').send(Buffer.from(a.data, 'base64')); // always a download, never shown in the page
}));

securePublic.post('/public/secure/:id/reply', rateLimit({ windowMs: 3600e3, limit: 10 }), wrap(async (req, res) => {
  const { r, content } = await openWith(req.params.id, { token: req.body.token });
  const text = String(req.body.text || '').trim().slice(0, 20000);
  if (!text) throw fail(400, 'Write a reply first');
  const replies = Number(r.replies || 0);
  if (replies >= 10) throw fail(429, 'You’ve sent the most replies allowed for this email');
  await q.run('UPDATE secure_messages SET replies = ? WHERE id = ?', replies + 1, r.id);
  const who = JSON.parse(r.recipients || '[]').join(', ') || 'the recipient';
  await sendSystemMail(r.owner, `Secure reply: ${content.subject}`, `<p>Reply from ${esc(who)} to your protected email "${esc(content.subject)}":</p><blockquote style="border-left:3px solid #1d4ed8;padding-left:10px;white-space:pre-wrap">${esc(text)}</blockquote>`, text);
  res.json({ ok: true });
}));

// The page itself
const here = path.dirname(fileURLToPath(import.meta.url));
const PAGE = fs.readFileSync(path.join(here, 'securepage', 'index.html'), 'utf8');
export const securePages = express.Router();
securePages.get('/secure-assets/:file', (req, res) => {
  if (!/^(secure\.js|secure\.css)$/.test(req.params.file)) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.sendFile(path.join(here, 'securepage', req.params.file));
});
securePages.get('/secure/:id', (req, res) => {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Robots-Tag', 'noindex'); res.setHeader('Referrer-Policy', 'no-referrer');
  res.type('html').send(PAGE.replaceAll('{{APP}}', esc(config.appName || 'Roammail')));
});
