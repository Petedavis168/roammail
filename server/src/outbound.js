// Outbound reputation: keeps Roammail's mail out of Gmail/Outlook/Yahoo spam folders.
//  - Watchdog: reads mailcow's spam-filter and rate-limit logs every 5 minutes and stops sending for accounts that
//    are sending spam (usually a stolen password). Free accounts are held automatically; business accounts are
//    flagged for their admin and us (or held too, with OUTBOUND_HOLD_BUSINESS=true).
//  - Abuse desk: a public report form (/abuse) and a super-admin queue.
//  - Blocklist monitor: checks the mail server IPs against the big DNS blocklists every hour.
//  - Sending routes: free and business domains can leave through different relays (separate reputations).
import express from 'express';
import dns from 'node:dns/promises';
import { config } from './config.js';
import { q, audit, rolesFor, setting, setSetting } from './db.js';
import { requireAuth } from './session.js';
import { mailcow } from './mailcow.js';
import { rateLimit } from './shared.js';
import { sendSystemMail } from './recovery.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const env = process.env;
export const limits = {
  spamPerHour: Number(env.OUTBOUND_SPAM_PER_HOUR || 10),            // messages our own spam filter flagged, per sender
  rateLimitHitsPerHour: Number(env.OUTBOUND_RATELIMIT_HITS || 3),   // times mailcow's send limit stopped them
  holdBusiness: env.OUTBOUND_HOLD_BUSINESS === 'true',
};

// ---------------------------------------------------------------- holds
export async function sendingHold(email) {
  return q.get("SELECT * FROM sending_holds WHERE email = ? AND status IN ('held', 'flagged')", String(email).toLowerCase());
}
export async function assertCanSend(email) {
  const h = await sendingHold(email);
  if (h?.status === 'held') throw fail(403, 'Sending is paused on this account because it sent messages that looked like spam. Check your inbox for details, change your password, then contact support.');
}

const isFree = (email) => config.signup.domain && email.endsWith(`@${config.signup.domain}`);

export async function hold(email, reason, evidence, actor = 'watchdog') {
  const e = email.toLowerCase();
  if (await sendingHold(e)) return false;
  const business = !isFree(e);
  const status = business && !limits.holdBusiness && actor === 'watchdog' ? 'flagged' : 'held';
  if (status === 'held') await mailcow.editMailbox(e, { smtp_access: 0 }).catch((err) => console.error('APP_ERROR could not pause SMTP for', e, err.message));
  await q.run(`INSERT INTO sending_holds(email, status, reason, evidence, at) VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET status = excluded.status, reason = excluded.reason, evidence = excluded.evidence, at = excluded.at, lifted_by = NULL`,
  e, status, reason, JSON.stringify(evidence || {}).slice(0, 4000), Date.now());
  await audit(actor, null, `outbound.${status}`, { email: e, reason });
  console.warn(`SECURITY_OUTBOUND_${status.toUpperCase()} account=${e} reason=${reason}`);
  const html = `<p>We ${status === 'held' ? 'paused sending from' : 'noticed unusual sending from'} <b>${esc(e)}</b>: ${esc(reason)}.</p>
<p>This usually means someone else knows the password. Please <b>change your password</b> and turn on 2-step verification in Settings → Security.</p>
${status === 'held' ? '<p>You can still read your mail. Reply to this message or contact support to turn sending back on.</p>' : ''}`;
  const rec = (await q.get('SELECT recovery_email FROM user_security WHERE email = ? AND recovery_verified = 1', e))?.recovery_email;
  await sendSystemMail([e, rec].filter(Boolean), status === 'held' ? 'Sending paused on your account' : 'Unusual sending from your account', html).catch(() => {});
  if (config.legal.abuse) await sendSystemMail(config.legal.abuse, `[outbound ${status}] ${e}`, `<p>${esc(reason)}</p><pre>${esc(JSON.stringify(evidence, null, 2)).slice(0, 3000)}</pre>`).catch(() => {});
  if (business) {
    const admins = await q.all("SELECT m.email FROM members m JOIN domains d ON d.org_id = m.org_id WHERE d.domain = ? AND m.role = 'admin'", e.split('@')[1]);
    if (admins.length) await sendSystemMail(admins.map((a) => a.email), `Unusual sending from ${e}`, html).catch(() => {});
  }
  return true;
}

export async function lift(email, actor) {
  const e = email.toLowerCase();
  await mailcow.editMailbox(e, { smtp_access: 1 }).catch(() => {});
  await q.run("UPDATE sending_holds SET status = 'lifted', lifted_by = ? WHERE email = ?", actor, e);
  await audit(actor, null, 'outbound.lifted', { email: e });
}

// ---------------------------------------------------------------- watchdog
const userOf = (x) => String(x.user || x.sasl_username || x.rl_name || '').toLowerCase();
/** Look at the last hour of mailcow logs; hold senders over the limits. Returns what it found. */
export async function scanOutbound(now = Date.now()) {
  const since = now / 1000 - 3600;
  const [history, limited] = await Promise.all([
    mailcow.logs('rspamd-history', 2000).catch(() => []),
    mailcow.logs('ratelimited', 1000).catch(() => []),
  ]);
  const spam = new Map(); const rl = new Map();
  for (const x of history) {
    const u = userOf(x);
    if (!EMAIL_RE.test(u) || Number(x.unix_time || 0) < since) continue;   // only authenticated (outgoing) mail
    if (['reject', 'add header', 'rewrite subject', 'soft reject'].includes(x.action)) spam.set(u, (spam.get(u) || 0) + 1);
  }
  for (const x of limited) {
    const u = userOf(x);
    if (!EMAIL_RE.test(u) || Number(x.time || 0) < since) continue;
    rl.set(u, (rl.get(u) || 0) + 1);
  }
  const acted = [];
  for (const [u, n] of spam) {
    if (n >= limits.spamPerHour && await hold(u, `${n} outgoing messages in the last hour were flagged as spam`, { spamFlagged: n, rateLimited: rl.get(u) || 0 })) acted.push(u);
  }
  for (const [u, n] of rl) {
    if (n >= limits.rateLimitHitsPerHour && await hold(u, `hit the sending limit ${n} times in the last hour`, { rateLimited: n, spamFlagged: spam.get(u) || 0 })) acted.push(u);
  }
  await setSetting('outbound_last_scan', { at: now, checked: history.length + limited.length, acted });
  return { acted, spamFlagged: Object.fromEntries(spam), rateLimited: Object.fromEntries(rl) };
}

// ---------------------------------------------------------------- blocklists
const ZONES = (env.BLOCKLIST_ZONES || 'zen.spamhaus.org,b.barracudacentral.org,bl.spamcop.net,psbl.surriel.com').split(',').map((z) => z.trim()).filter(Boolean);
export async function checkBlocklists(ips = (env.MAIL_SERVER_IPS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
  const results = [];
  for (const ip of ips) {
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) continue;
    const rev = ip.split('.').reverse().join('.');
    for (const zone of ZONES) {
      let status = 'clean';
      try {
        const a = await dns.resolve4(`${rev}.${zone}`);
        // Spamhaus answers 127.255.255.x when it refuses the query (e.g. from a public DNS resolver): not a listing
        status = a.every((x) => x.startsWith('127.255.255.')) ? 'unknown' : 'listed';
      } catch (e) { status = e.code === 'ENOTFOUND' || e.code === 'ENODATA' ? 'clean' : 'unknown'; }
      if (status === 'listed') console.error(`APP_ERROR BLOCKLISTED mail server ${ip} is listed on ${zone}`);
      results.push({ ip, zone, status });
    }
  }
  await setSetting('blocklist_status', { at: Date.now(), results });
  return results;
}

// ---------------------------------------------------------------- sending routes (mailcow relayhosts)
/** Free sign-up domain and business domains can leave through different relays, so they never share a reputation. */
export async function applySendingRoute(domain) {
  const id = domain === config.signup.domain ? env.FREE_RELAYHOST_ID : env.BUSINESS_RELAYHOST_ID;
  if (!id) return false;
  await mailcow.editDomain(domain, { relayhost: String(id) });
  return true;
}

export function startOutboundChecks() {
  if (!config.runsBackground) return;
  const scan = () => scanOutbound().catch((e) => console.error('APP_ERROR outbound scan', e.message));
  setInterval(scan, 5 * 60 * 1000).unref();
  setTimeout(scan, 30_000).unref();
  const bl = () => checkBlocklists().catch((e) => console.error('APP_ERROR blocklist check', e.message));
  setInterval(bl, 3600e3).unref();
  setTimeout(bl, 60_000).unref();
  if (config.signup.domain) applySendingRoute(config.signup.domain).catch((e) => console.error('APP_ERROR sending route', e.message));
}

// ---------------------------------------------------------------- public abuse desk
export const abuseDesk = express.Router();
const reportLimit = rateLimit({ windowMs: 3600e3, limit: 5 });
const page = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Report abuse · ${esc(config.appName)}</title><link rel="icon" href="/favicon.png">
<style>body{font-family:Segoe UI,Arial,sans-serif;max-width:620px;margin:6vh auto;padding:0 20px;color:#242424}h1{color:#244960}label{display:block;margin:14px 0 4px;font-weight:600}input,textarea{width:100%;box-sizing:border-box;padding:9px;border:1px solid #bbb;border-radius:6px;font:inherit}button{margin-top:16px;background:#244960;color:#fff;border:0;border-radius:6px;padding:10px 18px;font:inherit;cursor:pointer}small{color:#666}</style></head><body>${body}</body></html>`;
abuseDesk.get('/abuse', (req, res) => res.type('html').send(page(`<h1>Report spam or abuse</h1>
<p>Got spam, phishing or harassment from a ${esc(config.appName)} address? Tell us and we'll investigate, usually within one business day.${config.legal.abuse ? ` You can also email <a href="mailto:${esc(config.legal.abuse)}">${esc(config.legal.abuse)}</a>.` : ''}</p>
<form method="post" action="/abuse">
<label>The ${esc(config.appName)} address that sent it</label><input name="offender" type="email" required maxlength="200">
<label>Your email (optional, so we can follow up)</label><input name="reporter" type="email" maxlength="200">
<label>What happened?</label><textarea name="details" rows="4" required maxlength="4000"></textarea>
<label>Message headers (optional)</label><textarea name="headers" rows="6" maxlength="20000" placeholder="In Gmail: ⋮ → Show original. In Outlook: File → Properties."></textarea>
<button>Send report</button></form>
<p><small>Reports are confidential. We never tell the account owner who reported them.</small></p>`)));
abuseDesk.post('/abuse', reportLimit, express.urlencoded({ extended: false, limit: '40kb' }), wrap(async (req, res) => {
  const offender = String(req.body.offender || '').trim().toLowerCase();
  const reporter = String(req.body.reporter || '').trim().toLowerCase();
  const details = String(req.body.details || '').trim().slice(0, 4000);
  if (!EMAIL_RE.test(offender) || !details) return res.status(400).type('html').send(page('<h1>Report not sent</h1><p>Please give the sender address and what happened. <a href="/abuse">Go back</a></p>'));
  await q.run('INSERT INTO abuse_reports(offender, reporter, details, headers, ip, at) VALUES(?, ?, ?, ?, ?, ?)',
    offender, EMAIL_RE.test(reporter) ? reporter : null, details, String(req.body.headers || '').slice(0, 20000), req.ip, Date.now());
  // Several independent reports in a day flag the account for a human to look at (never an automatic suspension:
  // reports could be faked to hurt someone)
  const recent = await q.get('SELECT COUNT(DISTINCT ip) AS n FROM abuse_reports WHERE offender = ? AND at > ?', offender, Date.now() - 864e5);
  if (recent.n >= 3 && !(await sendingHold(offender))) {
    await q.run(`INSERT INTO sending_holds(email, status, reason, evidence, at) VALUES(?, 'flagged', ?, '{}', ?) ON CONFLICT(email) DO NOTHING`,
      offender, `${recent.n} abuse reports in 24 hours`, Date.now());
  }
  if (config.legal.abuse) sendSystemMail(config.legal.abuse, `[abuse report] ${offender}`, `<p>${esc(details)}</p>`).catch(() => {});
  res.type('html').send(page('<h1>Thank you</h1><p>We received your report and will look into it.</p>'));
}));

// ---------------------------------------------------------------- super-admin
export const outboundAdmin = express.Router();
outboundAdmin.use('/super/abuse', requireAuth, wrap(async (req, res, next) => {
  if (!(await rolesFor(req.user.email)).superAdmin) throw fail(403, 'Super-admin only');
  next();
}));
outboundAdmin.get('/super/abuse', wrap(async (req, res) => {
  res.json({
    holds: await q.all("SELECT email, status, reason, evidence, at FROM sending_holds WHERE status IN ('held', 'flagged') ORDER BY at DESC LIMIT 200"),
    reports: await q.all("SELECT id, offender, reporter, details, at, status FROM abuse_reports WHERE status = 'open' ORDER BY at DESC LIMIT 200"),
    lastScan: await setting('outbound_last_scan', null),
    blocklists: await setting('blocklist_status', null),
    limits,
  });
}));
outboundAdmin.post('/super/abuse/scan', wrap(async (req, res) => {
  const [scan, blocklists] = await Promise.all([scanOutbound(), checkBlocklists()]);
  res.json({ ...scan, blocklists });
}));
outboundAdmin.post('/super/abuse/hold', wrap(async (req, res) => {
  const email = String(req.body.email || '').toLowerCase();
  if (!EMAIL_RE.test(email)) throw fail(400, 'Enter a full email address');
  const reason = String(req.body.reason || '').trim();
  if (reason.length < 5) throw fail(400, 'Write down why (for the audit log)');
  await q.run("DELETE FROM sending_holds WHERE email = ? AND status = 'flagged'", email);
  await hold(email, reason, { by: req.user.email }, req.user.email);
  res.json({ ok: true });
}));
outboundAdmin.post('/super/abuse/lift', wrap(async (req, res) => {
  await lift(String(req.body.email || ''), req.user.email);
  res.json({ ok: true });
}));
outboundAdmin.post('/super/abuse/reports/:id/close', wrap(async (req, res) => {
  await q.run("UPDATE abuse_reports SET status = 'closed' WHERE id = ?", Number(req.params.id));
  await audit(req.user.email, null, 'abuse.report_closed', { id: Number(req.params.id) });
  res.json({ ok: true });
}));
