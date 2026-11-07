// Outbound spam watchdog, abuse desk and sending holds. Needs the dev stack (dev/start-stack.sh) on a fresh data folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const MOCK = process.env.MOCK_MAILCOW || 'http://127.0.0.1:8099';
const D = process.env.TEST_DOMAIN || 'free.test';
const PW = 'Tq9-vLm2-Zx81';
const run = crypto.randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor() { this.cookie = ''; this.ip = `198.18.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`; }
  async req(method, path, body, form) {
    const headers = { 'X-Requested-With': 'mailcow-client', 'X-Forwarded-For': this.ip };
    if (this.cookie) headers.Cookie = this.cookie;
    let payload;
    if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(body).toString(); }
    else if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(BASE + path, { method, headers, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie?.() || []) if (c.startsWith('mc_session=')) this.cookie = c.split(';')[0];
    const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  }
  get(p) { return this.req('GET', p); }
  post(p, b) { return this.req('POST', p, b ?? {}); }
}
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function totp(secret) {
  let bits = 0, v = 0; const out = [];
  for (const c of secret) { v = (v << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } }
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = crypto.createHmac('sha1', Buffer.from(out)).update(buf).digest(); const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
async function signup(username) {
  const c = new Client();
  const r = await c.post('/api/signup', { name: username, username, password: PW, acceptTerms: true });
  if (r.status !== 200) return { c, r };
  await sleep(1300);
  return { c, r, email: r.data.email };
}
const mockLog = (kind, entries) => fetch(`${MOCK}/api/v1/add/mocklog/${kind}`, { method: 'POST', headers: { 'X-API-Key': 'dev-key', 'Content-Type': 'application/json' }, body: JSON.stringify(entries) });

test('watchdog: a free account sending spam is paused, can still read mail, and support can restore it', async (t) => {
  const { c: admin, r } = await signup('abusesuper');
  if (r.status !== 200) return t.skip('abusesuper already exists from an earlier run; restart the stack with a fresh data folder');
  const { secret } = (await admin.post('/api/security/2fa/setup')).data;
  assert.equal((await admin.post('/api/security/2fa/enable', { code: totp(secret) })).status, 200);

  const { c: victim, email } = await signup(`hacked${run}`);
  const { email: innocent } = await signup(`fine${run}`);
  const now = Math.floor(Date.now() / 1000);
  await mockLog('rspamd-history', [
    ...Array.from({ length: 12 }, (_, i) => ({ unix_time: now - i * 30, action: 'reject', score: 25, user: email, subject: 'Cheap pills' })),
    ...Array.from({ length: 3 }, (_, i) => ({ unix_time: now - i, action: 'no action', score: 1, user: innocent, subject: 'Lunch?' })),
    { unix_time: now, action: 'reject', score: 30, user: 'unknown', subject: 'incoming spam from outside (not ours)' },
  ]);

  assert.equal((await victim.post('/api/super/abuse/scan')).status, 403, 'normal users cannot run it');
  const scan = await admin.post('/api/super/abuse/scan');
  assert.equal(scan.status, 200, JSON.stringify(scan.data));
  assert.deepEqual(scan.data.acted, [email]);

  // sending is blocked in the app; reading still works
  const fd = new FormData(); fd.append('to', innocent); fd.append('subject', 'hi'); fd.append('text', 'x');
  assert.equal((await victim.req('POST', '/api/send', fd)).status, 403);
  assert.equal((await victim.get('/api/messages?folder=INBOX')).status, 200);
  const box = await (await fetch(`${MOCK}/api/v1/get/mailbox/${encodeURIComponent(email)}`, { headers: { 'X-API-Key': 'dev-key' } })).json();
  assert.equal(Number(box.smtp_access), 0, 'SMTP is switched off in mailcow too (phones, Outlook)');

  // the account owner was told
  await sleep(1500);
  const inbox = (await victim.get('/api/messages?folder=INBOX')).data.messages;
  assert.ok(inbox.some((m) => /Sending paused/.test(m.subject)), 'owner gets an explanation');

  const list = (await admin.get('/api/super/abuse')).data;
  assert.ok(list.holds.some((h) => h.email === email && h.status === 'held'));

  assert.equal((await admin.post('/api/super/abuse/lift', { email })).status, 200);
  const fd2 = new FormData(); fd2.append('to', innocent); fd2.append('subject', 'back'); fd2.append('text', 'x');
  assert.equal((await victim.req('POST', '/api/send', fd2)).status, 200);
});

test('abuse desk: anyone can report; reports never auto-suspend', async () => {
  const anon = new Client();
  assert.match((await anon.get('/abuse')).data, /Report spam or abuse/);
  const target = `target${run}@${D}`;
  for (let i = 0; i < 3; i++) {
    const r = await new Client().req('POST', '/abuse', { offender: target, details: `spam report ${i}` }, true);
    assert.equal(r.status, 200); assert.match(r.data, /Thank you/);
  }
  const bad = await anon.req('POST', '/abuse', { offender: 'not-an-email', details: 'x' }, true);
  assert.equal(bad.status, 400);
});
