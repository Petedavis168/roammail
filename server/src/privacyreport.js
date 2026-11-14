// Your privacy report: what Roammail did for you this month. Trackers blocked (counted on your devices as emails
// open), spam and phishing kept out, scams you reported, people the Screener held back, aliases protecting your
// address, newsletters you left, and sign-ins to your account.
import express from 'express';
import { q } from './db.js';
import { requireAuth } from './session.js';
import { withMailbox, specialFolder } from './imap.js';
import { mailcow } from './mailcow.js';
import { rateLimit } from './shared.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);
const n = (r) => Number(r?.n || 0);

export const privacyReport = express.Router();
privacyReport.use('/privacy-report', requireAuth);

// The app reports trackers it blocked while showing an email (counts only, never what or from whom)
privacyReport.post('/privacy-report/trackers', rateLimit({ windowMs: 60e3, limit: 120 }), wrap(async (req, res) => {
  const pixels = Math.max(0, Math.min(50, Number(req.body.pixels) || 0)); const links = Math.max(0, Math.min(200, Number(req.body.links) || 0));
  if (pixels || links) {
    await q.run(`INSERT INTO privacy_stats(email, month, pixels, links) VALUES(?, ?, ?, ?)
      ON CONFLICT(email, month) DO UPDATE SET pixels = privacy_stats.pixels + excluded.pixels, links = privacy_stats.links + excluded.links`, req.user.email, monthKey(), pixels, links);
  }
  res.json({ ok: true });
}));

privacyReport.get('/privacy-report', rateLimit({ windowMs: 60e3, limit: 20 }), wrap(async (req, res) => {
  const e = req.user.email;
  const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
  const sinceIso = start.toISOString().replace('T', ' ').slice(0, 19);
  const t = await q.get('SELECT pixels, links FROM privacy_stats WHERE email = ? AND month = ?', e, monthKey());
  let junk = 0;
  try {
    const jf = await specialFolder(req.user, '\\Junk');
    if (jf) junk = await withMailbox(req.user, jf, async (c) => ((await c.search({ since: start }, { uid: true })) || []).length, { readOnly: true });
  } catch { /* no Junk folder */ }
  let held = 0;
  try { held = (await mailcow.listQuarantine()).filter((x) => x.rcpt === e && x.created >= start.getTime()).length; } catch { /* quarantine unavailable */ }
  const signins = await q.all("SELECT ok, ua FROM login_events WHERE email = ? AND at >= ?", e, sinceIso).catch(() => []);
  res.json({
    month: start.toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    trackers: { pixels: Number(t?.pixels || 0), links: Number(t?.links || 0) },
    spam: { junk, quarantined: held },
    scamsReported: n(await q.get("SELECT COUNT(*) AS n FROM audit WHERE actor = ? AND action = 'scam.reported' AND at >= ?", e, sinceIso).catch(() => null)),
    screener: { blocked: n(await q.get("SELECT COUNT(*) AS n FROM screener_list WHERE email = ? AND decision = 'block'", e)), allowedThisMonth: n(await q.get("SELECT COUNT(*) AS n FROM screener_list WHERE email = ? AND decision = 'allow' AND source = 'you' AND at >= ?", e, start.getTime())) },
    aliases: n(await q.get('SELECT COUNT(*) AS n FROM user_aliases WHERE email = ? AND active = 1', e)),
    unsubscribed: n(await q.get("SELECT COUNT(*) AS n FROM subscription_state WHERE email = ? AND status = 'unsubscribed' AND at >= ?", e, start.getTime())),
    signins: { ok: signins.filter((s) => Number(s.ok) === 1).length, failed: signins.filter((s) => Number(s.ok) !== 1).length },
  });
}));
