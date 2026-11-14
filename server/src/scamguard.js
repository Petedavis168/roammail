// Keeping bots and scammers out (on top of what was already there: sign-up limits per network and per hour,
// breached-password check, optional captcha and SMS check, one free account per phone, the new-account send ramp,
// recipient caps, the outbound watchdog, the abuse desk and blocklist checks).
//
//  - Sign-up bot traps: a hidden field only bots fill in, and a minimum time to fill in the form
//  - Throwaway (disposable) recovery addresses are refused
//  - Scam check on what new free accounts send (first 30 days): phishing wording, brand impersonation, gift-card /
//    crypto / prize scams, links that hide where they go. A clear scam is refused; a second one pauses sending
//    for a human to review.
//  - "Report scam" on any email: moves it to Junk; if it came from a Roammail address, reports that account
//    (several different people reporting it in a day flags it for review — never an automatic ban, reports can be faked)
import express from 'express';
import { q, audit } from './db.js';
import { requireAuth } from './session.js';
import { config } from './config.js';
import { hold, sendingHold } from './outbound.js';
import { accountKind } from './abuse.js';
import { withMailbox, specialFolder } from './imap.js';
import { simpleParser } from 'mailparser';
import { rateLimit } from './shared.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message, code) => Object.assign(new Error(message), { status, expose: true, code });

// ---------------------------------------------------------------- sign-up
const MIN_FILL_MS = 2500;
export function checkSignupBot(body) {
  if (String(body.website || body.company_url || '').trim()) throw fail(400, 'Sign-up failed. Please try again.'); // honeypot
  const ms = Number(body.formMs);
  if (Number.isFinite(ms) && ms >= 0 && ms < MIN_FILL_MS) throw fail(400, 'That was very fast. Please check your details and try again.');
}

// The most common throwaway inbox services (a recovery address has to be one you'll still have later)
const DISPOSABLE = new Set(`mailinator.com guerrillamail.com guerrillamail.net guerrillamail.org sharklasers.com grr.la 10minutemail.com
10minutemail.net 10minutemail.co.uk temp-mail.org tempmail.com tempmail.net tempmailo.com tempr.email temp-mail.io tempail.com
yopmail.com yopmail.net yopmail.fr trashmail.com trashmail.net trashmail.de getnada.com nada.email dispostable.com maildrop.cc
mailnesia.com mintemail.com mohmal.com throwawaymail.com fakeinbox.com spamgourmet.com mailcatch.com emailondeck.com
getairmail.com fakemail.net moakt.com mytemp.email tempinbox.com discard.email burnermail.io inboxkitten.com mail.tm
mailpoof.com spambox.us trbvm.com emailfake.com crazymailing.com 33mail.com anonaddy.me mailsac.com tmail.ws tmpmail.org
tmpmail.net linshiyouxiang.net mvrht.net byom.de wegwerfmail.de einrot.com spam4.me harakirimail.com mailforspam.com
dropmail.me 1secmail.com 1secmail.net 1secmail.org kzccv.com qiott.com wuuvo.com icznn.com vjuum.com laafd.com txcct.com`.split(/\s+/));
export const isDisposable = (email) => DISPOSABLE.has(String(email || '').toLowerCase().split('@')[1] || '');

// ---------------------------------------------------------------- outgoing scam check (new free accounts)
const PHISH = [
  /verify (your|the) (account|identity|password|payment)/i, /(account|mailbox|card) (has been |was |will be )?(suspended|locked|limited|disabled|deactivated|closed)/i,
  /confirm (your )?(password|login|credentials|billing|bank)/i, /update (your )?(payment|billing|bank|card) (details|information|info)/i,
  /unusual (sign-?in|login|activity)/i, /(re-?)?enter (your )?(password|pin|ssn|social security)/i, /(click|tap) (here|below|the link) (to|and) (verify|confirm|restore|unlock|avoid)/i,
  /within (24|48|72) hours.{0,60}(suspend|lose|close|terminat)/i, /your (mailbox|storage) is (full|almost full).{0,80}(click|upgrade)/i,
];
const SCAM = [
  /\bgift ?cards?\b.{0,80}\b(buy|purchase|send|scratch|codes?)\b/i, /\b(buy|purchase|send|scratch)\b.{0,80}\bgift ?cards?\b/i,
  /\bwire (transfer|the money)\b/i, /western union|moneygram/i,
  /\b(bitcoin|btc|usdt|crypto(currency)?)\b.{0,80}\b(invest|wallet|send|double|profit|returns?)\b/i,
  /you (have|'ve) won|claim your (prize|reward|winnings)|lottery|sweepstakes/i, /\b(inheritance|next of kin|beneficiary)\b.{0,120}\b(million|usd|\$)/i,
  /\bsugar (daddy|mommy)\b/i, /\b(irs|tax refund)\b.{0,80}\b(click|claim|pay)\b/i,
];
const BRANDS = /\b(paypal|apple|icloud|microsoft|office ?365|outlook|amazon|netflix|google|gmail|facebook|instagram|whatsapp|docusign|dropbox|wells ?fargo|chase|bank ?of ?america|citi ?bank|coinbase|binance|irs|usps|fedex|dhl|ups|venmo|zelle|cash ?app|geek ?squad|norton|mcafee)\b/i;
const SHORTENERS = /\b(bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|buff\.ly|rebrand\.ly|cutt\.ly|shorturl\.at|rb\.gy|tiny\.cc|s\.id)\//i;

/** Score an outgoing email. Returns { score, reasons }. 0 = fine; 6+ = clear scam. */
export function scamScore({ fromName = '', subject = '', text = '', html = '' }) {
  const page = String(html).slice(0, 200000);
  const body = `${subject}\n${text || page.replace(/<[^<>]*>/g, ' ')}`.slice(0, 100000);
  const reasons = []; let score = 0;
  const hit = (n, why) => { score += n; reasons.push(why); };
  const p = PHISH.filter((r) => r.test(body)).length; if (p) hit(Math.min(6, p * 3), 'asks people to verify or re-enter account details');
  const s = SCAM.filter((r) => r.test(body)).length; if (s) hit(Math.min(6, s * 3), 'gift card / crypto / prize / money-transfer wording');
  const brand = (BRANDS.exec(`${fromName} ${subject}`) || [])[0];
  if (brand) hit(3, `uses the name “${brand}” in the sender name or subject`);
  if (SHORTENERS.test(body)) hit(1, 'shortened links');
  if (/https?:\/\/\d{1,3}(\.\d{1,3}){3}/.test(body)) hit(3, 'links to a bare IP address');
  // a link whose text shows one site but goes to another
  for (const m of page.matchAll(/<a\s([^<>]{0,2000})>([^<]{4,120})<\/a>/gi)) {
    const real = /\bhref\s?=\s?["']https?:\/\/([^/"'?#\s]{1,253})/i.exec(m[1])?.[1]?.toLowerCase().replace(/^www\./, '');
    const shown = m[2].split(/\s+/).map((w) => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '').toLowerCase())
      .find((w) => w.length <= 253 && /^[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){1,6}$/.test(w) && /\.[a-z]{2,}$/.test(w))?.replace(/^www\./, '');
    if (real && shown && !real.endsWith(shown) && !shown.endsWith(real)) { hit(3, `a link shows ${shown} but goes to ${real}`); break; }
  }
  if (/<input\b|<form\b/i.test(html)) hit(3, 'a form inside the email');
  return { score, reasons };
}

/** Called before sending. New free accounts only; businesses and established accounts are not scanned here. */
export async function checkOutgoing(email, mail) {
  if (config.limits?.scamCheck === false) return;
  const k = await accountKind(email);
  if (k.business || (k.ageDays ?? 0) > 30) return;
  const { score, reasons } = scamScore({ fromName: typeof mail.from === 'object' ? mail.from.name : '', subject: mail.subject, text: mail.text, html: mail.html });
  if (score < 6) return;
  const n = Number((await q.get("SELECT COUNT(*) AS n FROM audit WHERE actor = ? AND action = 'scam.blocked' AND at > datetime('now', '-1 day')", email)).n);
  await audit(email, null, 'scam.blocked', { score, reasons });
  console.warn(`SECURITY_SCAM_BLOCKED account=${String(email).replace(/[\r\n]/g, '')} score=${score}`);
  if (n >= 1 && !(await sendingHold(email))) await hold(email, 'Emails that look like scams or phishing', { score, reasons, subject: String(mail.subject || '').slice(0, 200) });
  throw fail(403, `This email wasn’t sent because it looks like a scam or phishing email (${reasons.slice(0, 2).join('; ')}). If this is a mistake, rewrite it without those parts or contact support.`, 'scam_blocked');
}

// ---------------------------------------------------------------- "Report scam"
export const scamApi = express.Router();
scamApi.use('/report-scam', requireAuth);
scamApi.post('/report-scam', rateLimit({ windowMs: 3600e3, limit: 30 }), wrap(async (req, res) => {
  const folder = String(req.body.folder || 'INBOX'); const uid = Number(req.body.uid);
  if (!uid) throw fail(400, 'Pick an email');
  const msg = await withMailbox(req.user, folder, async (c) => (await c.fetchOne(String(uid), { source: true }, { uid: true }))?.source);
  if (!msg) throw fail(404, 'Email not found');
  const parsed = await simpleParser(msg, { skipHtmlToText: true, skipImageLinks: true });
  const from = String(parsed.from?.value?.[0]?.address || '').toLowerCase();
  // our own user? report the account (needs several different people to flag it)
  const local = from && (await q.get("SELECT 1 AS x FROM domains WHERE domain = ? AND status = 'active'", from.split('@')[1]) || from.split('@')[1] === config.signup?.domain);
  let reported = false;
  if (local && from !== req.user.email.toLowerCase()) {
    await q.run('INSERT INTO abuse_reports(offender, reporter, details, headers, ip, at) VALUES(?, ?, ?, ?, ?, ?)',
      from, req.user.email, `Reported as a scam in the app. Subject: ${String(parsed.subject || '').slice(0, 300)}`, String(parsed.headerLines?.map((h) => h.line).join('\n') || '').slice(0, 20000), req.ip, Date.now());
    const recent = await q.get('SELECT COUNT(DISTINCT reporter) AS n FROM abuse_reports WHERE offender = ? AND at > ?', from, Date.now() - 864e5);
    if (Number(recent.n) >= 3 && !(await sendingHold(from))) {
      await q.run(`INSERT INTO sending_holds(email, status, reason, evidence, at) VALUES(?, 'flagged', ?, '{}', ?) ON CONFLICT(email) DO NOTHING`, from, `${recent.n} people reported scam emails in 24 hours`, Date.now());
    }
    reported = true;
  }
  const junk = (await specialFolder(req.user, '\\Junk', { create: true })) || 'Junk';
  if (folder !== junk) await withMailbox(req.user, folder, (c) => c.messageMove(String(uid), junk, { uid: true }));
  await audit(req.user.email, null, 'scam.reported', { from, reported });
  res.json({ ok: true, reported, movedTo: junk });
}));
