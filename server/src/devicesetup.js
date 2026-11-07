// One-tap phone setup: Apple configuration profiles (iPhone/iPad/Mac) and a
// device-aware setup page for Android & everything else. Reached by QR code.
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import QRCode from 'qrcode';
import { config } from './config.js';
import { q, rolesFor } from './db.js';
import { seal, unseal, requireAuth } from './session.js';
import { getProfile } from './signatures.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const base = (req) => config.publicUrl || `${req.protocol}://${req.get('host')}`;

function orgName(email) {
  return q.get("SELECT o.name FROM domains d JOIN orgs o ON o.id = d.org_id WHERE d.domain = ? AND d.status = 'active'", email.split('@')[1])?.name || null;
}

/** Create a one-time setup link. With a password, the profile installs without typing anything. */
export async function createSetupLink(req, email, password, minutes) {
  const token = crypto.randomBytes(18).toString('base64url');
  const expires = Date.now() + minutes * 60000;
  q.run('DELETE FROM setup_tokens WHERE expires < ?', Date.now());
  q.run('INSERT INTO setup_tokens(token_hash, email, creds, expires) VALUES(?, ?, ?, ?)', sha(token), email.toLowerCase(),
    password ? seal({ password, exp: expires }) : null, expires);
  const url = `${base(req)}/setup/${token}`;
  return { url, expiresAt: expires, qr: await QRCode.toDataURL(url, { margin: 1, width: 240 }) };
}

function lookupToken(token, { consume } = {}) {
  const row = q.get('SELECT * FROM setup_tokens WHERE token_hash = ?', sha(token));
  if (!row || row.expires < Date.now()) return null;
  // Credentials are released once (a short grace window covers the browser fetching twice)
  if (row.used_at && Date.now() - row.used_at > 120000) return { email: row.email, password: null, used: true };
  if (consume && !row.used_at) q.run('UPDATE setup_tokens SET used_at = ? WHERE token_hash = ?', Date.now(), row.token_hash);
  return { email: row.email, password: row.creds ? unseal(row.creds)?.password || null : null };
}

// ---------------------------------------------------------------- Apple profile
const uuid = (seed) => {
  const h = sha(seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`.toUpperCase();
};
function plist(v, ind = '') {
  const i = `${ind}  `;
  if (v === true) return `${ind}<true/>`;
  if (v === false) return `${ind}<false/>`;
  if (typeof v === 'number') return `${ind}<integer>${v}</integer>`;
  if (Array.isArray(v)) return `${ind}<array>\n${v.map((x) => plist(x, i)).join('\n')}\n${ind}</array>`;
  if (v && typeof v === 'object') {
    return `${ind}<dict>\n${Object.entries(v).filter(([, x]) => x !== undefined && x !== null)
      .map(([k, x]) => `${i}<key>${esc(k)}</key>\n${plist(x, i)}`).join('\n')}\n${ind}</dict>`;
  }
  return `${ind}<string>${esc(v)}</string>`;
}

export function buildMobileconfig(email, password) {
  const company = orgName(email);
  const name = getProfile(email).name || email.split('@')[0];
  const label = company ? `${company} email` : `${config.appName} email`;
  const id = `com.${(config.mailHostname || 'mail').split('.').reverse().join('.')}.setup.${email.replace(/[^a-z0-9]/gi, '-')}`;
  const content = [{
    PayloadType: 'com.apple.mail.managed', PayloadVersion: 1, PayloadIdentifier: `${id}.mail`, PayloadUUID: uuid(`${email}:mail`),
    PayloadDisplayName: 'Email', PayloadDescription: `Email account ${email}`,
    EmailAccountDescription: email, EmailAccountName: name, EmailAccountType: 'EmailTypeIMAP', EmailAddress: email,
    IncomingMailServerAuthentication: 'EmailAuthPassword', IncomingMailServerHostName: config.imap.host,
    IncomingMailServerPortNumber: config.imap.port, IncomingMailServerUseSSL: config.imap.secure, IncomingMailServerUsername: email,
    IncomingPassword: password || undefined,
    OutgoingMailServerAuthentication: 'EmailAuthPassword', OutgoingMailServerHostName: config.smtp.host,
    OutgoingMailServerPortNumber: config.smtp.port, OutgoingMailServerUseSSL: true, OutgoingMailServerUsername: email,
    OutgoingPasswordSameAsIncomingPassword: true, OutgoingPassword: password || undefined,
    PreventAppSheet: false, PreventMove: false, SMIMEEnabled: false, allowMailDrop: true,
  }];
  if (config.davEnabled) {
    const principal = `https://${config.davHost}/SOGo/dav/${encodeURIComponent(email)}/`;
    content.push({
      PayloadType: 'com.apple.caldav.account', PayloadVersion: 1, PayloadIdentifier: `${id}.caldav`, PayloadUUID: uuid(`${email}:caldav`),
      PayloadDisplayName: 'Calendar', CalDAVAccountDescription: `${email} calendar`, CalDAVHostName: config.davHost, CalDAVPort: 443,
      CalDAVUseSSL: true, CalDAVUsername: email, CalDAVPassword: password || undefined, CalDAVPrincipalURL: principal,
    }, {
      PayloadType: 'com.apple.carddav.account', PayloadVersion: 1, PayloadIdentifier: `${id}.carddav`, PayloadUUID: uuid(`${email}:carddav`),
      PayloadDisplayName: 'Contacts', CardDAVAccountDescription: `${email} contacts`, CardDAVHostName: config.davHost, CardDAVPort: 443,
      CardDAVUseSSL: true, CardDAVUsername: email, CardDAVPassword: password || undefined, CardDAVPrincipalURL: principal,
    });
  }
  const profile = {
    PayloadType: 'Configuration', PayloadVersion: 1, PayloadIdentifier: id, PayloadUUID: uuid(`${email}:profile`),
    PayloadDisplayName: label, PayloadOrganization: company || config.appName,
    PayloadDescription: `Sets up ${email}${config.davEnabled ? ' (mail, calendar and contacts)' : ''} on this device.`,
    PayloadRemovalDisallowed: false, PayloadContent: content,
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${plist(profile)}\n</plist>\n`;
}

/** Sign with openssl if a certificate is configured (iOS then shows "Verified"). */
function signProfile(xml) {
  const { cert, key, chain } = config.profileSign;
  if (!cert || !key || !fs.existsSync(cert) || !fs.existsSync(key)) return Promise.resolve(Buffer.from(xml));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-'));
  const inFile = path.join(dir, 'p.xml');
  fs.writeFileSync(inFile, xml);
  const args = ['smime', '-sign', '-signer', cert, '-inkey', key, '-in', inFile, '-outform', 'der', '-nodetach'];
  if (chain && fs.existsSync(chain)) args.push('-certfile', chain);
  return new Promise((resolve) => execFile('openssl', args, { encoding: 'buffer', maxBuffer: 1 << 20 }, (err, out) => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (err) { console.warn('profile signing failed, sending unsigned:', err.message); resolve(Buffer.from(xml)); } else resolve(out);
  }));
}

async function sendProfile(res, email, password) {
  const body = await signProfile(buildMobileconfig(email, password));
  res.setHeader('Content-Type', 'application/x-apple-aspen-config');
  res.setHeader('Content-Disposition', `attachment; filename="${email.split('@')[0].replace(/[^\w.-]/g, '')}-email.mobileconfig"`);
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

// ---------------------------------------------------------------- setup page
function detect(ua = '') {
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && /Mobile/.test(ua))) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Macintosh|Mac OS X/.test(ua)) return 'mac';
  if (/Windows/.test(ua)) return 'windows';
  return 'other';
}

function page(req, { email, profileUrl, passwordIncluded, expired }) {
  const dev = detect(req.get('user-agent'));
  const company = email ? orgName(email) : null;
  const appUrl = base(req);
  const smtpSec = config.smtp.secure ? 'SSL/TLS' : 'STARTTLS';
  const row = (l, v) => `<tr><td>${l}</td><td><code>${esc(v)}</code> <button class="copy" data-copy="${esc(v)}">Copy</button></td></tr>`;
  const settings = `<table class="set">${row('Email', email)}${row('Username', email)}
    ${row('Incoming server (IMAP)', config.imap.host)}${row('Port', config.imap.port)}<tr><td>Security</td><td>SSL/TLS</td></tr>
    ${row('Outgoing server (SMTP)', config.smtp.host)}${row('Port', config.smtp.port)}<tr><td>Security</td><td>${smtpSec}</td></tr>
    <tr><td>Password</td><td>Your email password</td></tr></table>`;
  const apple = `<section class="card ${dev === 'ios' || dev === 'mac' ? 'primary' : ''}">
    <h2>📱 iPhone, iPad &amp; Mac</h2>
    <a class="btn" href="${esc(profileUrl)}">Install on this ${dev === 'mac' ? 'Mac' : 'device'}</a>
    <ol><li>Tap <b>Install</b> above, then <b>Allow</b>.</li>
    <li>${dev === 'mac' ? 'Open <b>System Settings → Privacy &amp; Security → Profiles</b>' : 'Open the <b>Settings</b> app and tap <b>Profile Downloaded</b> at the top'}.</li>
    <li>Tap <b>Install</b> and enter your ${dev === 'mac' ? 'Mac' : 'phone'} passcode.${passwordIncluded ? '' : ' When asked, enter your <b>email password</b>.'}</li>
    <li>Done! Open the <b>Mail</b> app.${config.davEnabled ? ' Your calendar and contacts sync too.' : ''}</li></ol>
    ${passwordIncluded ? '<p class="ok">✓ Your password is included. Nothing to type.</p>' : ''}
    ${dev !== 'ios' && dev !== 'mac' ? '<p class="muted">Open this page on your iPhone or iPad (scan the QR code with the camera).</p>' : ''}</section>`;
  const android = `<section class="card ${dev === 'android' ? 'primary' : ''}">
    <h2>🤖 Android</h2>
    <p><b>Easiest: a mail app that sets itself up.</b> Install one, enter <b>${esc(email)}</b> and your password, and it finds the settings automatically.</p>
    <p class="apps"><a class="btn" href="https://play.google.com/store/apps/details?id=com.microsoft.office.outlook">Outlook</a>
    <a class="btn ghost" href="https://play.google.com/store/apps/details?id=net.thunderbird.android">Thunderbird</a></p>
    <details><summary>Using the Gmail or Samsung Email app?</summary>
      <ol><li>Open the app → <b>Add account</b> → <b>Other</b> (Gmail) or <b>Other</b> / <b>Manual setup</b> (Samsung).</li>
      <li>Enter your email, choose <b>Personal (IMAP)</b>, then your password.</li>
      <li>If it asks for servers, use these:</li></ol>${settings}</details></section>`;
  const web = `<section class="card">
    <h2>🌐 Web app (any phone)</h2>
    <p>Open <a href="${esc(appUrl)}">${esc(appUrl.replace(/^https?:\/\//, ''))}</a>, sign in, then ${dev === 'ios' ? 'tap <b>Share → Add to Home Screen</b>' : 'tap <b>⋮ → Install app</b>'}. It works like an app with all the features, including snooze and schedule send.</p></section>`;
  const desktop = `<section class="card ${dev === 'windows' ? 'primary' : ''}">
    <h2>💻 Outlook, Thunderbird &amp; other apps</h2>
    <p>Just add an account with your email and password. Outlook and Thunderbird detect the settings automatically. If an app asks, use:</p>${settings}</section>`;
  const order = dev === 'android' ? [android, web, apple, desktop] : dev === 'windows' ? [desktop, web, apple, android] : dev === 'other' ? [web, android, apple, desktop] : [apple, web, android, desktop];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Set up your email</title><link rel="icon" href="/favicon.png">
<style>
body{margin:0;font:16px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f3f5f8;color:#242424}
header{background:linear-gradient(135deg,#244960,#0a1e2e);color:#fff;padding:28px 20px 34px;text-align:center}
header h1{margin:6px 0 4px;font-size:24px}header p{margin:0;opacity:.9}
main{max-width:560px;margin:-18px auto 30px;padding:0 14px}
.card{background:#fff;border-radius:14px;padding:18px 20px;margin-bottom:14px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
.card.primary{border:2px solid #244960}
.card h2{margin:0 0 10px;font-size:19px}
.btn{display:inline-block;background:#244960;color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:10px;margin:2px 6px 8px 0}
.btn.ghost{background:#e9f0f5;color:#244960}
ol{padding-left:22px;margin:8px 0}li{margin:4px 0}
.ok{color:#107c10;font-weight:600}.muted{color:#666;font-size:14px}.warn{background:#fff4ce;padding:12px;border-radius:10px}
table.set{width:100%;border-collapse:collapse;font-size:14px;margin-top:8px}
table.set td{padding:6px 4px;border-bottom:1px solid #eee;vertical-align:top}table.set td:first-child{color:#666;width:42%}
code{font-size:14px;word-break:break-all}
.copy{border:1px solid #ccd;background:#fff;border-radius:6px;font-size:12px;padding:1px 8px;margin-left:4px}
summary{cursor:pointer;color:#244960;font-weight:600;margin-top:6px}
</style></head><body>
<header><img src="/roammail-mark-white.png" alt="" style="width:64px;height:auto"><h1>Set up your Roammail</h1><p>${esc(email)}${company ? ` · ${esc(company)}` : ''}</p></header>
<main>${expired ? `<div class="card warn">This setup link has already been used or has expired, so your password isn't included. Everything below still works; you'll just type your password once.</div>` : ''}
${order.join('\n')}
<p class="muted" style="text-align:center">Never share this page. We will never ask for your password by email or phone.</p></main>
<script src="/setup-assets/setup.js"></script></body></html>`;
}

export const deviceSetup = express.Router();

deviceSetup.get('/setup-assets/setup.js', (req, res) => {
  res.type('application/javascript').send(`document.addEventListener('click',function(e){var b=e.target.closest('.copy');if(!b)return;
navigator.clipboard&&navigator.clipboard.writeText(b.getAttribute('data-copy')).then(function(){var t=b.textContent;b.textContent='Copied';setTimeout(function(){b.textContent=t},1200)})});`);
});

// Public page by email (no secrets: server settings only, password typed on the device)
deviceSetup.get('/setup', (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).send('Missing email');
  res.setHeader('Cache-Control', 'no-store');
  res.send(page(req, { email, profileUrl: `/setup/profile.mobileconfig?email=${encodeURIComponent(email)}`, passwordIncluded: false }));
});
deviceSetup.get('/setup/profile.mobileconfig', wrap(async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).send('Missing email');
  await sendProfile(res, email, null);
}));

// One-time link (from the QR code); may carry the password
deviceSetup.get('/setup/:token', (req, res) => {
  const t = lookupToken(req.params.token);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!t) return res.status(410).send(page(req, { email: '', profileUrl: '#', expired: true }).replace('<p>', '<p>Link expired. Ask for a new one in Settings → Phone &amp; apps. '));
  res.send(page(req, { email: t.email, profileUrl: `/setup/${encodeURIComponent(req.params.token)}/profile.mobileconfig`, passwordIncluded: !!t.password, expired: !!t.used }));
});
deviceSetup.get('/setup/:token/profile.mobileconfig', wrap(async (req, res) => {
  const t = lookupToken(req.params.token, { consume: true });
  if (!t) return res.status(410).send('This setup link has expired.');
  await sendProfile(res, t.email, t.password);
}));

// Signed-in user asks for a QR code for their phone (password included, 15 minutes, single use)
export const deviceSetupApi = express.Router();
deviceSetupApi.post('/device-setup', requireAuth, wrap(async (req, res) => {
  res.json(await createSetupLink(req, req.user.email, req.body?.includePassword === false ? null : req.user.password, 15));
}));
