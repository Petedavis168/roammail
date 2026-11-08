// Personal Premium against the Stripe and mailcow stand-ins: checkout, 100 GB quota, unlimited AI, own domain,
// cancellation switches everything back. Needs the running stack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const D = process.env.TEST_DOMAIN || 'free.test';
const PW = 'Tq9-vLm2-Zx81';
const hdr = { 'X-Requested-With': 'mailcow-client', 'X-Forwarded-For': `198.26.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = '';
const call = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { ...hdr, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  for (const c of r.headers.getSetCookie?.() || []) if (c.startsWith('mc_session=')) cookie = c.split(';')[0];
  return { status: r.status, data: await r.json().catch(() => null) };
};
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function totp(secret) {
  let bits = 0, v = 0; const out = [];
  for (const c of secret) { v = (v << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } }
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = crypto.createHmac('sha1', Buffer.from(out)).update(buf).digest(); const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
const quota = async (email) => Number((await (await fetch(`http://127.0.0.1:8099/api/v1/get/mailbox/${email}`, { headers: { 'X-API-Key': 'dev-key' } })).json()).quota || 0); // the stand-in keeps the MB value it was given

test('Premium: pay, 100 GB and unlimited AI, own domain free while it lasts, cancel switches back', async () => {
  const user = `pr${crypto.randomBytes(3).toString('hex')}`;
  const email = `${user}@${D}`;
  assert.equal((await call('POST', '/api/signup', { name: 'Pat Rivers', username: user, password: PW, acceptTerms: true, birthday: '1990-01-15', recoveryEmail: 'recovery@example.org', phone: '+15555550123' })).status, 200);
  await call('POST', '/api/setup/2fa/remind', {}); await call('POST', '/api/setup/step', { step: 'done' });
  await sleep(1000);

  let p = (await call('GET', '/api/premium')).data;
  assert.equal(p.available, true); assert.equal(p.active, false); assert.equal(p.perMonth, 5); assert.equal(p.quotaGb, 100);
  assert.equal((await call('POST', '/api/premium/domain', { domain: `${user}.example` })).status, 402, 'domain needs Premium');
  const freeQuota = await quota(email);

  // checkout: the right price, tied to this person
  const co = await call('POST', '/api/premium/checkout', { interval: 'month' });
  assert.equal(co.status, 200); assert.match(co.data.url, /\/pay\?s=cs_test_/);
  const params = await (await fetch('http://127.0.0.1:12111/v1/test/last-session', { headers: { Authorization: 'Bearer sk_test_mock' } })).json();
  assert.equal(params.line_items[0].price, 'price_premium_monthly_mock');
  assert.equal(params.metadata.premium_email, email);

  // pay on the (fake) Stripe page: signed webhook turns Premium on
  const paid = await fetch(co.data.url, { method: 'POST', redirect: 'manual' });
  assert.equal(paid.status, 303);
  const sid = new URL(paid.headers.get('location'), BASE).searchParams.get('session_id');
  assert.equal((await call('POST', '/api/premium/confirm', { sessionId: sid })).data.active, true);
  p = (await call('GET', '/api/premium')).data;
  assert.equal(p.active, true); assert.equal(p.interval, 'month');
  assert.equal(await quota(email), 102400, '100 GB');
  assert.equal((await call('GET', '/api/ai/status')).data.unlimited, true, 'unlimited AI');
  assert.equal((await call('POST', '/api/premium/checkout', { interval: 'year' })).status, 400, 'no second subscription');

  // own domain: free while Premium lasts, one mailbox (it makes them a domain admin, so 2-step verification is required)
  const { secret } = (await call('POST', '/api/security/2fa/setup')).data;
  assert.equal((await call('POST', '/api/security/2fa/enable', { code: totp(secret) })).status, 200);
  const dom = await call('POST', '/api/premium/domain', { domain: `${user}.example`, local: 'pat' });
  assert.equal(dom.status, 200, JSON.stringify(dom.data));
  p = (await call('GET', '/api/premium')).data;
  assert.equal(p.domain.domain, `${user}.example`); assert.equal(p.domain.status, 'pending');
  const bill = (await call('GET', `/api/billing/${dom.data.orgId}`)).data;
  assert.ok(bill.comp?.forever, 'domain is complimentary');

  // another account can't claim this payment
  const mine = cookie;
  cookie = '';
  const other = `po${crypto.randomBytes(3).toString('hex')}`;
  await call('POST', '/api/signup', { name: 'Other Person', username: other, password: PW, acceptTerms: true, birthday: '1990-01-15', recoveryEmail: 'recovery@example.org', phone: '+15555550123' });
  assert.equal((await call('POST', '/api/premium/confirm', { sessionId: sid })).status, 403);
  cookie = mine;

  // cancel in Stripe: back to free, domain gets 30 days
  const sub = (await (await fetch(`http://127.0.0.1:12111/v1/checkout/sessions/${sid}`, { headers: { Authorization: 'Bearer sk_test_mock' } })).json()).subscription;
  await fetch('http://127.0.0.1:12111/v1/test/cancel', { method: 'POST', headers: { Authorization: 'Bearer sk_test_mock', 'Content-Type': 'application/x-www-form-urlencoded' }, body: `subscription=${sub}` });
  await sleep(500);
  p = (await call('GET', '/api/premium')).data;
  assert.equal(p.active, false); assert.equal(p.status, 'canceled');
  assert.equal(await quota(email), freeQuota / 1048576, 'back to the free quota (new mailboxes report bytes, edits are in MB)');
  assert.equal((await call('GET', '/api/ai/status')).data.unlimited, false);
  const after = (await call('GET', `/api/billing/${dom.data.orgId}`)).data;
  assert.ok(after.comp && !after.comp.forever && after.comp.until > Date.now() + 29 * 864e5, 'domain stays free for 30 days');
});
