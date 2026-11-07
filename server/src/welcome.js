// A friendly getting-started email placed in every new mailbox.
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { config } from './config.js';
import { makeClient } from './imap.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export async function deliverWelcome({ email, password, name, company }) {
  const app = config.publicUrl || '';
  const first = esc((name || '').split(/\s+/)[0] || 'there');
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#242424;max-width:600px">
  ${app ? `<img src="${esc(app)}/roammail-mark.png" alt="Roammail" width="48" style="width:48px;height:auto;margin-bottom:6px">` : ''}
  <h2 style="color:#244960;margin-bottom:4px">Welcome to ${esc(company || config.appName)}, ${first}!</h2>
  <p>Your new address is <b>${esc(email)}</b>. Here's how to get the most out of it:</p>
  <h3 style="margin-bottom:4px">🔒 Secure your account (2 minutes)</h3>
  <ol><li>Open <b>Settings → Security</b> and turn on <b>2-step verification</b>.</li>
  <li>Add a <b>recovery email</b> so you can reset your password if you forget it.</li></ol>
  <h3 style="margin-bottom:4px">📥 Bring your old email</h3>
  <p>Go to <b>Settings → Import mail</b> to copy everything from Gmail, Outlook, Yahoo or iCloud. It keeps syncing until you switch off the old account.</p>
  <h3 style="margin-bottom:4px">📱 Use it on your phone or in Outlook</h3>
  ${app ? `<p><a href="${esc(app)}/setup?email=${encodeURIComponent(email)}" style="background:#244960;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">Set up on my phone</a></p>
  <p style="color:#616161;font-size:13px">On iPhone it installs in two taps. On Android it shows the easiest app for you. Or scan the QR code in <b>Settings → Phone &amp; apps</b>.</p>` : ''}
  <table cellpadding="4" style="border-collapse:collapse;font-size:13px">
    <tr><td style="color:#616161">Incoming (IMAP)</td><td><b>${esc(config.imap.host)}</b>, port ${config.imap.port}, SSL</td></tr>
    <tr><td style="color:#616161">Outgoing (SMTP)</td><td><b>${esc(config.smtp.host)}</b>, port ${config.smtp.port}, ${config.smtp.secure ? 'SSL' : 'STARTTLS'}</td></tr>
    <tr><td style="color:#616161">Username</td><td>${esc(email)}</td></tr></table>
  <p>Most apps set themselves up automatically when you enter your email and password.</p>
  <h3 style="margin-bottom:4px">⚡ Handy tricks</h3>
  <ul><li><b>Snooze</b> a message to bring it back later, and <b>schedule</b> emails to send at the right time.</li>
  <li>Press <b>?</b> for keyboard shortcuts. Search with <code>from:</code>, <code>has:attachment</code>, <code>is:unread</code>.</li>
  <li>Set an <b>automatic reply</b> before you go on holiday in Settings.</li></ul>
  ${app ? `<p><a href="${esc(app)}" style="color:#244960">${esc(app)}</a></p>` : ''}
  <p style="color:#616161;font-size:12px">We will never ask for your password by email. If a message asks you to "verify your account", it's a scam.</p></div>`;
  const raw = await new Promise((resolve, reject) => new MailComposer({
    from: { name: company || config.appName, address: `no-reply@${email.split('@')[1]}` }, to: email,
    subject: `Welcome to your new inbox, ${(name || '').split(/\s+/)[0] || email}!`, html,
  }).compile().build((e, m) => (e ? reject(e) : resolve(m))));
  // Newly created mailboxes can take a few seconds to become available in Dovecot
  for (let i = 0; i < 4; i++) {
    const c = makeClient({ email, password });
    try { await c.connect(); await c.append('INBOX', raw, []); await c.logout(); return; } catch { await c.logout().catch(() => {}); await new Promise((r) => setTimeout(r, 3000)); }
  }
}
