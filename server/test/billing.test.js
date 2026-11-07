// Billing integration tests: needs the stack from dev/start-stack.sh (mock mailcow + mock Stripe, DEV_SKIP_DNS_VERIFY).
import { test } from 'node:test';
import { finishSetup } from './setup-helper.js';
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
    if (this.autoSetup !== false && method === 'POST' && /^\/api\/(login|login\/2fa|signup|password\/reset)$/.test(path) && r.status === 200 && data?.setupRequired?.length) this.password = await finishSetup((m, p, b) => this.req(m, p, b), data, body?.password);
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

test('shared mailboxes: free, members only, read-only members cannot send', async () => {
  const a = await newAdmin(`shr${run}`);
  const domain = `shared${run}.test`;
  const { orgId } = (await a.post('/api/domains', { domain, orgName: `Shared ${run}` })).data;
  await a.post(`/api/domains/${domain}/verify`);
  const { url } = (await a.post(`/api/billing/${orgId}/checkout`, { interval: 'month', seats: 2 })).data;
  const sid = new URL((await fetch(url, { method: 'POST', redirect: 'manual' })).headers.get('location')).searchParams.get('session_id');
  await a.post('/api/billing/confirm', { sessionId: sid });
  for (const l of ['ann', 'ben']) assert.equal((await addUser(a, domain, l)).status, 200);
  const created = await a.post(`/api/admin/orgs/${orgId}/shared-mailboxes`, { domain, localPart: 'support', name: 'Support',
    members: [{ email: `ann@${domain}`, canSend: true }, { email: `ben@${domain}`, canSend: false }] });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.equal((await a.get(`/api/billing/${orgId}`)).data.paidSeats, 2, 'no extra seat for a shared mailbox');
  assert.ok(!(await a.get(`/api/admin/users?domain=${domain}`)).data.some((u) => u.email === `support@${domain}`), 'not listed as a person');
  assert.equal((await a.post(`/api/admin/orgs/${orgId}/shared-mailboxes`, { domain, localPart: 'x', members: ['someone@elsewhere.test'] })).status, 400);

  const login = async (l) => { const c = new Client(); assert.equal((await c.post('/api/login', { email: `${l}@${domain}`, password: PW })).status, 200); return c; };
  const ann = await login('ann'); const ben = await login('ben');
  const as = (c, method, path, body, box = `support@${domain}`) => fetch(BASE + path, { method, headers: { Cookie: c.cookie, 'X-Forwarded-For': c.ip, 'X-Requested-With': 'mailcow-client', 'X-Mailbox': box }, body });
  const sharedList = (await ann.get('/api/shared-mailboxes')).data;
  assert.deepEqual(sharedList.map(({ mailboxId, ...x }) => x), [{ email: `support@${domain}`, name: 'Support', canSend: true, archive: false }]);
  assert.match(sharedList[0].mailboxId, /^\d{6}-\d{3}-SU$/, 'business mailbox ID: account-number-initials');
  // the ID in the URL opens the shared mailbox for a member, and is a 404 for anyone else
  const viaId = await fetch(`${BASE}/api/messages?folder=INBOX`, { headers: { Cookie: ann.cookie, 'X-Forwarded-For': ann.ip, 'X-Mailbox-Id': sharedList[0].mailboxId } });
  assert.equal(viaId.status, 200);
  const outsider = await fetch(`${BASE}/api/messages?folder=INBOX`, { headers: { Cookie: a.cookie, 'X-Forwarded-For': a.ip, 'X-Mailbox-Id': sharedList[0].mailboxId } });
  assert.equal(outsider.status, 404);

  // a customer writes to support@; both members see it
  const fd = new FormData(); fd.append('to', `support@${domain}`); fd.append('subject', `Help ${run}`); fd.append('text', 'my order');
  assert.equal((await fetch(`${BASE}/api/send`, { method: 'POST', headers: { Cookie: a.cookie, 'X-Forwarded-For': a.ip, 'X-Requested-With': 'mailcow-client' }, body: fd })).status, 200);
  await sleep(1500);
  for (const c of [ann, ben]) {
    const list = await (await as(c, 'GET', '/api/messages?folder=INBOX')).json();
    assert.ok(list.messages.some((m) => m.subject === `Help ${run}`));
  }
  // ann replies from support@, ben (read-only) can't
  const reply = () => { const f = new FormData(); f.append('to', `ann@${domain}`); f.append('subject', `Re: Help ${run}`); f.append('text', 'on it'); return f; };
  assert.equal((await as(ann, 'POST', '/api/send', reply())).status, 200);
  assert.equal((await as(ben, 'POST', '/api/send', reply())).status, 403);
  // outsiders and the admin (not a member) can't open it
  assert.equal((await as(a, 'GET', '/api/messages?folder=INBOX')).status, 403);
  // their own mailbox still works normally
  assert.equal((await ben.get('/api/me')).data.email, `ben@${domain}`);
  // removing ben takes effect immediately
  await a.req('PUT', `/api/admin/orgs/${orgId}/shared-mailboxes/support@${domain}`, { members: [{ email: `ann@${domain}`, canSend: true }] });
  assert.equal((await as(ben, 'GET', '/api/messages?folder=INBOX')).status, 403);
});

test('shared mailbox header never reaches account settings', async () => {
  // Uses the shared mailbox from the previous test's naming scheme: create a fresh one quickly
  const a = await newAdmin(`shx${run}`);
  const domain = `sx${run}.test`;
  const { orgId } = (await a.post('/api/domains', { domain, orgName: `SX ${run}` })).data;
  await a.post(`/api/domains/${domain}/verify`);
  const { url } = (await a.post(`/api/billing/${orgId}/checkout`, { interval: 'month', seats: 1 })).data;
  const sid = new URL((await fetch(url, { method: 'POST', redirect: 'manual' })).headers.get('location')).searchParams.get('session_id');
  await a.post('/api/billing/confirm', { sessionId: sid });
  assert.equal((await addUser(a, domain, 'zed')).status, 200);
  await a.post(`/api/admin/orgs/${orgId}/shared-mailboxes`, { domain, localPart: 'info', members: [{ email: `zed@${domain}`, canSend: true }] });
  const z = new Client(); await z.post('/api/login', { email: `zed@${domain}`, password: PW });
  const h = { Cookie: z.cookie, 'X-Forwarded-For': z.ip, 'X-Requested-With': 'mailcow-client', 'X-Mailbox': `info@${domain}` };
  const sec = await (await fetch(`${BASE}/api/security`, { headers: h })).json();
  assert.equal(sec.email ?? `zed@${domain}`, `zed@${domain}`);
  const me = await (await fetch(`${BASE}/api/me`, { headers: h })).json();
  assert.equal(me.email, `zed@${domain}`);
  const sessions = await (await fetch(`${BASE}/api/security/sessions`, { headers: h })).json();
  assert.ok(Array.isArray(sessions) && sessions.length >= 1, 'own sessions, not the shared box');
});

test('archive / legal hold: copies via mailcow BCC maps, read-only for viewers', async () => {
  const a = await newAdmin(`arc${run}`);
  const domain = `arc${run}.test`;
  const { orgId } = (await a.post('/api/domains', { domain, orgName: `Arc ${run}` })).data;
  await a.post(`/api/domains/${domain}/verify`);
  const { url } = (await a.post(`/api/billing/${orgId}/checkout`, { interval: 'month', seats: 2 })).data;
  const sid = new URL((await fetch(url, { method: 'POST', redirect: 'manual' })).headers.get('location')).searchParams.get('session_id');
  await a.post('/api/billing/confirm', { sessionId: sid });
  for (const l of ['hr', 'sam']) assert.equal((await addUser(a, domain, l)).status, 200);
  const r = await a.req('PUT', `/api/admin/orgs/${orgId}/archive`, { enabled: true, scope: 'all', viewers: [`hr@${domain}`] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.maps, 2);
  const maps = await (await fetch(`${process.env.MOCK_MAILCOW || 'http://127.0.0.1:8099'}/api/v1/get/bcc/all`, { headers: { 'X-API-Key': 'dev-key' } })).json();
  assert.deepEqual(maps.filter((m) => m.bcc_dest === r.data.mailbox).map((m) => `${m.local_dest}|${m.type}`).sort(), [`${domain}|rcpt`, `${domain}|sender`]);
  assert.equal((await a.get(`/api/billing/${orgId}`)).data.paidSeats, 2, 'archive is free');

  const hr = new Client(); await hr.post('/api/login', { email: `hr@${domain}`, password: PW });
  const boxes = (await hr.get('/api/shared-mailboxes')).data;
  assert.deepEqual(boxes.map((b) => [b.email, b.archive, b.canSend]), [[r.data.mailbox, true, false]]);
  const h = { Cookie: hr.cookie, 'X-Forwarded-For': hr.ip, 'X-Requested-With': 'mailcow-client', 'X-Mailbox': r.data.mailbox, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${BASE}/api/messages?folder=INBOX`, { headers: h })).status, 200, 'viewers can read');
  assert.equal((await fetch(`${BASE}/api/delete`, { method: 'POST', headers: h, body: JSON.stringify({ folder: 'INBOX', uids: [1] }) })).status, 403, 'nobody can delete');
  assert.equal((await fetch(`${BASE}/api/empty`, { method: 'POST', headers: h, body: JSON.stringify({ folder: 'INBOX' }) })).status, 403);
  const sam = new Client(); await sam.post('/api/login', { email: `sam@${domain}`, password: PW });
  assert.equal((await sam.get('/api/shared-mailboxes')).data.length, 0, 'not a viewer');
  assert.equal((await sam.req('PUT', `/api/admin/orgs/${orgId}/archive`, { enabled: false })).status, 403);

  // narrow to one person on legal hold; turning off removes the maps
  const held = await a.req('PUT', `/api/admin/orgs/${orgId}/archive`, { enabled: true, scope: 'people', people: [`sam@${domain}`], viewers: [`hr@${domain}`] });
  assert.equal(held.data.maps, 2);
  const off = await a.req('PUT', `/api/admin/orgs/${orgId}/archive`, { enabled: false, viewers: [`hr@${domain}`] });
  assert.equal(off.data.maps, 0);
});

test('business mailbox IDs: account-number-mailbox-initials; renaming moves the URL with a 301', async () => {
  const a = await newAdmin(`bid${run}`);
  const domain = `bid${run}.test`;
  const { orgId } = (await a.post('/api/domains', { domain, orgName: `Bid ${run}` })).data;
  await a.post(`/api/domains/${domain}/verify`);
  const { url } = (await a.post(`/api/billing/${orgId}/checkout`, { interval: 'month', seats: 2 })).data;
  const sid = new URL((await fetch(url, { method: 'POST', redirect: 'manual' })).headers.get('location')).searchParams.get('session_id');
  await a.post('/api/billing/confirm', { sessionId: sid });
  assert.equal((await a.post('/api/admin/users', { domain, localPart: 'pat', name: 'Pat Smith', password: PW, welcome: false })).status, 200);
  assert.equal((await a.post('/api/admin/users', { domain, localPart: 'lee', name: 'Lee Ng', password: PW, welcome: false })).status, 200);
  const pat = new Client(); const login = await pat.post('/api/login', { email: `pat@${domain}`, password: PW });
  const [acct, no, ini] = login.data.mailboxId.split('-');
  assert.match(acct, /^\d{6}$/); assert.equal(ini, 'PS');
  const lee = new Client(); const lid = (await lee.post('/api/login', { email: `lee@${domain}`, password: PW })).data.mailboxId;
  assert.equal(lid.split('-')[0], acct, 'same business, same account number');
  assert.equal(Number(lid.split('-')[1]), Number(no) + 1, 'next mailbox number');
  // rename: new initials, old URL redirects permanently
  await a.req('PATCH', '/api/admin/users', { email: `pat@${domain}`, name: 'Pat Jones' });
  const page = await fetch(`${BASE}/${login.data.mailboxId}/inbox`, { headers: { Cookie: pat.cookie, 'X-Forwarded-For': pat.ip }, redirect: 'manual' });
  assert.equal(page.status, 301);
  assert.equal(page.headers.get('location'), `/${acct}-${no}-PJ/inbox`);
});

test('invite people: mailbox via the provisioner, emailed one-time link, no password in the email, lands in the inbox', async () => {
  const a = await newAdmin(`inv${run}`);
  const domain = `inv${run}.test`;
  const { orgId } = (await a.post('/api/domains', { domain, orgName: `Inv ${run}` })).data;
  await a.post(`/api/domains/${domain}/verify`);
  const { url } = (await a.post(`/api/billing/${orgId}/checkout`, { interval: 'year', seats: 2 })).data;
  const sid = new URL((await fetch(url, { method: 'POST', redirect: 'manual' })).headers.get('location')).searchParams.get('session_id');
  await a.post('/api/billing/confirm', { sessionId: sid });
  // the invitee's existing address: another mailbox we can read
  const personal = new Client(); const ps = await personal.post('/api/signup', { name: 'Kim Personal', username: `kimp${run}`, password: PW, acceptTerms: true });
  assert.equal(ps.status, 200); await sleep(1200);
  const r = await a.post('/api/admin/users', { domain, localPart: 'kim', name: 'Kim Lee', inviteEmail: ps.data.email });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.invited, ps.data.email); assert.ok(!r.data.setup, 'no password or QR when inviting');
  await sleep(1500);
  const list = (await personal.get('/api/messages?folder=INBOX')).data.messages;
  const inv = list.find((m) => /invited you/.test(m.subject));
  assert.ok(inv, 'invite email arrived');
  const msg = (await personal.get(`/api/message?folder=INBOX&uid=${inv.uid}`)).data;
  const body = `${msg.html || ''} ${msg.text || ''}`;
  assert.ok(body.includes(`kim@${domain}`));
  const token = /reset=([A-Za-z0-9_-]+)/.exec(body)[1];
  // accept: choose a password, signed straight in, recovery email set from the invite
  const kim = new Client();
  const acc = await kim.post('/api/password/reset', { token, password: 'Blue-Harbor-73x!Q' });
  assert.equal(acc.status, 200, JSON.stringify(acc.data));
  assert.match(acc.data.redirect, /\/\d{6}-\d{3}-KL\/inbox$/);
  const me = (await kim.get('/api/me')).data;
  assert.equal(me.email, `kim@${domain}`);
  const sec = (await kim.get('/api/security')).data;
  assert.equal(sec.recoveryEmail, ps.data.email); assert.equal(sec.recoveryVerified, true);
  assert.equal((await new Client().post('/api/password/reset', { token, password: 'Another-9x!Pw' })).status, 400, 'link works once');
  // only admins of that business can invite or resend
  assert.equal((await kim.post('/api/admin/users/invite', { email: `kim@${domain}`, inviteEmail: ps.data.email })).status, 403);
  assert.equal((await a.post('/api/admin/users/invite', { email: `kim@${domain}`, inviteEmail: ps.data.email })).status, 200);
});
