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
  spamPerHour: Number(env.OUTBOUND_SPAM_PER_HOUR || 2),             // outgoing messages our spam filter rejected/flagged, per sender (5c)
  rateLimitHitsPerHour: Number(env.OUTBOUND_RATELIMIT_HITS || 3),   // times mailcow's send limit stopped them
  bounceRate: Number(env.OUTBOUND_BOUNCE_RATE || 0.10),             // share of bounced recipients in the last hour (5c)
  bounceMinSent: Number(env.OUTBOUND_BOUNCE_MIN || 10),             // ...once at least this many were sent
  compromisedRecipients: Number(env.OUTBOUND_COMPROMISED_RCPTS || 40), // distinct recipients in an hour right after a new-device sign-in (5d)
  holdBusiness: env.OUTBOUND_HOLD_BUSINESS === 'true',
};

// ---------------------------------------------------------------- send ramp (5a)
// Free accounts earn their sending limit: days 1-7 25/h (and 150/day), days 8-30 60/h, then 100/h. Business: 100/h.
// mailcow enforces the hourly rate for every client (webmail, phones, Outlook); the app adds the daily cap for webmail.
export const RAMP = [{ until: 7, value: 25, frame: 'h', perDay: 150 }, { until: 30, value: 60, frame: 'h' }, { until: Infinity, value: 100, frame: 'h' }];
export const BUSINESS_RATE = { value: Number(env.BUSINESS_SEND_RATE || 100), frame: 'h' };
export const PAUSED_RATE = { value: 1, frame: 'd' };
export function rampFor(createdAtMs, now = Date.now()) {
  const day = Math.floor((now - createdAtMs) / 864e5) + 1; // day 1 = the sign-up day
  return { day, ...RAMP.find((t) => day <= t.until) };
}
const tierKey = (r) => `${r.value}/${r.frame}`;
/** Set the mailbox's mailcow rate limit if it differs from what we last applied. */
export async function applyRate(email, rate, { force = false } = {}) {
  const e = email.toLowerCase(); const key = tierKey(rate);
  const cur = await q.get('SELECT tier FROM send_tiers WHERE email = ?', e);
  if (!force && cur?.tier === key) return false;
  await mailcow.setMailboxRateLimit(e, rate.value, rate.frame);
  await q.run('INSERT INTO send_tiers(email, tier, applied_at) VALUES(?, ?, ?) ON CONFLICT(email) DO UPDATE SET tier = excluded.tier, applied_at = excluded.applied_at', e, key, Date.now());
  return true;
}
/** The rate an account should have right now (paused accounts stay at 1/day until a super-admin lifts the pause). */
export async function rateFor(email) {
  const e = email.toLowerCase();
  if ((await sendingHold(e))?.status === 'held') return PAUSED_RATE;
  if (!isFree(e)) return BUSINESS_RATE;
  const su = await q.get('SELECT created_at FROM signups WHERE email = ?', e);
  const created = su ? new Date(String(su.created_at).replace(' ', 'T') + (String(su.created_at).includes('Z') ? '' : 'Z')).getTime() : Date.now();
  return rampFor(Number.isFinite(created) ? created : Date.now());
}
/** Daily job: move every free account to the step its age has earned. */
export async function runSendRamp() {
  const rows = await q.all("SELECT email FROM signups WHERE created_at > datetime('now', '-40 days')");
  let changed = 0;
  for (const r of rows) {
    if (!isFree(r.email)) continue;
    try { if (await applyRate(r.email, await rateFor(r.email))) changed++; } catch (e) { console.warn('send ramp', r.email, e.message); }
  }
  await setSetting('send_ramp_last_run', { at: Date.now(), checked: rows.length, changed });
  return { checked: rows.length, changed };
}

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
  // Pause (5c) = sending limited to 1 message a day in mailcow (every client), and blocked in the app
  if (status === 'held') await applyRate(e, PAUSED_RATE, { force: true }).catch((err) => console.error('APP_ERROR could not pause sending for', e, err.message));
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
  await q.run("UPDATE sending_holds SET status = 'lifted', lifted_by = ? WHERE email = ?", actor, e);
  await mailcow.editMailbox(e, { smtp_access: 1 }).catch(() => {}); // accounts paused by older versions
  await applyRate(e, await rateFor(e), { force: true }).catch(() => {});
  await audit(actor, null, 'outbound.lifted', { email: e });
}

// ---------------------------------------------------------------- watchdog
const userOf = (x) => String(x.user || x.sasl_username || x.rl_name || '').toLowerCase();
/** Look at the last hour of mailcow logs; hold senders over the limits. Returns what it found. */
export async function scanOutbound(now = Date.now()) {
  const since = now / 1000 - 3600;
  const [history, limited, postfix] = await Promise.all([
    mailcow.logs('rspamd-history', 2000).catch(() => []),
    mailcow.logs('ratelimited', 1000).catch(() => []),
    mailcow.logs('postfix', 5000).catch(() => []),
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
  // Postfix log: who sent what (sasl_username per queue id) and how it was delivered
  const sender = new Map(); const sent = new Map(); const bounced = new Map(); const rcpts = new Map();
  const lines = [];
  for (const x of postfix) {
    if (Number(x.time || 0) < since) continue;
    const m = /^([0-9A-F]{6,}|[0-9A-Za-z]{10,}): (.*)$/.exec(String(x.message || ''));
    if (m) lines.push(m);
  }
  for (const [, qid, rest] of lines) { const sasl = /sasl_username=([^,\s]+)/.exec(rest); if (sasl) sender.set(qid, sasl[1].toLowerCase()); }
  for (const [, qid, rest] of lines) {
    const to = /to=<([^>]*)>.*status=(sent|bounced|deferred)/.exec(rest);
    const u = sender.get(qid);
    if (!to || !u || to[2] === 'deferred') continue;
    sent.set(u, (sent.get(u) || 0) + 1);
    if (to[2] === 'bounced') bounced.set(u, (bounced.get(u) || 0) + 1);
    if (!rcpts.has(u)) rcpts.set(u, new Set());
    rcpts.get(u).add(to[1].toLowerCase());
  }
  const acted = [];
  for (const [u, n] of bounced) {
    const total = sent.get(u) || 0;
    if (total >= limits.bounceMinSent && n / total > limits.bounceRate
      && await hold(u, `${n} of ${total} messages sent in the last hour bounced`, { bounced: n, sent: total })) acted.push(u);
  }
  // 5d: compromised-account guard: a burst to many recipients right after a sign-in from a new device
  for (const [u, set] of rcpts) {
    if (set.size < limits.compromisedRecipients || acted.includes(u)) continue;
    const newDevice = await q.get("SELECT 1 FROM audit WHERE actor = ? AND action = 'security.new_device' AND at > datetime('now', '-1 day')", u);
    if (!newDevice) continue;
    if (await hold(u, `sent to ${set.size} different people within an hour of a sign-in from a new device`, { recipients: set.size, sent: sent.get(u) || 0 })) {
      acted.push(u);
      await guardCompromised(u);
    }
  }
  for (const [u, n] of spam) {
    if (n >= limits.spamPerHour && await hold(u, `${n} outgoing messages in the last hour were flagged as spam`, { spamFlagged: n, rateLimited: rl.get(u) || 0 })) acted.push(u);
  }
  for (const [u, n] of rl) {
    if (n >= limits.rateLimitHitsPerHour && await hold(u, `hit the sending limit ${n} times in the last hour`, { rateLimited: n, spamFlagged: spam.get(u) || 0 })) acted.push(u);
  }
  await setSetting('outbound_last_scan', { at: now, checked: history.length + limited.length, acted });
  return { acted, spamFlagged: Object.fromEntries(spam), rateLimited: Object.fromEntries(rl) };
}

/** 5d: the password is probably stolen: sign every device out and require a new password at the next sign-in. */
export async function guardCompromised(email) {
  const { revokeSessions } = await import('./session.js');
  const { markTemporary } = await import('./setup.js');
  await markTemporary(email, 'compromised');
  await revokeSessions(email);
  await audit('watchdog', null, 'outbound.compromised', { email });
}

// ---------------------------------------------------------------- feedback loops (5c): a complaint pauses the sender
/** An ARF report (RFC 5965) from a mailbox provider's feedback loop: pause the original sender if it's one of ours. */
export async function handleComplaint(raw) {
  const text = String(raw || '');
  if (!/feedback-type:\s*abuse/i.test(text) && !/message\/feedback-report/i.test(text)) return null;
  const from = [...text.matchAll(/^(?:From|Return-Path|X-Original-From|Original-Mail-From):\s*.*?<?([^\s<>@]+@[^\s<>]+?)>?\s*$/gim)].map((m) => m[1].toLowerCase());
  const ours = from.find((a) => isFree(a) || a.endsWith(`@${config.rootDomain}`)) || null;
  let business = null;
  if (!ours) for (const a of from) if (await q.get("SELECT 1 FROM domains WHERE domain = ? AND status = 'active'", a.split('@')[1])) { business = a; break; }
  const who = ours || business;
  if (!who) return null;
  await hold(who, 'a recipient reported a message as spam (feedback loop complaint)', { complaint: true });
  return who;
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
  const ramp = () => runSendRamp().catch((e) => console.error('APP_ERROR send ramp', e.message));
  setTimeout(ramp, 45_000).unref();
  setInterval(ramp, Number(env.SEND_RAMP_INTERVAL_MS || 6 * 3600e3)).unref(); // daily step changes, checked 4x a day
  const scan = () => scanOutbound().catch((e) => console.error('APP_ERROR outbound scan', e.message));
  setInterval(scan, 5 * 60 * 1000).unref();
  setTimeout(scan, 30_000).unref();
  // Feedback loops (Microsoft JMRP/SNDS, Yahoo CFL, ...): their reports land in this mailbox; each one pauses the sender
  if (env.FBL_MAILBOX && env.FBL_PASSWORD) {
    const fbl = async () => {
      const { makeClient } = await import('./imap.js');
      const c = makeClient({ email: env.FBL_MAILBOX, password: env.FBL_PASSWORD });
      await c.connect();
      try {
        const lock = await c.getMailboxLock('INBOX');
        try {
          const uids = (await c.search({ seen: false }, { uid: true })) || [];
          for (const uid of uids.slice(0, 200)) {
            const m = await c.fetchOne(String(uid), { source: true }, { uid: true });
            if (m?.source) await handleComplaint(m.source.toString('utf8')).catch((e) => console.warn('fbl', e.message));
            await c.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
          }
        } finally { lock.release(); }
      } finally { await c.logout().catch(() => {}); }
    };
    setInterval(() => fbl().catch((e) => console.error('APP_ERROR fbl', e.message)), 5 * 60 * 1000).unref();
  }
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
// Paste a feedback-loop (ARF) complaint by hand; the worker also reads them from FBL_MAILBOX automatically
outboundAdmin.post('/super/abuse/complaint', wrap(async (req, res) => {
  const who = await handleComplaint(String(req.body.raw || '').slice(0, 2_000_000));
  res.json({ ok: true, paused: who });
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
