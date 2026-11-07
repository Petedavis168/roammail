// Protects the mail server's ban list. mailcow bans an IP address after repeated failed logins, and every Roammail
// user reaches mailcow from the app's ONE outbound IP, so a few wrong passwords could lock everybody out.
// Every password check therefore goes through here first:
//   - obviously invalid input never reaches mailcow
//   - a password that just failed for an address is refused locally for 15 minutes (no repeat attempt)
//   - failed attempts across ALL users are counted (Redis when several servers run); once the budget for the window
//     is used up, sign-ins are refused for a moment instead of risking a ban
//   - one attempt only: nothing here ever retries a failed password
import crypto from 'node:crypto';
import { config } from './config.js';
import { counter } from './shared.js';

const WINDOW = 10 * 60 * 1000;                                         // mailcow's default retry window
export const FAIL_BUDGET = Number(process.env.IMAP_AUTH_FAIL_BUDGET || 8); // stay under mailcow's default of 10
const BAD_TTL = 15 * 60 * 1000;
const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>"]+\.[^\s@<>"]{2,}$/;
const fail = (status, message) => Object.assign(new Error(message), { status });
// keyed hash so a leaked cache never reveals passwords
const badKey = (email, password) => `badpw:${crypto.createHmac('sha256', config.sealKey).update(`${String(email).toLowerCase()}\0${password}`).digest('hex')}`;

/** Throws 429 if the shared failure budget is used up. Returns false if the attempt is known to fail. */
export async function beforeAuth(email, password) {
  if (!EMAIL_RE.test(String(email)) || typeof password !== 'string' || !password || password.length > 256) return false;
  if (await counter.get(badKey(email, password))) return false;
  if (await counter.get('authfail:global') >= FAIL_BUDGET) {
    throw fail(429, 'Lots of sign-in attempts right now. Please wait a minute and try again.');
  }
  return true;
}

/** Record a rejected password (from IMAP, SMTP or calendar sign-in). */
export async function authFailed(email, password) {
  const n = await counter.hit('authfail:global', WINDOW);
  if (password) await counter.set(badKey(email, password), 1, BAD_TTL);
  if (n === FAIL_BUDGET) console.warn(`SECURITY_LOCKOUT mail-server sign-in budget used (${n} failures in 10 minutes); pausing sign-ins to avoid an IP ban`);
}

export const isAuthError = (err) => !!(err && (err.authenticationFailed || err.code === 'EAUTH' || err.responseCode === 535
  || /authenticat|invalid credentials|AUTHENTICATIONFAILED/i.test(String(err.responseText || err.response || err.message || ''))));
