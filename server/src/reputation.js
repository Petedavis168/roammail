// Daily reputation report (plan 5h): one email a day to the super-admins and abuse@ with the last 24 hours of
// sending health, plus a recommendation for the IP warm-up: advance, hold or roll back.
// Also available on demand to super-admins: GET /api/super/reputation.
import express from 'express';
import { config } from './config.js';
import { q, rolesFor, setting, setSetting } from './db.js';
import { requireAuth } from './session.js';
import { mailcow } from './mailcow.js';
import { sendSystemMail } from './recovery.js';
import { checkBlocklists } from './outbound.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const BIG = { gmail: /@(gmail|googlemail)\.com$/, microsoft: /@(outlook|hotmail|live|msn)\.[a-z.]+$/, yahoo: /@(yahoo|ymail|aol)\.[a-z.]+$/ };

/** Delivery stats from the Postfix log (what the provisioner lets us read; may not reach back a full day on busy servers). */
async function deliveryStats(since) {
  const lines = await mailcow.logs('postfix', 5000).catch(() => null);
  if (!lines) return null;
  const out = { sent: 0, bounced: 0, deferred: 0, byProvider: {}, covered: true };
  let oldest = Infinity;
  for (const x of lines) {
    const t = Number(x.time || 0); if (t) oldest = Math.min(oldest, t);
    if (t < since / 1000) continue;
    const m = /to=<([^>]*)>.*status=(sent|bounced|deferred)/.exec(String(x.message || ''));
    if (!m || /relay=(local|dovecot|lmtp)/.test(x.message)) continue; // only mail leaving the server
    out[m[2]]++;
    const prov = Object.keys(BIG).find((k) => BIG[k].test(m[1].toLowerCase())) || 'other';
    const p = (out.byProvider[prov] ||= { sent: 0, bounced: 0, deferred: 0 });
    p[m[2]]++;
  }
  out.covered = oldest <= since / 1000; // false = the log didn't reach back 24 h; numbers are a lower bound
  return out;
}

export async function buildReport(now = Date.now()) {
  const since = now - 864e5;
  const iso = new Date(since).toISOString().replace('T', ' ').slice(0, 19);
  const [delivery, blocklists] = await Promise.all([deliveryStats(since), checkBlocklists().catch(() => [])]);
  const holds = await q.all('SELECT email, status, reason FROM sending_holds WHERE at > ? ORDER BY at DESC', since);
  const complaints = holds.filter((h) => /complaint/i.test(h.reason));
  const signups = Number((await q.get('SELECT COUNT(*) AS n FROM signups WHERE created_at > ?', iso))?.n || 0);
  const relayDomains = []; const directDomains = [];
  for (const d of await q.all("SELECT domain FROM domains WHERE status = 'active'")) {
    const mc = await mailcow.getDomain(d.domain).catch(() => null);
    (mc && Number(mc.relayhost || 0) > 0 ? relayDomains : directDomains).push(d.domain);
  }
  const listed = blocklists.filter((b) => b.status === 'listed');
  const total = delivery ? delivery.sent + delivery.bounced : 0;
  const bounceRate = total ? delivery.bounced / total : 0;
  const deferRate = delivery && total + delivery.deferred ? delivery.deferred / (total + delivery.deferred) : 0;
  // Recommendation (docs/GRADUATE_OFF_RELAY.md): roll back on a listing; hold on bounces > 2%, deferrals > 5%,
  // any complaint or more than 2 pauses; otherwise advance the warm-up step.
  let advice = 'advance'; const why = [];
  if (listed.length) { advice = 'roll back'; why.push(`mail IP listed on ${listed.map((b) => b.zone).join(', ')}`); }
  else {
    if (bounceRate > 0.02) why.push(`bounce rate ${(bounceRate * 100).toFixed(1)}% (over 2%)`);
    if (deferRate > 0.05) why.push(`deferrals ${(deferRate * 100).toFixed(1)}% (over 5%)`);
    if (complaints.length) why.push(`${complaints.length} spam complaint(s)`);
    if (holds.length > 2) why.push(`${holds.length} accounts paused`);
    if (why.length) advice = 'hold';
  }
  if (!why.length) why.push('all signals green');
  return { at: now, delivery, bounceRate, deferRate, holds, complaints: complaints.length, signups, blocklists, listed: listed.length,
    relayDomains: relayDomains.length, directDomains: directDomains.length, advice, why };
}

function reportHtml(r) {
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const color = { advance: '#107c10', hold: '#b06d00', 'roll back': '#d13438' }[r.advice];
  const d = r.delivery;
  const rows = d ? Object.entries(d.byProvider).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v.sent}</td><td>${v.bounced}</td><td>${v.deferred}</td></tr>`).join('') : '';
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#242424;max-width:620px">
<h2 style="color:#173D56;margin:0 0 4px">${esc(config.appName)} sending report</h2><p style="color:#666;margin:0 0 16px">Last 24 hours · ${esc(new Date(r.at).toUTCString())}</p>
<p style="font-size:16px"><b>Recommendation: <span style="color:${color}">${esc(r.advice)}</span></b> — ${esc(r.why.join('; '))}</p>
<table cellpadding="6" style="border-collapse:collapse;font-size:13px">
<tr><td>Delivered</td><td><b>${d ? d.sent : 'n/a'}</b></td></tr><tr><td>Bounced</td><td><b>${d ? `${d.bounced} (${pct(r.bounceRate)})` : 'n/a'}</b></td></tr>
<tr><td>Deferred</td><td><b>${d ? `${d.deferred} (${pct(r.deferRate)})` : 'n/a'}</b></td></tr>
<tr><td>Accounts paused</td><td><b>${r.holds.length}</b></td></tr><tr><td>Spam complaints</td><td><b>${r.complaints}</b></td></tr>
<tr><td>Blocklist listings</td><td><b>${r.listed}</b></td></tr><tr><td>New free sign-ups</td><td><b>${r.signups}</b></td></tr>
<tr><td>Business domains: relay / direct</td><td><b>${r.relayDomains} / ${r.directDomains}</b></td></tr></table>
${rows ? `<h3 style="margin:16px 0 6px">By provider</h3><table cellpadding="6" style="border-collapse:collapse;font-size:13px"><tr><th align="left">Provider</th><th>Sent</th><th>Bounced</th><th>Deferred</th></tr>${rows}</table>` : ''}
${d && !d.covered ? '<p style="color:#888;font-size:12px">The mail log did not reach back a full day, so delivery numbers are a lower bound.</p>' : ''}
${!d ? '<p style="color:#888;font-size:12px">Delivery numbers need the provisioner to allow get/logs/postfix.</p>' : ''}
${r.holds.length ? `<h3 style="margin:16px 0 6px">Paused</h3><ul>${r.holds.map((h) => `<li>${esc(h.email)}: ${esc(h.reason)}</li>`).join('')}</ul>` : ''}
<p style="color:#888;font-size:12px">Thresholds and the warm-up plan: docs/GRADUATE_OFF_RELAY.md.</p></div>`;
}

export const reputationApi = express.Router();
reputationApi.get('/super/reputation', requireAuth, wrap(async (req, res) => {
  if (!(await rolesFor(req.user.email)).superAdmin) return res.status(403).json({ error: 'Super-admin only' });
  const r = await buildReport();
  if (req.query.send === '1') await sendReport(r);
  res.json(r);
}));

async function sendReport(r) {
  // REPORT_EMAILS overrides who gets it (comma-separated); default: super-admins and abuse@
  const custom = String(process.env.REPORT_EMAILS || '').split(',').map((x) => x.trim()).filter(Boolean);
  const to = [...new Set(custom.length ? custom : [...config.superAdmins, config.legal.abuse].filter(Boolean))];
  if (!to.length) return false;
  return sendSystemMail(to, `${config.appName} sending report: ${r.advice}`, reportHtml(r)).catch(() => false);
}

/** Once a day (around 07:00 UTC, or REPORT_HOUR_UTC), on the worker. */
export function startReputationReport() {
  if (!config.runsBackground) return;
  const hour = Number(process.env.REPORT_HOUR_UTC ?? 7);
  const tick = async () => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getUTCHours() < hour || (await setting('reputation_report_day', '')) === day) return;
    await setSetting('reputation_report_day', day); // one report per day even with several workers restarting
    await sendReport(await buildReport());
  };
  setInterval(() => tick().catch((e) => console.error('APP_ERROR reputation report', e.message)), 15 * 60e3).unref();
}
