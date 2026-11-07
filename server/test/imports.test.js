// Importing old mail (item 6): test login, sync jobs that stop by themselves, .mbox upload, admin bulk CSV.
// Needs the dev stack (dev/start-stack.sh). The local test mail server plays the "old provider".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { finishSetup } from './setup-helper.js';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const MOCK = process.env.MOCK_MAILCOW || 'http://127.0.0.1:8099';
const PW = 'Tq9-vLm2-Zx81';
const run = crypto.randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OLD = { provider: 'other', host: '127.0.0.1', port: 3143 };

class Client {
  constructor() { this.cookie = ''; this.ip = `198.18.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`; }
  async req(method, path, body) {
    const headers = { 'X-Requested-With': 'mailcow-client', 'X-Forwarded-For': this.ip };
    if (this.cookie) headers.Cookie = this.cookie;
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(BASE + path, { method, headers, body: payload });
    for (const c of res.headers.getSetCookie?.() || []) if (c.startsWith('mc_session=')) this.cookie = c.split(';')[0];
    const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    if (method === 'POST' && path === '/api/signup' && res.status === 200 && data?.setupRequired?.length) await finishSetup((m, p, b) => this.req(m, p, b), data, body?.password);
    return { status: res.status, data };
  }
  get(p) { return this.req('GET', p); }
  post(p, b) { return this.req('POST', p, b ?? {}); }
}
async function user(name) {
  const c = new Client();
  const r = await c.post('/api/signup', { name, username: `${name}${run}`, password: PW, acceptTerms: true, birthday: '1990-01-15', recoveryEmail: 'recovery@example.org', phone: '+15555550123' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await sleep(1200);
  c.email = r.data.email;
  return c;
}

test('import: the old login is tested first; a sync job runs for the sync window and then stops', async () => {
  const old = await user('impold'); const me = await user('impnew');
  const bad = await me.post('/api/imports/test', { ...OLD, user: old.email, password: 'wrong-password-9' });
  assert.equal(bad.status, 400); assert.match(bad.data.error, /rejected/);
  const t = await me.post('/api/imports/test', { ...OLD, user: old.email, password: PW });
  assert.equal(t.status, 200, JSON.stringify(t.data)); assert.ok(t.data.messages >= 1, 'counts the welcome message'); assert.ok(t.data.folders >= 1);
  assert.equal((await me.post('/api/imports', { ...OLD, user: old.email, password: 'wrong-password-9' })).status, 400, 'a typo never creates a job');

  const go = await me.post('/api/imports', { ...OLD, user: old.email, password: PW });
  assert.equal(go.status, 200, JSON.stringify(go.data));
  const jobs = await (await fetch(`${MOCK}/api/v1/get/syncjobs/all/no_log`, { headers: { 'X-API-Key': 'dev-key' } })).json();
  const job = jobs.find((j) => j.username === me.email && j.user1 === old.email);
  assert.ok(job, 'mailcow sync job created');
  assert.equal(Number(job.mins_interval), 20); assert.equal(Number(job.delete2duplicates), 1);
  let list = (await me.get('/api/imports')).data;
  assert.equal(list.imports[0].status, 'active'); assert.equal(list.imports[0].user, old.email);
  assert.ok(list.providers.aol && list.providers.outlook.oauth, 'AOL and Outlook offered');

  // the sync window (shortened for the test) ends: the job is switched off, the person is told
  for (let i = 0; i < 10 && list.imports[0].status === 'active'; i++) { await sleep(1000); list = (await me.get('/api/imports')).data; }
  assert.equal(list.imports[0].status, 'finished');
  const after = (await (await fetch(`${MOCK}/api/v1/get/syncjobs/all/no_log`, { headers: { 'X-API-Key': 'dev-key' } })).json()).find((j) => j.id === job.id);
  assert.equal(Number(after.active), 0, 'sync job switched off in mailcow');
  await sleep(1500);
  assert.ok((await me.get('/api/messages?folder=INBOX')).data.messages.some((m) => m.subject === 'Your import is complete'));
});

test('import: an .mbox file is copied into Imported/<name>', async () => {
  const me = await user('impmbox');
  const mbox = [
    'From alice@example.com Mon Jan  1 10:00:00 2024', 'From: Alice <alice@example.com>', `To: ${me.email}`, 'Subject: Old message one', 'Date: Mon, 1 Jan 2024 10:00:00 +0000', '', 'Hello', '>From the archive (escaped)', '',
    'From bob@example.com Tue Jan  2 11:00:00 2024', 'From: Bob <bob@example.com>', `To: ${me.email}`, 'Subject: Old message two', 'Date: Tue, 2 Jan 2024 11:00:00 +0000', '', 'Second', '',
  ].join('\n');
  const fd = new FormData(); fd.append('file', new Blob([mbox]), 'Old Gmail.mbox');
  const up = await me.req('POST', '/api/imports/upload', fd);
  assert.equal(up.status, 200, JSON.stringify(up.data)); assert.equal(up.data.folder, 'Imported/Old Gmail');
  let rec;
  for (let i = 0; i < 10; i++) { await sleep(700); rec = (await me.get('/api/imports')).data.imports.find((x) => x.id === up.data.id); if (rec?.status === 'finished') break; }
  assert.equal(rec.status, 'finished'); assert.equal(rec.copied, 2);
  const msgs = (await me.get(`/api/messages?folder=${encodeURIComponent('Imported/Old Gmail')}`)).data.messages;
  assert.deepEqual(msgs.map((m) => m.subject).sort(), ['Old message one', 'Old message two']);
});

test('import: bulk CSV only works for mailboxes the admin manages', async () => {
  const me = await user('impbulk');
  const csv = `mailbox,provider,old email,app password\nsomeone@free.test,gmail,x@gmail.com,abcd efgh ijkl mnop\n`;
  const r = await me.post('/api/admin/imports/bulk', { csv });
  assert.equal(r.status, 200); assert.equal(r.data.started, 0);
  assert.match(r.data.results[0].error, /not an admin|not found/i);
  assert.equal((await me.post('/api/admin/imports/bulk', { csv: 'name,email\na,b' })).status, 400, 'needs the right columns');
});

test('import: Outlook sign-in is offered only when Microsoft is set up; callback rejects a forged state', async () => {
  const me = await user('impms');
  const s = await me.get('/api/imports/outlook/start');
  assert.equal(s.status, 400); assert.match(s.data.error, /not set up/);
  const cb = await fetch(`${BASE}/api/imports/outlook/callback?code=x&state=forged`, { redirect: 'manual' });
  assert.equal(cb.status, 302); assert.match(cb.headers.get('location'), /import=expired/);
});
