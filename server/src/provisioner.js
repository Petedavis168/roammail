// mailcow admin actions go through the Friendly Web Services provisioner (https://provision.fwdapps.cloud), never
// straight to the mailcow API: that API only accepts calls from inside the mail server's own network.
//
// Every request is signed: X-FWD-Timestamp (unix seconds) and X-FWD-Signature = hex HMAC-SHA256 of
// `${timestamp}.${path}.${body}` with PROVISIONER_SECRET. The app uses ONE provisioner route:
//
//   POST /mailcow/api   body {"method":"GET"|"POST","path":"get/mailbox/all/example.com","body":{...}}
//   -> the provisioner checks the path against MAILCOW_API_ALLOWLIST below, calls the mailcow API with its own key,
//      and returns mailcow's JSON response unchanged (same HTTP status).
//
// The allowlist is the complete set of mailcow API calls this app makes; anything else must be refused.
import crypto from 'node:crypto';

// [method, regex over the mailcow API path after /api/v1/]
export const MAILCOW_API_ALLOWLIST = [
  // domains + DKIM
  ['GET', /^get\/domain\/[^/]+$/], ['POST', /^add\/domain$/], ['POST', /^edit\/domain$/], ['POST', /^delete\/domain$/],
  ['GET', /^get\/dkim\/[^/]+$/], ['POST', /^add\/dkim$/],
  // mailboxes (create/delete/suspend/password/quota/name/protocol access), rate limits
  ['GET', /^get\/mailbox\/all\/[^/]+$/], ['GET', /^get\/mailbox\/[^/]+$/], ['POST', /^add\/mailbox$/], ['POST', /^edit\/mailbox$/],
  ['POST', /^delete\/mailbox$/], ['POST', /^edit\/rl-mbox$/],
  // aliases (groups, distribution lists)
  ['GET', /^get\/alias\/all$/], ['POST', /^add\/alias$/], ['POST', /^edit\/alias$/], ['POST', /^delete\/alias$/],
  // sieve filters (rules, vacation replies)
  ['GET', /^get\/filters\/all$/], ['POST', /^add\/filter$/], ['POST', /^edit\/filter$/], ['POST', /^delete\/filter$/],
  // mail import (sync jobs)
  ['GET', /^get\/syncjobs\/all\/no_log$/], ['GET', /^get\/syncjob_source\/all$/], ['POST', /^add\/syncjob_source$/],
  ['POST', /^add\/syncjob$/], ['POST', /^edit\/syncjob$/], ['POST', /^delete\/syncjob$/],
  // spam settings, allow/block lists
  ['GET', /^get\/spam-score\/[^/]+$/], ['POST', /^edit\/spam-score$/],
  ['GET', /^get\/policy_(wl|bl)_(mailbox|domain)\/[^/]+$/], ['POST', /^add\/(mailbox|domain)-policy$/], ['POST', /^delete\/(mailbox|domain)-policy$/],
  // quarantine
  ['GET', /^get\/quarantine\/(all|\d+)$/], ['POST', /^edit\/qitem$/], ['POST', /^delete\/qitem$/],
  ['POST', /^edit\/quarantine_notification$/], ['POST', /^edit\/quarantine_category$/],
  // company archive (BCC maps)
  ['GET', /^get\/bcc\/all$/], ['POST', /^add\/bcc$/], ['POST', /^delete\/bcc$/],
  // outbound spam watchdog (read-only logs) and status
  ['GET', /^get\/logs\/(rspamd-history|ratelimited)\/\d{1,4}$/], ['GET', /^get\/status\/version$/],
];
export const allowedCall = (method, path) => MAILCOW_API_ALLOWLIST.some(([m, re]) => m === method && re.test(path));

export const sign = (secret, ts, path, body) => crypto.createHmac('sha256', secret).update(`${ts}.${path}.${body}`).digest('hex');

/** Verify a signed request (used by the dev/test stand-in, and as the reference for the real provisioner). */
export function verify(secret, { ts, signature, path, body }, maxSkewSec = 300) {
  if (!/^\d{9,11}$/.test(String(ts)) || Math.abs(Date.now() / 1000 - Number(ts)) > maxSkewSec) return false;
  const want = sign(secret, ts, path, body);
  return typeof signature === 'string' && signature.length === want.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(want));
}

/** Call the mailcow API through the provisioner. Returns { status, text } like a fetch of the mailcow API would. */
export async function provisionerCall(cfg, method, apiPath, payload) {
  if (!allowedCall(method, apiPath)) throw new Error(`mailcow call not on the provisioner allowlist: ${method} ${apiPath}`);
  const path = '/mailcow/api';
  const body = JSON.stringify({ method, path: apiPath, ...(payload !== undefined ? { body: payload } : {}) });
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await fetch(`${cfg.url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-FWD-Timestamp': ts, 'X-FWD-Signature': sign(cfg.secret, ts, path, body) },
    body,
    signal: AbortSignal.timeout(Number(process.env.PROVISIONER_TIMEOUT_MS || 20000)),
  });
  return { ok: res.ok, status: res.status, text: await res.text() };
}
