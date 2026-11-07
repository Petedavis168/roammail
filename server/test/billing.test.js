// Billing integration tests: needs the stack from dev/start-stack.sh (mock mailcow + mock Stripe, DEV_SKIP_DNS_VERIFY).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const D = process.env.TEST_DOMAIN || 'free.test'; // the sign-up domain of the server under test

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const STRIPE = process.env.MOCK_STRIPE || 'http://127.0.0.1:12111';
const PW = 'Tq9-vLm2-Zx81';
const run = crypto.randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor() { this.cookie = ''; this.ip = `198.18.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`; }
  async req(method, path, body) {
    const headers = { 'X-Forwarded-For': this.ip, 'X-Requested-With': 'mailcow-client', ...(this.cookie ? { Cookie: this.cookie } : {}) };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of r.headers.getSetCookie?.() || []) if (c.startsWith('mc_session=')) this.cookie = c.split(';')[0];
    const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
    return { status: r.status, data };
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
async function newAdmin(username) {
  const c = new Client();
  let r = await c.post('/api/signup', { name: username, username, password: PW, acceptTerms: true });
  if (r.status === 409) { r = await c.post('/api/login', { email: `${username}@${D}`, password: PW }); if (r.data?.twoFactor) return null; }
  assert.ok(r.status === 200, JSON.stringify(r.data));
  await sleep(1200);
  const me = (await c.get('/api/me')).data;
  if (!me.twoFactor?.enabled) {
    const { secret } = (await c.post('/api/security/2fa/setup')).data;
    assert.equal((await c.post('/api/security/2fa/enable', { code: totp(secret) })).status, 200);
  }
  return c;
}
const addUser = (c, domain, local) => c.post('/api/admin/users', { domain, localPart: local, name: local, password: PW, welcome: false });

test('standard business: pays at the end, seats follow users, webhooks are verified', async () => {
  const a = await newAdmin(`biz${run}`);
  const domain = `shop${run}.test`;
  const { orgId } = (await a.post('/api/domains', { domain, orgName: `Shop ${run}` })).data;
  const v = (await a.post(`/api/domains/${domain}/verify`)).data;
  assert.equal(v.status, 'verified'); assert.equal(v.needsPayment, true);
  assert.equal((await addUser(a, domain, 'first')).status, 400, 'no users before the domain is live');

  const { url } = (await a.post(`/api/billing/${orgId}/checkout`, { interval: 'month', seats: 1 })).data;
  assert.match(url, /\/pay\?s=cs_test_/);
  const paid = await fetch(url, { method: 'POST', redirect: 'manual' });
  const sid = new URL(paid.headers.get('location')).searchParams.get('session_id');
  await sleep(500);
  assert.equal((await a.post('/api/billing/confirm', { sessionId: sid })).data.ok, true);
  let b = (await a.get(`/api/billing/${orgId}`)).data;
  assert.deepEqual([b.status, b.paidSeats, b.interval], ['active', 1, 'month']);
  assert.equal((await a.get(`/api/domains/${domain}`)).data.status, 'active');

  assert.equal((await addUser(a, domain, 'first')).status, 200);
  const second = await addUser(a, domain, 'second');
  assert.equal(second.status, 402); assert.equal(second.data.code, 'seat_required');
  assert.equal((await a.post(`/api/billing/${orgId}/seats`)).status, 200);
  assert.equal((await addUser(a, domain, 'second')).status, 200);
  assert.equal((await a.get(`/api/billing/${orgId}`)).data.paidSeats, 2);
  await a.req('DELETE', `/api/admin/users?email=second@${domain}`);
  await sleep(500);
  assert.equal((await a.get(`/api/billing/${orgId}`)).data.paidSeats, 1, 'removing a user removes the paid seat');

  // forged webhook is rejected; a different org can't claim this checkout
  const forged = await fetch(`${BASE}/api/billing/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${Math.floor(Date.now() / 1000)},v1=deadbeef` },
    body: JSON.stringify({ id: 'evt_forged', type: 'customer.subscription.deleted', data: { object: { metadata: { org_id: String(orgId) } } } }) });
  assert.equal(forged.status, 400);
  const other = await newAdmin(`other${run}`);
  assert.equal((await other.post('/api/billing/confirm', { sessionId: sid })).status, 403);
  assert.equal((await other.get(`/api/billing/${orgId}`)).status, 403);

  // checkout asked Stripe for tax and a trial; the admin got a receipt
  const params = await (await fetch(`${STRIPE}/v1/test/last-session`, { headers: { Authorization: 'Bearer sk_test_mock' } })).json();
  assert.equal(params.automatic_tax?.enabled, 'true'); assert.equal(params.subscription_data?.trial_period_days, '14');
  const inbox = async () => (await a.get('/api/messages?folder=INBOX')).data.messages.map((m) => m.subject);
  assert.ok((await inbox()).some((x) => /^Receipt: \$4\.00 paid/.test(x)), 'receipt emailed to the admin');

  // a failed renewal marks the business past due and tells the admin
  const sub = (await (await fetch(`${STRIPE}/v1/checkout/sessions/${sid}`, { headers: { Authorization: 'Bearer sk_test_mock' } })).json()).subscription;
  await fetch(`${STRIPE}/v1/test/fail`, { method: 'POST', headers: { Authorization: 'Bearer sk_test_mock', 'Content-Type': 'application/x-www-form-urlencoded' }, body: `subscription=${sub}` });
  await sleep(1500);
  assert.equal((await a.get(`/api/billing/${orgId}`)).data.status, 'past_due');
  assert.ok((await inbox()).some((x) => /Payment failed/.test(x)), 'failed-payment email sent');

  // a real (signed) cancellation webhook from Stripe is applied
  await fetch(`${STRIPE}/v1/test/cancel`, { method: 'POST', headers: { Authorization: 'Bearer sk_test_mock', 'Content-Type': 'application/x-www-form-urlencoded' }, body: `subscription=${sub}` });
  await sleep(500);
  assert.equal((await a.get(`/api/billing/${orgId}`)).data.status, 'canceled');
});

test('Friendly Web Services customer: code makes the first mailbox free, codes are single use', async (t) => {
  const owner = await newAdmin('billingsuper');
  if (!owner) return t.skip('billingsuper@free.test already has 2FA from an earlier run; restart with a fresh data folder');
  const { code } = (await owner.post('/api/super/friendly-codes', { note: `test ${run}` })).data;
  assert.match(code, /^FWS-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const f = await newAdmin(`friend${run}`);
  const domain = `friend${run}.test`;
  const { orgId } = (await f.post('/api/domains', { domain, orgName: `Friend ${run}` })).data;
  assert.equal((await f.post(`/api/billing/${orgId}/friendly`, { code: 'FWS-AAAA-BBBB-CCCC' })).status, 400);
  assert.equal((await f.post(`/api/billing/${orgId}/friendly`, { code })).status, 200);
  assert.equal((await f.post(`/api/domains/${domain}/verify`)).data.status, 'active', 'no payment needed to go live');
  assert.equal((await addUser(f, domain, 'boss')).status, 200, 'first mailbox is free');
  const extra = await addUser(f, domain, 'helper');
  assert.equal(extra.status, 402); assert.equal(extra.data.code, 'checkout_required');
  // code can't be used twice
  const g = await newAdmin(`again${run}`);
  const o2 = (await g.post('/api/domains', { domain: `again${run}.test`, orgName: 'Again' })).data.orgId;
  assert.equal((await g.post(`/api/billing/${o2}/friendly`, { code })).status, 400);
  // only super-admins can create codes
  assert.equal((await f.post('/api/super/friendly-codes', { note: 'x' })).status, 403);
});

test('groups: department lists stay in sync, send-as is limited to members', async () => {
  const a = await newAdmin(`grp${run}`);
  const domain = `team${run}.test`;
  const { orgId } = (await a.post('/api/domains', { domain, orgName: `Team ${run}` })).data;
  await a.post(`/api/domains/${domain}/verify`);
  const { url } = (await a.post(`/api/billing/${orgId}/checkout`, { interval: 'year', seats: 4 })).data;
  const sid = new URL((await fetch(url, { method: 'POST', redirect: 'manual' })).headers.get('location')).searchParams.get('session_id');
  await a.post('/api/billing/confirm', { sessionId: sid });
  for (const [l, dep] of [['ann', 'Sales'], ['ben', 'Sales'], ['cat', 'Support']]) {
    assert.equal((await a.post('/api/admin/users', { domain, localPart: l, name: l, department: dep, password: PW, welcome: false })).status, 200);
  }
  assert.equal((await a.post(`/api/admin/orgs/${orgId}/groups`, { name: 'Sales', localPart: 'sales', kind: 'department', department: 'Sales' })).status, 200);
  assert.equal((await a.post(`/api/admin/orgs/${orgId}/groups`, { name: 'x', localPart: 'ext', kind: 'static', members: ['someone@gmail.com'] })).status, 403, 'outsiders need permission');
  assert.equal((await a.post(`/api/admin/orgs/${orgId}/groups`, { name: 'x', localPart: 'ann', kind: 'everyone' })).status, 409, "can't take a person's address");
  assert.equal((await a.post('/api/admin/users', { domain, localPart: 'dan', name: 'dan', department: 'Sales', password: PW, welcome: false })).status, 200);
  await sleep(800);
  const g = (await a.get(`/api/admin/orgs/${orgId}/groups`)).data.groups.find((x) => x.address === `sales@${domain}`);
  assert.deepEqual(g.members.sort(), [`ann@${domain}`, `ben@${domain}`, `dan@${domain}`], 'new hire joined automatically');
  const ann = new Client(); await ann.post('/api/login', { email: `ann@${domain}`, password: PW });
  const cat = new Client(); await cat.post('/api/login', { email: `cat@${domain}`, password: PW });
  const send = (c, from) => { const fd = new FormData(); fd.append('to', `ben@${domain}`); fd.append('subject', 'x'); fd.append('text', 'x'); fd.append('fromAddress', from); return fetch(`${BASE}/api/send`, { method: 'POST', headers: { Cookie: c.cookie, 'X-Requested-With': 'mailcow-client', 'X-Forwarded-For': c.ip }, body: fd }); };
  assert.equal((await send(ann, `sales@${domain}`)).status, 200, 'member can send as the group');
  assert.equal((await send(cat, `sales@${domain}`)).status, 403, 'non-member cannot');
  assert.equal((await send(ann, `owner@${D}`)).status, 403, 'nobody can send as an unrelated address');
  assert.equal((await ann.get(`/api/admin/orgs/${orgId}/groups`)).status, 403, 'employees cannot manage groups');
});

test('bulk import: preview, problems reported, extra seats confirmed and billed', async () => {
  const a = await newAdmin(`imp${run}`);
  const domain = `import${run}.test`;
  const { orgId } = (await a.post('/api/domains', { domain, orgName: `Import ${run}` })).data;
  await a.post(`/api/domains/${domain}/verify`);
  const { url } = (await a.post(`/api/billing/${orgId}/checkout`, { interval: 'month', seats: 1 })).data;
  const sid = new URL((await fetch(url, { method: 'POST', redirect: 'manual' })).headers.get('location')).searchParams.get('session_id');
  await a.post('/api/billing/confirm', { sessionId: sid });
  const csv = [
    'Name,Email,Job title,Department,Admin',
    '"Lee, Ann",ann,Sales lead,Sales,yes',
    `Bob Stone,bob@${domain},Engineer,"R&D",no`,
    'Cara Diaz,cara,,Support,',
    'Bad Domain,dan@elsewhere.test,,,',
    'Duplicate,ann,,,',
    'Bad Name,bad name!,,,',
  ].join('\r\n');
  const dry = await a.post('/api/admin/users/import', { domain, csv, dryRun: true });
  assert.equal(dry.status, 200, JSON.stringify(dry.data));
  assert.equal(dry.data.preview.valid, 3);
  assert.equal(dry.data.preview.extraSeats, 2, 'one seat already paid');
  assert.deepEqual(dry.data.preview.problems.map((p) => p.row), [5, 6, 7]);
  assert.ok(!dry.data.people.some((p) => 'password' in p), 'passwords are not sent in the preview');

  const needConfirm = await a.post('/api/admin/users/import', { domain, csv, welcome: false });
  assert.equal(needConfirm.status, 402); assert.equal(needConfirm.data.code, 'seat_required');

  const done = await a.post('/api/admin/users/import', { domain, csv, welcome: false, confirmSeats: true });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.deepEqual(done.data.results.map((r) => [r.email, r.ok]), [[`ann@${domain}`, true], [`bob@${domain}`, true], [`cara@${domain}`, true]]);
  assert.ok(done.data.results.every((r) => r.password && r.password.length >= 12), 'passwords generated for the admin to hand out');
  assert.equal((await a.get(`/api/billing/${orgId}`)).data.paidSeats, 3);
  const users = (await a.get(`/api/admin/users?domain=${domain}`)).data;
  const ann = users.find((u) => u.email === `ann@${domain}`);
  assert.equal(ann.admin, true); assert.equal(ann.title, 'Sales lead'); assert.equal(ann.name, 'Lee, Ann');
  assert.equal(users.find((u) => u.email === `bob@${domain}`).department, 'R&D');
  // another business's admin can't import into this domain
  const other = await newAdmin(`imo${run}`);
  assert.equal((await other.post('/api/admin/users/import', { domain, csv, dryRun: true })).status, 403);
});
