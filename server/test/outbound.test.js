// Outbound spam watchdog, abuse desk and sending holds. Needs the dev stack (dev/start-stack.sh) on a fresh data folder.
import { test } from 'node:test';
import { finishSetup } from './setup-helper.js';
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
    if (this.autoSetup !== false && method === 'POST' && /^\/api\/(login|login\/2fa|signup|password\/reset)$/.test(path) && res.status === 200 && data?.setupRequired?.length) this.password = await finishSetup((m, p, b) => this.req(m, p, b), data, body?.password);
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
  const r = await c.post('/api/signup', { name: username, username, password: PW, acceptTerms: true, birthday: '1990-01-15', recoveryEmail: 'recovery@example.org', phone: '+15555550123' });
  if (r.status !== 200) return { c, r };
  await sleep(1300);
  return { c, r, email: r.data.email };
}
let superAdmin = null; // set by the first test (super-admin with 2-step verification)
const mockLog = (kind, entries) => fetch(`${MOCK}/api/v1/add/mocklog/${kind}`, { method: 'POST', headers: { 'X-API-Key': 'dev-key', 'Content-Type': 'application/json' }, body: JSON.stringify(entries) });

test('watchdog: a free account sending spam is paused, can still read mail, and support can restore it', async (t) => {
  const { c: admin, r } = await signup('abusesuper');
  if (r.status !== 200) return t.skip('abusesuper already exists from an earlier run; restart the stack with a fresh data folder');
  const { secret } = (await admin.post('/api/security/2fa/setup')).data;
  assert.equal((await admin.post('/api/security/2fa/enable', { code: totp(secret) })).status, 200);
  superAdmin = admin;

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
  assert.deepEqual([String(box.rl_value), box.rl_frame], ['1', 'd'], 'paused in mailcow too: 1 message a day from phones/Outlook (5c)');

  // the account owner was told
  await sleep(1500);
  const inbox = (await victim.get('/api/messages?folder=INBOX')).data.messages;
  assert.ok(inbox.some((m) => /Sending paused/.test(m.subject)), 'owner gets an explanation');

  const list = (await admin.get('/api/super/abuse')).data;
  assert.ok(list.holds.some((h) => h.email === email && h.status === 'held'));

  assert.equal((await admin.post('/api/super/abuse/lift', { email })).status, 200);
  const box2 = await (await fetch(`${MOCK}/api/v1/get/mailbox/${encodeURIComponent(email)}`, { headers: { 'X-API-Key': 'dev-key' } })).json();
  assert.deepEqual([String(box2.rl_value), box2.rl_frame], ['25', 'h'], 'back on its send-ramp step');
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

test('send ramp: a new free account starts at 25 an hour (5a)', async () => {
  const { email } = await signup(`ramp${run}`);
  const box = await (await fetch(`${MOCK}/api/v1/get/mailbox/${encodeURIComponent(email)}`, { headers: { 'X-API-Key': 'dev-key' } })).json();
  assert.deepEqual([String(box.rl_value), box.rl_frame], ['25', 'h']);
});

test('watchdog: too many bounces pause the sender; a burst after a new-device sign-in also signs everyone out (5c, 5d)', async (t) => {
  const admin = superAdmin;
  if (!admin) return t.skip('needs the first test (fresh data folder)');
  const { email: bouncer } = await signup(`bnc${run}`);
  const { c: victim, email: hacked } = await signup(`cmp${run}`);
  assert.equal((await victim.post('/api/login', { email: hacked, password: PW })).status, 200); // their usual device
  // the victim's password is used from a new device (different browser and network)
  const thief = new Client(); thief.ip = `203.0.113.${crypto.randomInt(1, 254)}`;
  const tl = await thief.post('/api/login', { email: hacked, password: PW });
  assert.equal(tl.status, 200);
  const now = Math.floor(Date.now() / 1000); const lines = [];
  // bouncer: 12 sent, 4 bounced (33%)
  for (let i = 0; i < 12; i++) {
    const qid = `B${run}${String(i).padStart(4, '0')}`.toUpperCase().replace(/[^0-9A-F]/g, 'A');
    lines.push({ time: now - 60, message: `${qid}: client=unknown[198.51.100.1], sasl_method=PLAIN, sasl_username=${bouncer}` });
    lines.push({ time: now - 50, message: `${qid}: to=<r${i}@example.com>, relay=mx.example.com, status=${i < 4 ? 'bounced' : 'sent'} (250 ok)` });
  }
  // hacked: 45 different recipients
  for (let i = 0; i < 45; i++) {
    const qid = `C${run}${String(i).padStart(4, '0')}`.toUpperCase().replace(/[^0-9A-F]/g, 'C');
    lines.push({ time: now - 40, message: `${qid}: client=unknown[203.0.113.9], sasl_method=PLAIN, sasl_username=${hacked}` });
    lines.push({ time: now - 30, message: `${qid}: to=<p${i}@example.org>, relay=mx.example.org, status=sent (250 ok)` });
  }
  await mockLog('postfix', lines);
  const scan = await admin.post('/api/super/abuse/scan');
  assert.equal(scan.status, 200, JSON.stringify(scan.data));
  assert.ok(scan.data.acted.includes(bouncer), 'bounce rate over 10%');
  assert.ok(scan.data.acted.includes(hacked), 'compromised-account guard');
  assert.equal((await victim.get('/api/messages?folder=INBOX')).status, 401, 'signed out everywhere');
  // a feedback-loop complaint about another account pauses it straight away
  const { email: reported } = await signup(`fbl${run}`);
  const arf = ['From: staff@fbl.example.net', 'Subject: complaint', 'Content-Type: multipart/report; report-type=feedback-report; boundary="b"', '', '--b', 'Content-Type: message/feedback-report', '',
    'Feedback-Type: abuse', 'User-Agent: test', 'Version: 1', '', '--b', 'Content-Type: message/rfc822', '', `From: Someone <${reported}>`, 'To: x@example.com', 'Subject: hi', '', 'spam', '--b--'].join('\r\n');
  const comp = await admin.post('/api/super/abuse/complaint', { raw: arf });
  assert.equal(comp.data.paused, reported);
  assert.ok((await admin.get('/api/super/abuse')).data.holds.some((h) => h.email === reported && h.status === 'held'));
  const again = new Client(); again.autoSetup = false;
  const re = await again.post('/api/login', { email: hacked, password: PW });
  assert.ok(re.data.setupRequired?.includes('password'), 'must choose a new password');
});

test('daily sending report: numbers from the mail log, a recommendation, and it can be emailed (5h)', async (t) => {
  const admin = superAdmin;
  if (!admin) return t.skip('needs the first test (fresh data folder)');
  const { c: someone } = await signup(`rep${run}`);
  assert.equal((await someone.get('/api/super/reputation')).status, 403, 'super-admins only');
  const now = Math.floor(Date.now() / 1000); const lines = [];
  for (let i = 0; i < 20; i++) lines.push({ time: now - 100, message: `R${run}${i}`.toUpperCase().replace(/[^0-9A-F]/g, 'D').padEnd(10, 'D') + `: to=<p${i}@gmail.com>, relay=gmail-smtp-in.l.google.com, status=sent (250 ok)` });
  await mockLog('postfix', lines);
  const r = (await admin.get('/api/super/reputation')).data;
  assert.ok(r.delivery.sent >= 20, JSON.stringify(r.delivery)); assert.ok(r.delivery.byProvider.gmail.sent >= 20);
  assert.ok(['advance', 'hold', 'roll back'].includes(r.advice)); assert.ok(r.why.length);
  assert.ok(r.holds.length >= 1, 'pauses from the earlier tests are counted');
  assert.equal((await admin.get('/api/super/reputation?send=1')).status, 200);
  await sleep(1500);
  assert.ok((await admin.get('/api/messages?folder=INBOX')).data.messages.some((m) => /sending report/.test(m.subject)), 'emailed to super-admins');
  const fn = await admin.get('/api/super/first-name-accounts');
  assert.equal(fn.status, 200); assert.ok(Array.isArray(fn.data));
});
