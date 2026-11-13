// Free accounts: 100 emails a month (web app and phone/desktop mail apps together) until they verify their ID with
// a US driver's license (Stripe Identity, here a stand-in). One license can verify at most 3 accounts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const MOCK = process.env.MOCK_MAILCOW || 'http://127.0.0.1:8099';
const D = process.env.TEST_DOMAIN || 'free.test';
const PW = 'Tq9-vLm2-Zx81';
const run = crypto.randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function totp(secret) {
  let bits = 0, v = 0; const out = [];
  for (const c of secret) { v = (v << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } }
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = crypto.createHmac('sha1', Buffer.from(out)).update(buf).digest(); const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
class Client {
  constructor() { this.cookie = ''; this.ip = `198.51.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`; }
  async req(method, path, body, form) {
    const r = await fetch(BASE + path, { method, redirect: 'manual', headers: { 'X-Requested-With': 'mailcow-client', 'X-Forwarded-For': this.ip, ...(this.cookie ? { Cookie: this.cookie } : {}), ...(body && !form ? { 'Content-Type': 'application/json' } : {}) }, body: form || (body ? JSON.stringify(body) : undefined) });
    for (const c of r.headers.getSetCookie?.() || []) if (c.startsWith('mc_session=')) this.cookie = c.split(';')[0];
    const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
    return { status: r.status, data };
  }
  get(p) { return this.req('GET', p); }
  post(p, b) { return this.req('POST', p, b || {}); }
  send(to, subject) { const f = new FormData(); f.append('to', to); f.append('subject', subject); f.append('text', 'hi'); f.append('html', '<p>hi</p>'); return this.req('POST', '/api/send', null, f); }
}
async function signup(user) {
  const c = new Client();
  const r = await c.post('/api/signup', { name: `Test ${user}`, username: user, password: PW, acceptTerms: true, birthday: '1990-01-15', recoveryEmail: 'recovery@example.org', phone: '+15555550123', formMs: 60000 });
  if (r.status !== 200) return { c, r };
  await c.post('/api/setup/2fa/remind'); await c.post('/api/setup/step', { step: 'done' });
  return { c, r, email: r.data.email };
}
const mockLog = (kind, entries) => fetch(`${MOCK}/api/v1/add/mocklog/${kind}`, { method: 'POST', headers: { 'X-API-Key': 'dev-key', 'Content-Type': 'application/json' }, body: JSON.stringify(entries) });
/** Go through the (stand-in) Stripe Identity page with an outcome; returns when the webhook has been handled. */
async function verify(c, outcome, last = 'Rivera') {
  const r = await c.post('/api/id-verify/start');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await fetch(r.data.url, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ outcome, last }) });
  for (let i = 0; i < 20; i++) { const s = (await c.get('/api/id-verify')).data; if (!['pending', 'processing'].includes(s.status)) return s; await sleep(250); }
  return (await c.get('/api/id-verify')).data;
}

test('100 emails a month on free accounts until a US driver’s license is verified', async (t) => {
  const { c: admin, r } = await signup('capsuper');
  if (r.status !== 200) return t.skip('capsuper already exists; restart the stack with a fresh data folder');
  const { secret } = (await admin.post('/api/security/2fa/setup')).data;
  assert.equal((await admin.post('/api/security/2fa/enable', { code: totp(secret) })).status, 200);

  const { c: a, email: ea } = await signup(`cap${run}`);
  let s = (await a.get('/api/id-verify')).data;
  assert.equal(s.cap, 100); assert.equal(s.sentThisMonth, 0); assert.equal(s.capApplies, true); assert.equal(s.status, 'none');

  // 98 emails from a phone mail app, seen in the mail server log (counted once even when the scan runs again)
  const now = Math.floor(Date.now() / 1000); const lines = [];
  for (let i = 0; i < 98; i++) {
    const qid = `F${run}${String(i).padStart(4, '0')}`.toUpperCase().replace(/[^0-9A-F]/g, 'F');
    lines.push({ time: now - 60, message: `${qid}: client=unknown[198.51.100.1], sasl_method=PLAIN, sasl_username=${ea}` });
    lines.push({ time: now - 59, message: `${qid}: message-id=<app${i}.${run}@${D}>` });
    lines.push({ time: now - 50, message: `${qid}: to=<r${i}@example.com>, relay=mx.example.com, status=sent (250 ok)` });
  }
  await mockLog('postfix', lines);
  assert.equal((await admin.post('/api/super/abuse/scan')).status, 200);
  assert.equal((await admin.post('/api/super/abuse/scan')).status, 200);
  assert.equal((await a.get('/api/id-verify')).data.sentThisMonth, 98);

  // 2 more from the web app; the log line for one of them must not count it twice
  let w = await a.send(`friend${run}@example.com`, 'One');
  assert.equal(w.status, 200, JSON.stringify(w.data));
  const webQid = `E${run}0001`.toUpperCase().replace(/[^0-9A-F]/g, 'E');
  await mockLog('postfix', [
    { time: now, message: `${webQid}: client=localhost[127.0.0.1], sasl_method=PLAIN, sasl_username=${ea}` },
    { time: now, message: `${webQid}: message-id=${w.data.messageId}` },
    { time: now, message: `${webQid}: to=<friend${run}@example.com>, relay=mx.example.com, status=sent (250 ok)` },
  ]);
  await admin.post('/api/super/abuse/scan');
  assert.equal((await a.get('/api/id-verify')).data.sentThisMonth, 99);
  assert.equal((await a.send(`friend${run}@example.com`, 'Two')).status, 200);
  w = await a.send(`friend${run}@example.com`, 'Three');
  assert.equal(w.status, 429); assert.equal(w.data.code, 'monthly_cap'); assert.match(w.data.error, /100 emails a month/);
  const limit = await (await fetch(`${MOCK}/api/v1/get/ratelimit/mailbox/${encodeURIComponent(ea)}`, { headers: { 'X-API-Key': 'dev-key' } })).json().catch(() => null);
  if (limit && limit.value !== undefined) assert.equal(`${limit.value}/${limit.frame}`, '1/d', 'phone and desktop apps are held back too');

  // only a US driver's license counts
  s = await verify(a, 'foreign');
  assert.equal(s.status, 'failed'); assert.match(s.reason, /US driver/);
  s = await verify(a, 'mismatch');
  assert.equal(s.status, 'failed'); assert.match(s.reason, /selfie/);
  s = await verify(a, 'us');
  assert.equal(s.status, 'verified'); assert.equal(s.capApplies, false);
  assert.equal((await a.send(`friend${run}@example.com`, 'Four')).status, 200, 'no monthly limit once verified');
  assert.equal((await a.post('/api/id-verify/start')).data.verified, true);

  // one license unlocks at most 3 accounts
  for (const n of ['b', 'c']) assert.equal((await verify((await signup(`cap${n}${run}`)).c, 'us')).status, 'verified');
  const fourth = await verify((await signup(`capd${run}`)).c, 'us');
  assert.equal(fourth.status, 'failed'); assert.match(fourth.reason, /already verified 3/);
  assert.equal((await verify((await signup(`cape${run}`)).c, 'us', 'Someone Else')).status, 'verified', 'a different person is fine');
});
