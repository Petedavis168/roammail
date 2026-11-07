// Phone verification for free sign-ups (punch list 5b): a code by SMS before a free mailbox is created, and one free
// account per phone number. Uses Twilio Verify; switched on by TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_VERIFY_SID.
// Only a keyed hash of the number is stored (to enforce one account per phone), never the number itself.
import express from 'express';
import crypto from 'node:crypto';
import { config } from './config.js';
import { q } from './db.js';
import { seal, unseal } from './session.js';
import { rateLimit } from './shared.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status });
const env = process.env;
export const phoneRequired = () => !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_VERIFY_SID);
const API = () => (env.NODE_ENV !== 'production' && env.TWILIO_API_BASE) || 'https://verify.twilio.com';
const ACCOUNTS_PER_PHONE = Number(env.ACCOUNTS_PER_PHONE || 1);

/** E.164 (+15551234567). People type all sorts; keep digits, require the country code. */
export function normalizePhone(v) {
  let s = String(v || '').trim().replace(/[\s().-]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (!/^\+[1-9]\d{7,14}$/.test(s)) throw fail(400, 'Enter your mobile number with the country code, like +1 555 123 4567');
  return s;
}
export const phoneHash = (phone) => crypto.createHmac('sha256', config.sessionSecret || 'phone').update(phone).digest('hex');

async function twilio(path, params) {
  const r = await fetch(`${API()}/v2/Services/${encodeURIComponent(env.TWILIO_VERIFY_SID)}/${path}`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 429 || d.code === 60203) throw fail(429, 'Too many codes sent to this number. Try again later.');
    if (d.code === 60200 || d.code === 60205) throw fail(400, "That number can't receive text messages. Use a mobile number.");
    throw fail(502, 'We could not send a text message right now. Please try again.');
  }
  return d;
}

export const phoneApi = express.Router();
const startLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5 });
phoneApi.post('/signup/phone/start', startLimiter, wrap(async (req, res) => {
  if (!phoneRequired()) return res.json({ ok: true, required: false });
  const phone = normalizePhone(req.body.phone);
  const used = await q.get('SELECT COUNT(*) AS n FROM signups WHERE phone_hash = ?', phoneHash(phone));
  if (Number(used?.n || 0) >= ACCOUNTS_PER_PHONE) throw fail(409, 'This number was already used for a free account.');
  await twilio('Verifications', { To: phone, Channel: 'sms' });
  res.json({ ok: true, required: true });
}));
phoneApi.post('/signup/phone/check', rateLimit({ windowMs: 60 * 60 * 1000, limit: 15 }), wrap(async (req, res) => {
  if (!phoneRequired()) return res.json({ ok: true, token: null });
  const phone = normalizePhone(req.body.phone);
  const code = String(req.body.code || '').replace(/\D/g, '');
  if (code.length < 4) throw fail(400, 'Enter the code from the text message');
  const r = await twilio('VerificationCheck', { To: phone, Code: code });
  if (r.status !== 'approved') throw fail(400, "That code isn't right. Check the text message and try again.");
  // short-lived proof that this browser verified this number; redeemed by /signup
  res.json({ ok: true, token: seal({ t: 'phone', h: phoneHash(phone), exp: Date.now() + 30 * 60e3 }) });
}));

/** Called by /signup: returns the phone hash to store, or throws if verification is required and missing. */
export async function requireVerifiedPhone(token) {
  if (!phoneRequired()) return null;
  const t = unseal(String(token || ''));
  if (!t || t.t !== 'phone' || t.exp < Date.now()) throw fail(400, 'Please verify your mobile number first');
  const used = await q.get('SELECT COUNT(*) AS n FROM signups WHERE phone_hash = ?', t.h);
  if (Number(used?.n || 0) >= ACCOUNTS_PER_PHONE) throw fail(409, 'This number was already used for a free account.');
  return t.h;
}

/** Birthday as YYYY-MM-DD: a real date, at least minAge years ago and not more than 120. Returns the clean string. */
export function checkBirthday(v, minAge) {
  const s = String(v || '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!d || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) throw fail(400, 'Enter your date of birth');
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  if (now.getUTCMonth() < d.getUTCMonth() || (now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() < d.getUTCDate())) age--;
  if (age > 120 || d > now) throw fail(400, 'Check your date of birth');
  if (age < minAge) throw fail(400, `You need to be at least ${minAge} to create an account`);
  return s;
}
