// Refer a friend: everyone has a personal sign-up link. When a friend signs up with it and really uses their
// account (a week old and has sent a few emails), you both get a free month of Premium.
// Guarded against gaming it: not from the same network or phone as you, at most 12 free months a year per person,
// and the friend has to be a real, active user before anything is given.
import express from 'express';
import crypto from 'node:crypto';
import { q, audit } from './db.js';
import { requireAuth } from './session.js';
import { config } from './config.js';
import { grantPremiumDays, premiumEnabled } from './premium.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const REWARD_DAYS = 30;
const MAX_PER_YEAR = 12;
const QUALIFY_DAYS = 7;
const QUALIFY_SENT = 3;
const CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;
const isPersonal = (email) => email.split('@')[1] === config.signup.domain;

async function codeFor(email) {
  const r = await q.get('SELECT code FROM referral_codes WHERE email = ?', email);
  if (r) return r.code;
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let i = 0; i < 5; i++) {
    const code = Array.from(crypto.randomBytes(8), (b) => abc[b % 32]).join('');
    try { await q.run('INSERT INTO referral_codes(email, code, created_at) VALUES(?, ?, ?)', email, code, Date.now()); return code; } catch { /* taken; try again */ }
  }
  throw new Error('Could not make a referral code');
}
const linkFor = (code) => `${(config.publicUrl || '').replace(/\/$/, '')}/signup?ref=${code}`;

/** At sign-up: remember who sent them (never yourself, never the same network or phone). */
export async function recordReferral(newEmail, ref, { ip, phoneHash } = {}) {
  const code = String(ref || '').trim().toUpperCase();
  if (!CODE_RE.test(code)) return;
  const owner = await q.get('SELECT email FROM referral_codes WHERE code = ?', code);
  if (!owner || owner.email === newEmail) return;
  const them = await q.get('SELECT ip, phone_hash FROM signups WHERE email = ?', owner.email);
  let status = 'pending'; let reason = null;
  if (them && ip && them.ip === ip) { status = 'rejected'; reason = 'same network'; }
  if (them?.phone_hash && phoneHash && them.phone_hash === phoneHash) { status = 'rejected'; reason = 'same phone'; }
  await q.run('INSERT INTO referrals(referee, referrer, status, reason, created_at) VALUES(?, ?, ?, ?, ?) ON CONFLICT(referee) DO NOTHING', newEmail, owner.email, status, reason, Date.now());
}

/** Daily: friends who are now real, active users earn both of you a free month. */
export async function rewardReferrals() {
  if (!premiumEnabled()) return 0;
  const pending = await q.all("SELECT * FROM referrals WHERE status = 'pending' AND created_at < ?", Date.now() - QUALIFY_DAYS * 864e5);
  let n = 0;
  for (const r of pending) {
    const exists = await q.get('SELECT email FROM signups WHERE email = ?', r.referee);
    if (!exists) { await q.run("UPDATE referrals SET status = 'rejected', reason = 'account deleted' WHERE referee = ?", r.referee); continue; }
    const sent = Number((await q.get('SELECT COALESCE(SUM(count), 0) AS n FROM send_counts WHERE email = ?', r.referee)).n);
    const held = await q.get('SELECT status FROM sending_holds WHERE email = ? AND lifted_by IS NULL', r.referee).catch(() => null);
    if (held) { await q.run("UPDATE referrals SET status = 'rejected', reason = 'account paused' WHERE referee = ?", r.referee); continue; }
    if (sent < QUALIFY_SENT) { if (r.created_at < Date.now() - 60 * 864e5) await q.run("UPDATE referrals SET status = 'expired' WHERE referee = ?", r.referee); continue; }
    const thisYear = Number((await q.get("SELECT COUNT(*) AS n FROM referrals WHERE referrer = ? AND status = 'rewarded' AND rewarded_at > ?", r.referrer, Date.now() - 365 * 864e5)).n);
    const claim = await q.run("UPDATE referrals SET status = 'rewarded', rewarded_at = ? WHERE referee = ? AND status = 'pending'", Date.now(), r.referee);
    if (claim.changes !== 1) continue;
    if (thisYear < MAX_PER_YEAR && isPersonal(r.referrer)) await grantPremiumDays(r.referrer, REWARD_DAYS, 'referral').catch((e) => console.error('APP_ERROR referral reward', e.message));
    if (isPersonal(r.referee)) await grantPremiumDays(r.referee, REWARD_DAYS, 'referred').catch((e) => console.error('APP_ERROR referral reward', e.message));
    await audit('system', null, 'referral.rewarded', { referrer: r.referrer, referee: r.referee });
    n++;
  }
  return n;
}
export function startReferralRewards() {
  const run = () => rewardReferrals().catch((e) => console.error('APP_ERROR referrals', e.message));
  setTimeout(run, 60_000).unref();
  setInterval(run, 6 * 3600e3).unref();
}

const mask = (email) => { const [l, d] = email.split('@'); return `${l.slice(0, 2)}${'•'.repeat(Math.max(1, Math.min(6, l.length - 2)))}@${d}`; };
export const referralsApi = express.Router();
referralsApi.use('/referrals', requireAuth);
referralsApi.get('/referrals', wrap(async (req, res) => {
  const code = await codeFor(req.user.email);
  const rows = await q.all('SELECT referee, status, created_at, rewarded_at FROM referrals WHERE referrer = ? ORDER BY created_at DESC LIMIT 100', req.user.email);
  res.json({
    code, link: linkFor(code), available: premiumEnabled(), personal: isPersonal(req.user.email),
    rewardDays: REWARD_DAYS, qualify: { days: QUALIFY_DAYS, sent: QUALIFY_SENT }, maxPerYear: MAX_PER_YEAR,
    friends: rows.map((r) => ({ who: mask(r.referee), status: r.status === 'rejected' || r.status === 'expired' ? 'not-eligible' : r.status, joined: r.created_at, rewardedAt: r.rewarded_at })),
    earned: rows.filter((r) => r.status === 'rewarded').length,
  });
}));
