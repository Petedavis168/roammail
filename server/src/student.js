// Students and nonprofits.
//  - Students: confirm a school email address (.edu, .ac.uk, .edu.au, k12…) with a code and get a year of
//    Premium free. Each school address can be used once; renew next year with the same address.
//  - Nonprofits: apply with the organization's details; a person reviews it (support ticket) and can grant a discount.
import express from 'express';
import crypto from 'node:crypto';
import { q, audit } from './db.js';
import { requireAuth, seal, unseal } from './session.js';
import { config } from './config.js';
import { sendSystemMail } from './recovery.js';
import { grantPremiumDays, premiumEnabled } from './premium.js';
import { rateLimit } from './shared.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>".]{1,63}(?:\.[^\s@<>".]{1,63}){1,8}$/;
// School domains: US .edu, k12, and academic second-level domains around the world
function isSchoolDomain(domain) {
  const l = String(domain || '').toLowerCase().split('.');
  if (l.length < 2 || l.length > 10 || l.some((x) => !/^[a-z0-9-]{1,63}$/.test(x))) return false;
  const n = l.length; const at = (i) => l[n - i];
  if (at(1) === 'edu') return true;
  if (n >= 4 && at(1) === 'us' && /^[a-z]{2}$/.test(at(2)) && at(3) === 'k12') return true;
  if (n >= 3 && /^[a-z]{2}$/.test(at(1)) && ['ac', 'edu', 'sch'].includes(at(2))) return true;
  if (at(1) === 'de' && at(2).startsWith('uni-')) return true;
  return l.slice(0, -1).includes('student') && l.indexOf('student') > 0;
}
export const isSchoolEmail = (e) => EMAIL_RE.test(e) && isSchoolDomain(e.split('@')[1]);
const isPersonal = (email) => email.split('@')[1] === config.signup.domain;
const hash = (e) => crypto.createHash('sha256').update(`student:${e.toLowerCase()}`).digest('hex');

export const studentApi = express.Router();
studentApi.use(['/student', '/nonprofit'], requireAuth);

studentApi.get('/student', wrap(async (req, res) => {
  const r = await q.get('SELECT verified_at, expires_at FROM student_status WHERE email = ?', req.user.email);
  res.json({ available: premiumEnabled() && isPersonal(req.user.email), verified: !!r && Number(r.expires_at) > Date.now(), until: r ? Number(r.expires_at) : null });
}));

studentApi.post('/student/start', rateLimit({ windowMs: 3600e3, limit: 5 }), wrap(async (req, res) => {
  if (!premiumEnabled() || !isPersonal(req.user.email)) throw fail(400, 'Student Premium is for free Roammail accounts');
  const school = String(req.body.schoolEmail || '').trim().toLowerCase();
  if (!isSchoolEmail(school)) throw fail(400, 'Use your school or university email address (for example name@school.edu)');
  const used = await q.get('SELECT email FROM student_claims WHERE school_hash = ? AND claimed_at > ?', hash(school), Date.now() - 330 * 864e5);
  if (used && used.email !== req.user.email) throw fail(409, 'That school address was already used this year');
  const code = String(crypto.randomInt(100000, 1000000));
  await sendSystemMail(school, 'Your Roammail student code', `<p>Your code is <b style="font-size:20px;letter-spacing:2px">${code}</b></p><p>Enter it in Roammail to get a free year of Premium. If you didn't ask for this, ignore this email.</p>`);
  await audit(req.user.email, null, 'student.code_sent');
  res.json({ ok: true, ticket: seal({ t: 'student', e: req.user.email, h: hash(school), c: code, exp: Date.now() + 30 * 60e3, tries: 0 }) });
}));

studentApi.post('/student/verify', rateLimit({ windowMs: 3600e3, limit: 10 }), wrap(async (req, res) => {
  const t = unseal(String(req.body.ticket || ''));
  if (!t || t.t !== 'student' || t.e !== req.user.email || t.exp < Date.now()) throw fail(400, 'The code expired. Ask for a new one.');
  if (String(req.body.code || '').trim() !== t.c) throw fail(400, 'That code isn’t right');
  const used = await q.get('SELECT email FROM student_claims WHERE school_hash = ? AND claimed_at > ?', t.h, Date.now() - 330 * 864e5);
  if (used && used.email !== req.user.email) throw fail(409, 'That school address was already used this year');
  await q.run('INSERT INTO student_claims(school_hash, email, claimed_at) VALUES(?, ?, ?) ON CONFLICT(school_hash) DO UPDATE SET email = excluded.email, claimed_at = excluded.claimed_at', t.h, req.user.email, Date.now());
  const until = Date.now() + 365 * 864e5;
  await q.run('INSERT INTO student_status(email, verified_at, expires_at) VALUES(?, ?, ?) ON CONFLICT(email) DO UPDATE SET verified_at = excluded.verified_at, expires_at = excluded.expires_at', req.user.email, Date.now(), until);
  await grantPremiumDays(req.user.email, 365, 'student');
  res.json({ ok: true, until });
}));

studentApi.post('/nonprofit/apply', rateLimit({ windowMs: 864e5, limit: 3 }), wrap(async (req, res) => {
  const org = String(req.body.organization || '').trim().slice(0, 200);
  const site = String(req.body.website || '').trim().slice(0, 300);
  const reg = String(req.body.registration || '').trim().slice(0, 100);
  const about = String(req.body.about || '').trim().slice(0, 2000);
  if (!org || !about) throw fail(400, 'Tell us the organization’s name and what it does');
  await q.run("INSERT INTO support_tickets(email, account, topic, message, ip, at) VALUES(?, ?, 'nonprofit', ?, ?, ?)", req.user.email, req.user.email,
    `Organization: ${org}\nWebsite: ${site}\nRegistration / tax ID: ${reg}\n\n${about}`, req.ip, Date.now());
  if (config.legal.contact) sendSystemMail(config.legal.contact, `[nonprofit application] ${org}`, `<pre>${org.replace(/[<>&]/g, '')}\n${site.replace(/[<>&]/g, '')}\n${reg.replace(/[<>&]/g, '')}\n\n${about.replace(/[<>&]/g, '')}</pre><p>From ${req.user.email}</p>`).catch(() => {});
  await audit(req.user.email, null, 'nonprofit.applied', { org });
  res.json({ ok: true });
}));
