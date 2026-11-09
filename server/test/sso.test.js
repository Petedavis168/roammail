// Sign in with Microsoft / Google for businesses, against the stand-in (dev/mock-idp.js): an admin connects the
// company's tenant, an employee links their account (only from that tenant), then signs in with one click.
// Personal Google accounts, other companies, tampered state, a password change and disconnecting all stop it.
// Needs the running stack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { finishSetup } from './setup-helper.js';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const D = process.env.TEST_DOMAIN || 'free.test';
const IDP = 'http://127.0.0.1:8095';
const PW = 'Tq9-vLm2-Zx81';
const run = crypto.randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor() { this.jar = {}; this.ip = `198.32.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`; }
  async req(method, path, body) {
    const url = path.startsWith('http') ? path : BASE + path;
    const r = await fetch(url, { method, redirect: 'manual', headers: { 'X-Requested-With': 'mailcow-client', 'X-Forwarded-For': this.ip, ...(Object.keys(this.jar).length ? { Cookie: Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    for (const c of r.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); const v = kv.slice(i + 1); if (v) this.jar[kv.slice(0, i)] = v; else delete this.jar[kv.slice(0, i)]; }
    const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch { /* html or empty */ }
    return { status: r.status, data, location: r.headers.get('location') };
  }
  get(p) { return this.req('GET', p); }
  post(p, b) { return this.req('POST', p, b || {}); }
  /** Go to the identity provider as `claims` and come back; returns where Roammail sent the browser. */
  async roundTrip(url, claims) {
    await fetch(`${IDP}/test/next`, { method: 'POST', body: JSON.stringify({ claims }) });
    const atIdp = await fetch(url, { redirect: 'manual' });
    assert.equal(atIdp.status, 302);
    return (await this.get(atIdp.headers.get('location'))).location || '';
  }
}
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function totp(secret) {
  let bits = 0, v = 0; const out = [];
  for (const c of secret) { v = (v << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } }
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = crypto.createHmac('sha1', Buffer.from(out)).update(buf).digest(); const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

test('SSO: admin connects the company, employee links once, then signs in with Microsoft', async (t) => {
  // a business with one employee (set up by a super-admin, as in the api tests)
  const admin = new Client();
  let r = await admin.post('/api/login', { email: `ssosuper@${D}`, password: PW });
  if (r.data?.twoFactor) return t.skip('ssosuper@free.test already has 2-step verification from an earlier run; use a fresh stack');
  if (r.status === 401) r = await admin.post('/api/signup', { name: 'Sso Admin', username: 'ssosuper', password: PW, acceptTerms: true, birthday: '1990-01-15', recoveryEmail: 'recovery@example.org', phone: '+15555550123' });
  assert.equal(r.status, 200, 'needs a fresh stack (ssosuper@free.test without 2-step verification)');
  await finishSetup((m, p, b) => admin.req(m, p, b), r.data, PW);
  const { secret } = (await admin.post('/api/security/2fa/setup')).data;
  assert.equal((await admin.post('/api/security/2fa/enable', { code: totp(secret) })).status, 200);
  const domain = `sso${run}.test`;
  await admin.post('/api/domains', { domain, orgName: `Contoso ${run}` });
  const ver = await admin.post(`/api/domains/${domain}/verify`, { skipVerification: true }); assert.equal(ver.data?.ok, true, JSON.stringify(ver));
  const orgId = (await admin.get('/api/admin/orgs')).data.find((o) => o.domains.some((d) => d.domain === domain)).id;
  await admin.req('PATCH', `/api/super/orgs/${orgId}/plan`, { plan: 'friendly' });
  assert.equal((await admin.post('/api/admin/users', { domain, localPart: 'emp', name: 'Emp Loyee', password: PW, welcome: false })).status, 200);
  await sleep(1500);
  const email = `emp@${domain}`;

  // 1. the admin connects Microsoft 365: their tenant is remembered
  let o = (await admin.get(`/api/sso/org/${orgId}`)).data;
  assert.deepEqual(o.available, { microsoft: true, google: true }); assert.equal(o.provider, null);
  const outsider = new Client(); await outsider.post('/api/signup', { name: 'Out Sider', username: `out${run}`, password: PW, acceptTerms: true, birthday: '1990-01-15', recoveryEmail: 'recovery@example.org', phone: '+15555550123' });
  assert.ok([403, 404].includes((await outsider.post(`/api/sso/org/${orgId}/connect`, { provider: 'microsoft' })).status), 'only the company’s admins');
  // a personal Google account has no company, so it can't be connected
  let back = await admin.roundTrip((await admin.post(`/api/sso/org/${orgId}/connect`, { provider: 'google' })).data.url, { sub: 'g-1', email: 'someone@gmail.com' });
  assert.match(back, /sso=personal-account/);
  back = await admin.roundTrip((await admin.post(`/api/sso/org/${orgId}/connect`, { provider: 'microsoft' })).data.url, { tid: 'TENANT-A', oid: 'admin-oid', email: 'boss@contoso.com' });
  assert.match(back, /sso=connected/);
  o = (await admin.get(`/api/sso/org/${orgId}`)).data;
  assert.equal(o.provider, 'microsoft'); assert.equal(o.tenant, 'tenant-a');

  // 2. the employee links their work account (needs their Roammail password; only from the company's tenant)
  const emp = new Client();
  const el = await emp.post('/api/login', { email, password: PW });
  assert.equal(el.status, 200);
  const EPW = await finishSetup((m, p, b) => emp.req(m, p, b), el.data, PW); // a first password set by the admin is temporary
  const meR = await emp.get('/api/sso/me'); let me = meR.data; assert.equal(meR.status, 200, JSON.stringify(meR.data));
  assert.equal(me.provider, 'microsoft'); assert.equal(me.linked, null);
  assert.equal((await emp.post('/api/sso/link', { password: 'wrong-password-1' })).status, 401);
  back = await emp.roundTrip((await emp.post('/api/sso/link', { password: EPW })).data.url, { tid: 'tenant-b', oid: 'emp-oid', email: 'emp@fabrikam.com' });
  assert.match(back, /sso=wrong-company/, 'another company’s account can’t be linked');
  back = await emp.roundTrip((await emp.post('/api/sso/link', { password: EPW })).data.url, { tid: 'tenant-a', oid: 'emp-oid', email: 'Emp@Contoso.com' });
  assert.match(back, /sso=linked/);
  me = (await emp.get('/api/sso/me')).data;
  assert.equal(me.linked.account, 'emp@contoso.com');

  // 3. one-click sign-in from a new device
  const phone = new Client();
  assert.deepEqual((await phone.get('/api/sso/options')).data, { microsoft: true, google: true });
  const start = await phone.get('/api/sso/login/microsoft?remember=1');
  assert.equal(start.status, 302); assert.match(start.location, /\/ms\/organizations\/oauth2\/v2\.0\/authorize\?/);
  back = await phone.roundTrip(start.location, { tid: 'tenant-a', oid: 'emp-oid', email: 'emp@contoso.com' });
  assert.match(back, /\/inbox$/, back);
  assert.equal((await phone.get('/api/me')).data.email, email);

  // someone else in the company who never linked, or the same person ID in another tenant: no
  const stranger = new Client();
  back = await stranger.roundTrip((await stranger.get('/api/sso/login/microsoft')).location, { tid: 'tenant-a', oid: 'other-oid', email: 'other@contoso.com' });
  assert.match(back, /sso=not-linked/);
  back = await stranger.roundTrip((await stranger.get('/api/sso/login/microsoft')).location, { tid: 'tenant-b', oid: 'emp-oid' });
  assert.match(back, /sso=not-linked/);
  assert.equal((await stranger.get('/api/me')).status, 401);
  // a sign-in link started by someone else (another browser) is refused, even with a valid code
  const attacker = new Client();
  await fetch(`${IDP}/test/next`, { method: 'POST', body: JSON.stringify({ claims: { tid: 'tenant-a', oid: 'emp-oid' } }) });
  const atIdp = await fetch((await attacker.get('/api/sso/login/microsoft')).location, { redirect: 'manual' });
  const victim = new Client();
  assert.match((await victim.get(atIdp.headers.get('location'))).location, /sso=expired/);
  assert.equal((await victim.get('/api/me')).status, 401);
  // a tampered or replayed state, or cancelling at Microsoft
  assert.match((await stranger.get('/api/sso/callback/microsoft?code=x&state=forged')).location, /sso=expired/);
  const st = new URL((await stranger.get('/api/sso/login/microsoft')).location).searchParams.get('state');
  assert.match((await stranger.get(`/api/sso/callback/google?code=x&state=${encodeURIComponent(st)}`)).location, /sso=expired/, 'state is for one provider');
  assert.match((await stranger.get(`/api/sso/callback/microsoft?error=access_denied&state=${encodeURIComponent(st)}`)).location, /sso=cancelled/);

  // 4. changing the Roammail password removes the link (the stored password would be wrong)
  const NEW = 'Wx7-pRt4-Kd92';
  assert.equal((await emp.post('/api/security/password', { current: EPW, next: NEW })).status, 200);
  assert.equal((await emp.post('/api/login', { email, password: NEW })).status, 200);
  assert.equal((await emp.get('/api/sso/me')).data.linked, null);
  back = await stranger.roundTrip((await stranger.get('/api/sso/login/microsoft')).location, { tid: 'tenant-a', oid: 'emp-oid' });
  assert.match(back, /sso=not-linked/);

  // 5. the admin disconnects the company: links go, and the option disappears for employees
  back = await emp.roundTrip((await emp.post('/api/sso/link', { password: NEW })).data.url, { tid: 'tenant-a', oid: 'emp-oid' });
  assert.match(back, /sso=linked/);
  assert.equal((await admin.req('DELETE', `/api/sso/org/${orgId}`)).status, 200);
  me = (await emp.get('/api/sso/me')).data;
  assert.equal(me.provider, null); assert.equal(me.linked, null);
  back = await stranger.roundTrip((await stranger.get('/api/sso/login/microsoft')).location, { tid: 'tenant-a', oid: 'emp-oid' });
  assert.match(back, /sso=not-linked/);
});
