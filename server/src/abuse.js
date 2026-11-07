import { assertCanSend } from './outbound.js';
import { counter } from './shared.js';
import { count } from './ops.js';
// Abuse protection helpers: send quotas, SSRF-safe hosts, breached-password check, login throttling.
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from './config.js';
import { q } from './db.js';

const fail = (status, message) => Object.assign(new Error(message), { status });

export async function accountKind(email) {
  const e = email.toLowerCase();
  const org = await q.get("SELECT org_id FROM domains WHERE domain = ? AND status = 'active'", e.split('@')[1]);
  if (org) return { business: true, orgId: org.org_id };
  const s = await q.get('SELECT created_at FROM signups WHERE email = ?', e);
  const ageH = s ? (Date.now() - Date.parse(`${s.created_at.replace(' ', 'T')}Z`)) / 3600e3 : 1e9;
  return { business: false, newAccount: ageH < 7 * 24, ageDays: ageH / 24 }; // first week: the send ramp's daily cap (5a)
}

/** Check and count a webmail send. Throws 429 when over the daily quota or recipient limit. */
export async function checkSendQuota(email, recipientCount) {
  await assertCanSend(email);
  const k = await accountKind(email);
  const maxRcpt = k.business ? config.limits.businessRecipientsPerMessage : config.limits.freeRecipientsPerMessage;
  if (recipientCount > maxRcpt) throw fail(400, `You can send to at most ${maxRcpt} people per message${k.business ? '' : ' on a free account'}.`);
  const perDay = k.business ? config.limits.businessPerDay : k.newAccount ? config.limits.newAccountPerDay : config.limits.freePerDay;
  const day = new Date().toISOString().slice(0, 10);
  const row = await q.get('SELECT count FROM send_counts WHERE email = ? AND day = ?', email, day);
  if ((row?.count || 0) + 1 > perDay) {
    throw fail(429, k.newAccount ? `New accounts can send ${perDay} messages a day in their first week. This protects everyone from spammers.`
      : `You've reached today's limit of ${perDay} messages. It resets at midnight UTC.`);
  }
  await q.run('INSERT INTO send_counts(email, day, count) VALUES(?, ?, 1) ON CONFLICT(email, day) DO UPDATE SET count = send_counts.count + 1', email, day);
  await q.run("DELETE FROM send_counts WHERE day < date('now', '-30 days')");
}

export async function topSenders() {
  return await q.all("SELECT email, count FROM send_counts WHERE day = date('now') ORDER BY count DESC LIMIT 20");
}

// ---------------------------------------------------------------- SSRF guard
function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:') && isPrivate(v.slice(7));
}

/** Only allow public internet hosts (no localhost, private networks, cloud metadata, or this mail server). */
export async function assertPublicHost(host, port) {
  if (![993, 143, 995, 110].includes(Number(port))) throw fail(400, 'Only standard mail ports (993 or 143) are allowed');
  if (net.isIP(host)) throw fail(400, 'Enter the server name (like imap.example.com), not an IP address');
  if ([config.imap.host, config.mailHostname].some((h) => h && h.toLowerCase() === host)) throw fail(400, 'That is this server');
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch { throw fail(400, `Can't find the server ${host}`); }
  if (!addrs.length || addrs.some((a) => isPrivate(a.address))) throw fail(400, 'That server address is not allowed');
}

// ---------------------------------------------------------------- passwords
// Offline backstop if the breach service is unreachable: the most common passwords and patterns (checked case-insensitively,
// also with trailing digits/symbols stripped, e.g. "Password123!" -> "password").
const COMMON = new Set(`password passw0rd p@ssw0rd p@ssword qwerty qwertyuiop qwerty123 asdfghjkl zxcvbnm abc123 abcdef
letmein welcome welcome1 admin administrator root login master monkey dragon football baseball basketball soccer hockey
iloveyou princess sunshine shadow superman batman trustno1 starwars freedom whatever michael jennifer jordan hunter
ranger buster thomas robert daniel charlie andrew michelle jessica ashley pepper ginger cookie summer winter spring autumn
secret changeme default guest test tester testing hello hello123 google facebook microsoft apple samsung yahoo outlook
iphone android computer internet whatever1 mustang harley maggie killer george matrix flower lovely loveme mylove
babygirl angel angels anthony nicole daniel1 justin killer1 pokemon minecraft fortnite naruto blink182 liverpool chelsea
arsenal barcelona realmadrid juventus yankees cowboys eagles lakers 111111 123123 123321 654321 666666 696969 7777777
112233 121212 1q2w3e4r 1qaz2wsx qazwsx zaq12wsx q1w2e3r4 1q2w3e4r5t asdf1234 aa123456 abcd1234 password1 password12
company business office email mailbox mail webmail`.split(/\s+/));
function looksCommon(pw) {
  const lower = String(pw).toLowerCase();
  const base = lower.replace(/[\d\W_]+$/, '').replace(/^[\d\W_]+/, '');
  if (COMMON.has(lower) || (base.length >= 4 && COMMON.has(base))) return true;
  if (/^(\d)\1+$/.test(lower) || /^(?:0?123456789|1234567890|9876543210)/.test(lower)) return true;
  const runs = '0123456789abcdefghijklmnopqrstuvwxyz qwertyuiopasdfghjklzxcvbnm';
  return lower.length >= 8 && runs.includes(lower.replace(/[^a-z0-9]/g, '').slice(0, 8)); // keyboard / alphabet runs
}

/** Have I Been Pwned range check (k-anonymity: only 5 hash characters leave the server). Fails open. */
export async function assertNotBreached(password, email) {
  const lower = String(password).toLowerCase();
  const local = String(email || '').split('@')[0].toLowerCase();
  if (local.length >= 3 && lower.includes(local)) throw fail(400, 'Your password must not contain your email name');
  if (/^(.)\1+$/.test(password) || looksCommon(password)) throw fail(400, 'That password is too common and easy to guess. Try three or four random words.');
  if (!config.limits.checkBreachedPasswords) return;
  const hash = crypto.createHash('sha1').update(String(password)).digest('hex').toUpperCase();
  try {
    const res = await fetch(`https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`, { headers: { 'Add-Padding': 'true' }, signal: AbortSignal.timeout(3000) });
    if (!res.ok) return;
    const body = await res.text();
    const hit = body.split('\n').find((l) => l.startsWith(hash.slice(5)));
    if (hit && Number(hit.split(':')[1]) > 0) throw fail(400, 'This password has appeared in a data breach. Please choose a different one.');
  } catch (e) {
    if (e.status) throw e; // our own error
  }
}

// ---------------------------------------------------------------- login throttling
// Per (account + IP): 10 failures -> 15 min pause for that IP only, so attackers can't lock real users out.
// Per account from many IPs: 50 failures in 15 min -> account paused (distributed attack).
// Counters live in Redis when several servers run, so the limits hold across all of them.
const WINDOW = 15 * 60 * 1000;
export async function loginBlocked(email, ip) {
  const [a, b] = await Promise.all([counter.get(`lock:${email}|${ip}`), counter.get(`lock:${email}`)]);
  const until = Math.max(a, b);
  return until > Date.now() ? Math.ceil((until - Date.now()) / 60000) : 0;
}
export async function loginFailed(email, ip) {
  count('logins_failed');
  const [pair, acct] = await Promise.all([counter.hit(`fail:${email}|${ip}`, WINDOW), counter.hit(`fail:${email}`, WINDOW)]);
  if (pair >= 10) { await counter.set(`lock:${email}|${ip}`, Date.now() + WINDOW, WINDOW); if (pair === 10) console.warn(`SECURITY_LOCKOUT ip=${ip} account=${email}`); }
  if (acct === 50) { await counter.set(`lock:${email}`, Date.now() + WINDOW, WINDOW); console.warn(`SECURITY_LOCKOUT account=${email} distributed`); }
}
export async function loginSucceeded(email, ip) { count('logins_ok'); await counter.del(`fail:${email}|${ip}`); }

/** Display names can't contain addresses or brackets (stops "CEO <boss@bank.com>"-style spoofing). */
export function cleanDisplayName(n) {
  return String(n || '').replace(/[<>"@\r\n]/g, '').replace(/\S+\.[a-z]{2,}\b/gi, '').replace(/\s+/g, ' ').trim().slice(0, 80);
}
export { isPrivate as _isPrivate, looksCommon as _looksCommon };
