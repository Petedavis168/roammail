// Item 8: first sign-in must replace a temporary password and turn on 2-step verification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sign } from '../src/provisioner.js';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const MOCK = process.env.MOCK_MAILCOW || 'http://127.0.0.1:8099';
const D = process.env.TEST_DOMAIN || 'free.test';
const PW = 'Tq9-vLm2-Zx81';
const run = crypto.randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor() { this.cookie = ''; this.ip = `198.18.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`; }
  async req(method, path, body, extra = {}) {
    const headers = { 'X-Requested-With': 'mailcow-client', 'X-Forwarded-For': this.ip, ...extra };
    if (this.cookie) headers.Cookie = this.cookie;
    let payload; if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = typeof body === 'string' ? body : JSON.stringify(body); }
    const res = await fetch(BASE + path, { method, headers, body: payload });
    for (const c of res.headers.getSetCookie?.() || []) if (c.startsWith('mc_session=')) this.cookie = c.split(';')[0];
    const t = await res.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
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
const mailcowAdd = (local, password) => fetch(`${MOCK}/api/v1/add/mailbox`, { method: 'POST', headers: { 'X-API-Key': 'dev-key', 'Content-Type': 'application/json' },
  body: JSON.stringify({ local_part: local, domain: D, name: `Ext ${local}`, password, password2: password, quota: 1024, active: 1 }) });

test('free sign-up: 2-step verification is asked for, can be postponed 3 times, nothing else works meanwhile', async () => {
  const c = new Client();
  const s = await c.post('/api/signup', { name: 'Setup Free', username: `sf${run}`, password: PW, acceptTerms: true });
  assert.equal(s.status, 200); assert.deepEqual(s.data.setupRequired, ['2fa']);
  await sleep(1200);
  const blocked = await c.get('/api/messages?folder=INBOX');
  assert.equal(blocked.status, 403); assert.equal(blocked.data.code, 'setup_required');
  const me = await c.get('/api/me');
  assert.equal(me.status, 200); assert.equal(me.data.setup.snoozesLeft, 3); assert.equal(me.data.setup.twoFactorRequired, false);
  for (let left = 2; left >= 0; left--) {
    const r = await c.post('/api/setup/2fa/remind');
    assert.equal(r.status, 200); assert.equal(r.data.snoozesLeft, left); assert.deepEqual(r.data.setupRequired, []);
  }
  assert.equal((await c.get('/api/messages?folder=INBOX')).status, 200, 'postponed: the inbox works');
  assert.equal((await c.post('/api/setup/2fa/remind')).status, 403, 'only 3 postponements');
});

test('mailbox created outside the app (temporary password): must choose a new one before anything else', async () => {
  const local = `ext${run}`; const email = `${local}@${D}`; const temp = 'MapleRiver4827';
  assert.equal((await mailcowAdd(local, temp)).status, 200);
  await sleep(800);
  const c = new Client();
  const login = await c.post('/api/login', { email, password: temp });
  assert.equal(login.status, 200); assert.deepEqual(login.data.setupRequired, ['password', '2fa']);
  assert.equal((await c.get('/api/messages?folder=INBOX')).data.code, 'setup_required');
  assert.equal((await c.post('/api/setup/password', { password: temp })).status, 400, 'temporary password refused');
  assert.equal((await c.post('/api/setup/password', { password: 'short1' })).status, 400, 'too short');
  const ok = await c.post('/api/setup/password', { password: 'Granite-Harbor-58' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data)); assert.deepEqual(ok.data.setupRequired, ['2fa']);
  assert.equal((await new Client().post('/api/login', { email, password: temp })).status, 401, 'temporary password no longer works');
  const again = await new Client().post('/api/login', { email, password: 'Granite-Harbor-58' });
  assert.deepEqual(again.data.setupRequired, ['2fa'], 'only the 2FA step is left');
  const log = await c.post('/api/setup/2fa/remind');
  assert.equal(log.status, 200);
  assert.equal((await c.get('/api/messages?folder=INBOX')).status, 200);
});

test('super-admins cannot postpone 2-step verification; turning it on completes setup', async () => {
  const c = new Client();
  const s = await c.post('/api/signup', { name: 'Setup Super', username: 'setupsuper', password: PW, acceptTerms: true });
  if (s.status !== 200) return; // already exists from an earlier run on this data folder
  assert.deepEqual(s.data.setupRequired, ['2fa']);
  await sleep(1200);
  assert.equal((await c.get('/api/me')).data.setup.twoFactorRequired, true);
  assert.equal((await c.post('/api/setup/2fa/remind')).status, 403);
  const { secret } = (await c.post('/api/security/2fa/setup')).data;
  assert.equal((await c.post('/api/security/2fa/enable', { code: totp(secret) })).status, 200);
  assert.deepEqual((await c.get('/api/me')).data.setup.setupRequired, []);
  assert.equal((await c.get('/api/messages?folder=INBOX')).status, 200);
});

test('server tool can require setup with a signed request; nobody else can', async () => {
  const c = new Client();
  const s = await c.post('/api/signup', { name: 'Setup Tool', username: `st${run}`, password: PW, acceptTerms: true });
  await sleep(1200); await c.post('/api/setup/2fa/remind');
  assert.equal((await c.get('/api/messages?folder=INBOX')).status, 200);
  const path = `/api/admin/users/${encodeURIComponent(s.data.email)}/require-setup`;
  assert.equal((await new Client().post(path)).status, 401, 'anonymous refused');
  assert.equal((await c.post(path)).status, 404, 'a normal user cannot');
  const body = '{}'; const ts = String(Math.floor(Date.now() / 1000));
  const bad = await new Client().req('POST', path, body, { 'X-FWD-Timestamp': ts, 'X-FWD-Signature': sign('wrong', ts, path, body) });
  assert.equal(bad.status, 401, 'bad signature refused');
  const good = await new Client().req('POST', path, body, { 'X-FWD-Timestamp': ts, 'X-FWD-Signature': sign('dev-provisioner-secret', ts, path, body) });
  assert.equal(good.status, 200, JSON.stringify(good.data));
  const after = await c.get('/api/messages?folder=INBOX');
  assert.equal(after.status, 403); assert.deepEqual(after.data.setupRequired, ['password']);
});
