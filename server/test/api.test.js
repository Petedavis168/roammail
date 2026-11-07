// API integration tests against a running stack (server + dev/mock-mailcow.js + GreenMail).
// Start the stack (see README "Local development"), then: BASE_URL=http://localhost:3000 npm run test:api
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const D = process.env.TEST_DOMAIN || 'free.test'; // the sign-up domain of the server under test

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const run = crypto.randomBytes(3).toString('hex');
const ip = () => `198.18.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`;

class Client {
  constructor(name) { this.name = name; this.cookie = ''; this.ip = ip(); }
  async req(method, path, body, { csrf = true, raw = false } = {}) {
    const headers = { 'X-Forwarded-For': this.ip };
    if (csrf) headers['X-Requested-With'] = 'mailcow-client';
    if (this.cookie) headers.Cookie = this.cookie;
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(BASE + path, { method, headers, body: payload, redirect: 'manual' });
    const set = res.headers.getSetCookie?.() || [];
    for (const c of set) if (c.startsWith('mc_session=')) this.cookie = c.split(';')[0].endsWith('=') ? '' : c.split(';')[0];
    if (raw) return res;
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  }
  get(p) { return this.req('GET', p); }
  post(p, b) { return this.req('POST', p, b ?? {}); }
}
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function totpNow(secret) {
  let bits = 0, v = 0; const out = [];
  for (const c of secret) { v = (v << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } }
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = crypto.createHmac('sha1', Buffer.from(out)).update(buf).digest(); const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PW = 'Tq9-vLm2-Zx81';

async function signup(c, username) {
  const r = await c.post('/api/signup', { name: `Test ${username}`, username, password: PW, acceptTerms: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await sleep(1500); // mailbox provisioning
  return r.data.email;
}

test('security headers are present', async () => {
  const r = await new Client().req('GET', '/', undefined, { raw: true });
  const h = Object.fromEntries(r.headers);
  assert.match(h['content-security-policy'], /script-src 'self'/);
  assert.match(h['content-security-policy'], /frame-ancestors 'self'/);
  assert.equal(h['x-content-type-options'], 'nosniff');
  assert.ok(h['referrer-policy']);
  assert.ok(h['permissions-policy']);
  assert.ok(!h['x-powered-by']);
});

test('security.txt and legal pages are published', async () => {
  const c = new Client();
  assert.match((await c.get('/.well-known/security.txt')).data, /Contact: mailto:/);
  for (const p of ['terms', 'privacy', 'acceptable-use', 'security']) assert.equal((await c.get(`/legal/${p}`)).status, 200);
});

test('unauthenticated requests are refused', async () => {
  const c = new Client();
  for (const p of ['/api/me', '/api/folders', '/api/messages', '/api/export', '/api/admin/orgs', '/api/quarantine']) {
    assert.equal((await c.get(p)).status, 401, p);
  }
});

test('CSRF: state-changing requests need the custom header', async () => {
  const c = new Client();
  const r = await c.req('POST', '/api/login', { email: 'x@y.z', password: 'x' }, { csrf: false });
  assert.equal(r.status, 403);
});

test('sign-up: terms required, weak passwords refused', async () => {
  const c = new Client();
  assert.equal((await c.post('/api/signup', { name: 'A', username: `t${run}a`, password: PW })).status, 400);
  assert.equal((await c.post('/api/signup', { name: 'A', username: `t${run}a`, password: 'password123', acceptTerms: true })).status, 400);
  assert.equal((await c.post('/api/signup', { name: 'A', username: 'admin', password: PW, acceptTerms: true })).status, 400);
});

test('sessions: opaque cookie, logout kills stolen copies, devices can be signed out', async () => {
  const a = new Client(); const email = await signup(a, `s${run}`);
  assert.ok(!decodeURIComponent(a.cookie).includes(PW));
  assert.ok(a.cookie.length < 80, 'cookie is a short random token');
  const b = new Client(); assert.equal((await b.post('/api/login', { email, password: PW })).status, 200);
  const devices = (await a.get('/api/security/sessions')).data;
  assert.equal(devices.length, 2);
  const other = devices.find((d) => !d.current);
  assert.equal((await a.req('DELETE', `/api/security/sessions?id=${other.id}`)).status, 200);
  assert.equal((await b.get('/api/me')).status, 401);
  const stolen = a.cookie;
  await a.post('/api/logout');
  const thief = new Client(); thief.cookie = stolen;
  assert.equal((await thief.get('/api/me')).status, 401);
});

test('mail: send and receive; recipient limit for free accounts', async () => {
  const a = new Client(); const email = await signup(a, `m${run}`);
  const fd = new FormData(); fd.append('to', email); fd.append('subject', `hello ${run}`); fd.append('text', 'body');
  assert.equal((await a.req('POST', '/api/send', fd)).status, 200);
  await sleep(1000);
  const list = (await a.get('/api/messages?folder=INBOX')).data;
  assert.ok(list.messages.some((m) => m.subject === `hello ${run}`));
  const many = new FormData(); many.append('to', Array.from({ length: 21 }, (_, i) => `u${i}@example.com`).join(',')); many.append('subject', 'x'); many.append('text', 'x');
  assert.equal((await a.req('POST', '/api/send', many)).status, 400);
});

test('free accounts: no forwarding, no imports from private networks', async () => {
  const a = new Client(); await signup(a, `f${run}`);
  assert.equal((await a.req('PUT', '/api/rules', { rules: [{ name: 'r', conditions: [{ field: 'from', value: 'x' }], actions: [{ type: 'forward', value: 'thief@evil.test' }] }] })).status, 403);
  assert.equal((await a.post('/api/filters/server', { desc: 'x', script: 'redirect "thief@evil.test";' })).status, 403);
  assert.equal((await a.post('/api/imports', { provider: 'other', host: '169.254.169.254', user: 'a', password: 'b' })).status, 400);
  assert.equal((await a.post('/api/imports', { provider: 'other', host: 'imap.gmail.com', port: 22, user: 'a', password: 'b' })).status, 400);
});

test('quarantine is private to its owner', async () => {
  const a = new Client(); await signup(a, `qa${run}`);
  const b = new Client(); await signup(b, `qb${run}`);
  const items = (await a.get('/api/quarantine')).data;
  assert.ok(items.length > 0);
  assert.equal((await b.get(`/api/quarantine/${items[0].id}`)).status, 404);
  assert.equal((await b.post('/api/quarantine/delete', { ids: [items[0].id] })).status, 404);
  assert.equal((await b.post('/api/quarantine/release', { ids: [items[0].id] })).status, 404);
});

test('2FA can be turned on right after sign-up', async () => {
  const a = new Client(); await signup(a, `z${run}`);
  const { secret } = (await a.post('/api/security/2fa/setup')).data;
  assert.equal((await a.post('/api/security/2fa/enable', { code: totpNow(secret) })).status, 200);
  assert.equal((await a.get('/api/me')).data.twoFactor.enabled, true);
});

test('sensitive changes need the password', async () => {
  const a = new Client(); await signup(a, `p${run}`);
  assert.equal((await a.req('PUT', '/api/security/recovery-email', { email: 'evil@attacker.test' })).status, 401);
  assert.equal((await a.req('PUT', '/api/security/recovery-email', { email: 'me@elsewhere.test', password: PW })).status, 200);
});

test('admins must use 2FA; companies can require it; external forwarding off by default', async (t) => {
  // Needs a fresh database where SUPERADMIN_EMAILS includes owner@free.test (as in dev/test.env and CI)
  const owner = new Client();
  const r = await owner.post('/api/login', { email: `owner@${D}`, password: PW });
  if (r.status === 401) await signup(owner, 'owner');
  else if (r.data?.twoFactor) return t.skip('owner@free.test already has 2FA from an earlier run; use a fresh DATA_DIR');
  const me = (await owner.get('/api/me')).data;
  assert.ok(me.superAdmin, 'SUPERADMIN_EMAILS must include owner@free.test');
  if (!me.twoFactor.enabled) {
    assert.equal((await owner.get('/api/admin/orgs')).status, 403);
    const { secret } = (await owner.post('/api/security/2fa/setup')).data;
    assert.equal((await owner.post('/api/security/2fa/enable', { code: totpNow(secret) })).status, 200);
  }
  assert.equal((await owner.get('/api/admin/orgs')).status, 200);
  const domain = `co${run}.test`;
  await owner.post('/api/domains', { domain, orgName: `Co ${run}` });
  assert.equal((await owner.post(`/api/domains/${domain}/verify`, { skipVerification: true })).data.ok, true);
  const orgId = (await owner.get('/api/admin/orgs')).data.find((o) => o.domains.some((d) => d.domain === domain)).id;
  await owner.req('PATCH', `/api/super/orgs/${orgId}/plan`, { plan: 'friendly' }); // first mailbox free, so no payment is needed here
  assert.equal((await owner.post('/api/admin/users', { domain, localPart: 'emp', name: 'Emp', password: PW, welcome: false })).status, 200);
  await sleep(1500);
  const emp = new Client(); assert.equal((await emp.post('/api/login', { email: `emp@${domain}`, password: PW })).status, 200);
  // external forwarding blocked by default, internal allowed
  assert.equal((await emp.post('/api/filters/server', { desc: 'fw', script: 'redirect "x@elsewhere.test";' })).status, 403);
  assert.equal((await emp.req('PUT', '/api/rules', { rules: [{ name: 'r', conditions: [{ field: 'from', value: 'x' }], actions: [{ type: 'forward', value: `boss@${domain}` }] }] })).status, 200);
  // company-wide 2FA requirement
  assert.equal((await owner.req('PATCH', `/api/admin/orgs/${orgId}`, { require2fa: true })).status, 200);
  const blocked = await emp.get('/api/folders');
  assert.equal(blocked.status, 403); assert.equal(blocked.data.code, '2fa_required');
  assert.equal((await emp.get('/api/me')).status, 200);
  // other orgs can't be touched
  assert.equal((await emp.get(`/api/admin/users?domain=${domain}`)).status, 403);
});

test('privacy: export as mbox and delete account', async () => {
  const a = new Client(); const email = await signup(a, `d${run}`);
  const ex = await a.req('GET', '/api/export', undefined, { raw: true });
  assert.equal(ex.status, 200);
  assert.match(ex.headers.get('content-type'), /mbox/);
  assert.match(await ex.text(), /^From /m);
  assert.equal((await a.post('/api/account/delete', { password: 'wrong', confirm: 'DELETE' })).status, 401);
  assert.equal((await a.post('/api/account/delete', { password: PW, confirm: 'DELETE' })).status, 200);
  assert.equal((await a.get('/api/me')).status, 401);
  assert.equal((await new Client().post('/api/login', { email, password: PW })).status, 401);
});

// ---------------------------------------------------------------- account recovery (reads the real emails)
async function waitFor(c, pred, tries = 15) {
  for (let i = 0; i < tries; i++) {
    const list = (await c.get('/api/messages?folder=INBOX')).data.messages || [];
    const m = list.find(pred);
    if (m) return (await c.get(`/api/message?folder=INBOX&uid=${m.uid}`)).data;
    await sleep(700);
  }
  throw new Error('email never arrived');
}
const bodyOf = (m) => `${m.text || ''} ${m.html || ''}`;

test('recovery: verified recovery email, forgot password, forgot address, lost-phone recovery', async () => {
  const a = new Client(); const email = await signup(a, `ra${run}`);
  const b = new Client(); const rec = await signup(b, `rb${run}`);   // acts as the outside recovery inbox

  // unverified address can't be used to reset
  assert.equal((await a.req('PUT', '/api/security/recovery-email', { email: rec, password: 'wrong' })).status, 401);
  const put = await a.req('PUT', '/api/security/recovery-email', { email: rec, password: PW });
  assert.equal(put.status, 200, JSON.stringify(put.data)); assert.equal(put.data.sent, true);
  let s = (await a.get('/api/security')).data;
  assert.equal(s.recoveryVerified, false); assert.equal(s.recoveryPending, rec);

  const vmail = await waitFor(b, (m) => /verification code/.test(m.subject));
  const code = vmail.subject.match(/^(\d{6})/)[1];
  assert.equal((await a.post('/api/security/recovery-email/verify', { code: code === '000000' ? '111111' : '000000' })).status, 400);
  assert.equal((await a.post('/api/security/recovery-email/verify', { code })).status, 200);
  s = (await a.get('/api/security')).data;
  assert.equal(s.recoveryVerified, true); assert.equal(s.recoveryEmail, rec);

  // forgot password → link to the verified address → reset works and signs out other sessions
  const anon = new Client();
  assert.equal((await anon.post('/api/password/forgot', { email })).status, 200);
  const rmail = await waitFor(b, (m) => /reset/i.test(m.subject));
  const token = bodyOf(rmail).match(/reset=([A-Za-z0-9_-]+)/)[1];
  const NEW = 'Rk7-pWq3-Yh52-n';
  assert.equal((await anon.post('/api/password/reset', { token, password: NEW })).status, 200);
  assert.equal((await anon.post('/api/password/reset', { token, password: NEW })).status, 400, 'token is single-use');
  assert.equal((await a.get('/api/me')).status, 401, 'old sessions revoked');

  // forgot address: same answer for unknown addresses, list arrives for the real one
  const unknown = await anon.post('/api/password/forgot-address', { recoveryEmail: `nobody${run}@example.com` });
  const known = await anon.post('/api/password/forgot-address', { recoveryEmail: rec });
  assert.deepEqual(unknown.data, known.data);
  const amail = await waitFor(b, (m) => /addresses/.test(m.subject));
  assert.ok(bodyOf(amail).includes(email));

  // lost phone: turn on 2FA, then start recovery from the sign-in ticket
  const a2 = new Client();
  assert.equal((await a2.post('/api/login', { email, password: NEW })).status, 200);
  const { secret } = (await a2.post('/api/security/2fa/setup')).data;
  assert.equal((await a2.post('/api/security/2fa/enable', { code: totpNow(secret) })).status, 200);
  const a3 = new Client();
  const t = (await a3.post('/api/login', { email, password: NEW })).data;
  assert.equal(t.twoFactor, true);
  assert.equal((await a3.post('/api/recovery/2fa', { ticket: 'forged' })).status, 401);
  const lost = await a3.post('/api/recovery/2fa', { ticket: t.ticket });
  assert.equal(lost.status, 200); assert.equal(lost.data.ok, true);
  assert.ok(lost.data.executeAfter > Date.now() + 71 * 3600e3, 'waits ~72 hours');
  const cmail = await waitFor(b, (m) => /recovery started/.test(m.subject));
  const cancel = bodyOf(cmail).match(/\/api\/recovery\/2fa\/cancel\?token=([A-Za-z0-9_-]+)/)[1];
  const page = await anon.req('GET', `/api/recovery/2fa/cancel?token=${cancel}`, undefined, { raw: true });
  assert.match(await page.text(), /Recovery canceled/);
  const a4 = new Client();
  assert.equal((await a4.post('/api/login', { email, password: NEW })).data.twoFactor, true, '2FA still on after cancel');
});

test('support tools are super-admin only', async () => {
  const a = new Client(); await signup(a, `su${run}`);
  assert.equal((await a.get(`/api/super/support/lookup?email=owner@${D}`)).status, 403);
  assert.equal((await a.post('/api/super/support/action', { email: `owner@${D}`, action: 'reset2fa', reason: 'testing it' })).status, 403);
});

test('ops: public status page, metrics hidden from the internet, notices are super-admin only', async () => {
  const anon = new Client();
  const s = await anon.get('/api/status');
  assert.equal(s.status, 200); assert.equal(s.data.ok, true); assert.ok(s.data.components.length >= 4);
  assert.match((await anon.get('/status')).data, /All systems are working normally/);
  assert.equal((await anon.req('GET', '/metrics', undefined, { csrf: false })).status, 404);
  const a = new Client(); await signup(a, `op${run}`);
  assert.equal((await a.req('PUT', '/api/super/status-notice', { title: 'hacked' })).status, 403);
});

test('signature logos: real images only, served from any server', async () => {
  const a = new Client(); await signup(a, `lg${run}`);
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a50000000049454e44ae426082', 'hex');
  const fd = new FormData(); fd.append('image', new Blob([png], { type: 'image/png' }), 'logo.png');
  const r = await a.req('POST', '/api/sig-assets', fd);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const path = new URL(r.data.url).pathname;
  const img = await new Client().req('GET', path, undefined, { raw: true, csrf: false });
  assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), png);
  const bad = new FormData(); bad.append('image', new Blob([Buffer.from('<script>alert(1)</script>')], { type: 'image/png' }), 'x.png');
  assert.equal((await a.req('POST', '/api/sig-assets', bad)).status, 400);
});

test('templates: personal templates are cleaned and private', async () => {
  const a = new Client(); await signup(a, `tp${run}`);
  const r = await a.req('PUT', '/api/templates', { templates: [{ name: 'Thanks', subject: 'Thank you', html: '<p>Thanks!</p><script>alert(1)</script><img src=x onerror=alert(1)>' }] });
  assert.equal(r.status, 200);
  const t = (await a.get('/api/templates')).data;
  assert.equal(t.personal.length, 1); assert.equal(t.personal[0].subject, 'Thank you');
  assert.ok(!/script|onerror/i.test(t.personal[0].html), 'scripts and handlers removed');
  const b = new Client(); await signup(b, `tq${run}`);
  assert.equal((await b.get('/api/templates')).data.personal.length, 0);
  assert.ok([403, 404].includes((await a.req('PUT', '/api/admin/orgs/1/templates', { templates: [] })).status));
});
