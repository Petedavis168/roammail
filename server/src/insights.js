// Insights for the owner: how the business is doing, once a week by email and any time in Admin → Insights.
//  - sign-ups (free and business), people active, emails sent, Premium, money in (from Stripe), ID checks, uptime
//  - where sign-ups drop off: counts per step, never who (the steps are counted per day, nothing else is kept)
import express from 'express';
import { config } from './config.js';
import { q, rolesFor, setting, setSetting } from './db.js';
import { requireAuth } from './session.js';
import { rateLimit } from './shared.js';
import { sendSystemMail } from './recovery.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const sqlTime = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 19);

// Sign-up steps, in order. The browser reports the screens; the server reports what it did.
export const FUNNEL = [
  ['signup_view', 'Opened “Create account”'], ['signup_address', 'Chose an address'], ['signup_password', 'Set a password'],
  ['signup_recovery', 'Added recovery details'], ['signup_review', 'Reached the last step'], ['signup_done', 'Account created'],
  ['setup_done', 'Finished first-time setup'], ['first_send', 'Sent their first email'],
];
const CLIENT_STEPS = new Set(['signup_view', 'signup_address', 'signup_password', 'signup_recovery', 'signup_review']);
export async function recordStep(step) {
  if (!FUNNEL.some(([k]) => k === step)) return;
  await q.run('INSERT INTO funnel_days(day, step, count) VALUES(?, ?, 1) ON CONFLICT(day, step) DO UPDATE SET count = funnel_days.count + 1', day(), step).catch(() => {});
}

async function moneyIn(from, to) {
  if (!config.billing?.stripeKey) return null;
  try {
    const { stripe } = await import('./billing.js');
    let total = 0; let count = 0; let after = '';
    for (let page = 0; page < 10; page++) {
      const r = await stripe('GET', `invoices?status=paid&limit=100&created[gte]=${Math.floor(from / 1000)}&created[lt]=${Math.floor(to / 1000)}${after ? `&starting_after=${after}` : ''}`);
      for (const i of r.data || []) { total += Number(i.amount_paid || 0); count++; }
      if (!r.has_more || !r.data?.length) break;
      after = r.data[r.data.length - 1].id;
    }
    return { cents: total, invoices: count };
  } catch { return null; }
}

/** Numbers for one period [from, to). */
export async function periodStats(from, to) {
  const n = async (sql, ...a) => Number((await q.get(sql, ...a).catch(() => null))?.n || 0);
  const f = sqlTime(from); const t = sqlTime(to);
  // daily tables: the 7 dates ending today (the day 7 days ago belongs to the week before), so weeks never overlap
  const free = config.signup.domain ? `%@${config.signup.domain}` : '%';
  const funnel = Object.fromEntries((await q.all('SELECT step, SUM(count) AS n FROM funnel_days WHERE day > ? AND day <= ? GROUP BY step', day(from), day(to))).map((r) => [r.step, Number(r.n)]));
  const status = await q.all('SELECT component, SUM(ok) AS ok, SUM(total) AS total FROM status_days WHERE day > ? AND day <= ? GROUP BY component', day(from), day(to)).catch(() => []);
  const okAll = status.reduce((s, r) => s + Number(r.ok), 0); const totAll = status.reduce((s, r) => s + Number(r.total), 0);
  return {
    from, to,
    signups: await n('SELECT COUNT(*) AS n FROM signups WHERE created_at >= ? AND created_at < ? AND email LIKE ?', f, t, free),
    businesses: await n('SELECT COUNT(*) AS n FROM orgs WHERE created_at >= ? AND created_at < ?', f, t),
    active: await n('SELECT COUNT(DISTINCT email) AS n FROM login_events WHERE ok = 1 AND at >= ? AND at < ?', f, t),
    sent: await n('SELECT COALESCE(SUM(count), 0) AS n FROM send_counts WHERE day > ? AND day <= ?', day(from), day(to)),
    premiumActive: await n("SELECT COUNT(*) AS n FROM premium WHERE status IN ('active', 'trialing') AND until > ?", from),
    premiumNew: await n("SELECT COUNT(*) AS n FROM premium WHERE status IN ('active', 'trialing') AND updated_at >= ? AND updated_at < ?", from, to),
    idVerified: await n("SELECT COUNT(*) AS n FROM id_verifications WHERE status = 'verified' AND verified_at >= ? AND verified_at < ?", from, to),
    capHit: await n('SELECT COUNT(*) AS n FROM monthly_sends WHERE month = ? AND count >= ?', new Date(to - 1).toISOString().slice(0, 7), config.limits.freePerMonth || 1e9),
    paused: await n('SELECT COUNT(*) AS n FROM sending_holds WHERE at >= ? AND at < ?', from, to),
    tickets: await n('SELECT COUNT(*) AS n FROM support_tickets WHERE at >= ? AND at < ?', from, to),
    uptime: totAll ? okAll / totAll : null,
    funnel,
  };
}

export async function buildInsights(now = Date.now()) {
  const week = 7 * 864e5;
  const [cur, prev] = await Promise.all([periodStats(now - week, now), periodStats(now - 2 * week, now - week)]);
  const [money, moneyPrev] = await Promise.all([moneyIn(now - week, now), moneyIn(now - 2 * week, now - week)]);
  cur.money = money; prev.money = moneyPrev;
  const totals = {
    users: Number((await q.get('SELECT COUNT(*) AS n FROM signups')).n),
    businesses: Number((await q.get('SELECT COUNT(*) AS n FROM orgs')).n),
    premium: cur.premiumActive,
  };
  const weeks = [];
  for (let i = 7; i >= 0; i--) {
    const to = now - i * week; const from = to - week;
    weeks.push({ from, signups: Number((await q.get('SELECT COUNT(*) AS n FROM signups WHERE created_at >= ? AND created_at < ?', sqlTime(from), sqlTime(to))).n) });
  }
  return { at: now, cur, prev, totals, weeks, funnelSteps: FUNNEL };
}

const fmtMoney = (c) => (c === null || c === undefined ? 'n/a' : new Intl.NumberFormat('en-US', { style: 'currency', currency: config.billing?.currency || 'usd' }).format(c / 100));
const delta = (a, b) => { if (a === null || b === null || a === undefined || b === undefined) return ''; const d = a - b; return d === 0 ? ' (same as last week)' : ` (${d > 0 ? '+' : ''}${d} vs last week)`; };
function reportHtml(r) {
  const c = r.cur; const p = r.prev;
  const row = (label, val, extra = '') => `<tr><td style="padding:5px 14px 5px 0;color:#555">${esc(label)}</td><td style="padding:5px 0"><b>${esc(val)}</b><span style="color:#888">${esc(extra)}</span></td></tr>`;
  const steps = r.funnelSteps.map(([k, l]) => [l, c.funnel[k] || 0]);
  const top = Math.max(1, ...steps.map((s) => s[1]));
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#242424;max-width:620px">
<h2 style="color:#173D56;margin:0 0 4px">${esc(config.appName)} this week</h2><p style="color:#666;margin:0 0 16px">${esc(new Date(c.from).toDateString())} – ${esc(new Date(c.to).toDateString())}</p>
<table style="border-collapse:collapse">
${row('New free accounts', c.signups, delta(c.signups, p.signups))}${row('New businesses', c.businesses, delta(c.businesses, p.businesses))}
${row('People who signed in', c.active, delta(c.active, p.active))}${row('Emails sent from the web app', c.sent, delta(c.sent, p.sent))}
${row('Money in', fmtMoney(c.money?.cents), c.money ? ` (${c.money.invoices} payments; last week ${fmtMoney(p.money?.cents)})` : ' (Stripe not connected)')}
${row('Premium members', c.premiumActive, ` (${c.premiumNew} new)`)}${row('ID checks passed', c.idVerified)}
${row('Free accounts at the monthly limit', c.capHit)}${row('Accounts paused for spam', c.paused)}${row('Support requests', c.tickets)}
${row('Uptime (our own checks)', c.uptime === null ? 'n/a' : `${(c.uptime * 100).toFixed(2)}%`)}
${row('Total accounts / businesses', `${r.totals.users} / ${r.totals.businesses}`)}
</table>
<h3 style="margin:20px 0 6px">Where sign-ups drop off</h3>
<table style="border-collapse:collapse;font-size:13px">${steps.map(([l, v]) => `<tr><td style="padding:3px 12px 3px 0;color:#555">${esc(l)}</td><td style="padding:3px 0;width:240px"><div style="background:#2563eb;height:12px;border-radius:3px;width:${Math.round((v / top) * 100)}%;min-width:2px"></div></td><td style="padding:3px 0 3px 8px"><b>${v}</b></td></tr>`).join('')}</table>
<p style="color:#888;font-size:12px;margin-top:16px">Counts only, nothing about who. Full view: Admin → Insights.</p></div>`;
}

/** Monday around 14:00 UTC (REPORT_WEEKDAY / INSIGHTS_HOUR_UTC), on the worker. */
export function startWeeklyInsights() {
  if (!config.runsBackground) return;
  const tick = async () => {
    const now = new Date();
    if (now.getUTCDay() !== Number(process.env.REPORT_WEEKDAY ?? 1) || now.getUTCHours() < Number(process.env.INSIGHTS_HOUR_UTC ?? 14)) return;
    const key = day();
    if ((await setting('insights_sent_day', '')) === key) return;
    await setSetting('insights_sent_day', key);
    await sendInsights();
  };
  setInterval(() => tick().catch((e) => console.error('APP_ERROR weekly insights', e.message)), 15 * 60e3).unref();
}
export async function sendInsights() {
  const custom = String(process.env.REPORT_EMAILS || '').split(',').map((x) => x.trim()).filter(Boolean);
  const to = [...new Set(custom.length ? custom : config.superAdmins)];
  if (!to.length) return false;
  const r = await buildInsights();
  await sendSystemMail(to, `${config.appName} this week: ${r.cur.signups} new accounts, ${fmtMoney(r.cur.money?.cents)} in`, reportHtml(r));
  return true;
}

export const insightsApi = express.Router();
export const funnelApi = express.Router(); // public: people aren't signed in yet while signing up
funnelApi.post('/funnel', rateLimit({ windowMs: 3600e3, limit: 40 }), wrap(async (req, res) => {
  const step = String(req.body?.step || '');
  if (CLIENT_STEPS.has(step)) await recordStep(step);
  res.status(204).end();
}));
insightsApi.get('/super/insights', requireAuth, wrap(async (req, res) => {
  if (!(await rolesFor(req.user.email)).superAdmin) return res.status(403).json({ error: 'Super-admin only' });
  const r = await buildInsights();
  if (req.query.send === '1') await sendInsights();
  res.json(r);
}));
