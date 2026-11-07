// Tasks, notes and follow-ups (item 9). Needs the dev stack (dev/start-stack.sh).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { finishSetup } from './setup-helper.js';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const PW = 'Tq9-vLm2-Zx81';
const run = crypto.randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  patch(p, b) { return this.req('PATCH', p, b); }
  del(p) { return this.req('DELETE', p); }
}
async function user(name) {
  const c = new Client();
  const r = await c.post('/api/signup', { name, username: `${name}${run}`, password: PW, acceptTerms: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await sleep(1200);
  c.email = r.data.email;
  return c;
}
async function send(from, to, subject, extra = {}) {
  const fd = new FormData(); fd.append('to', to); fd.append('subject', subject); fd.append('text', 'hello');
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  const r = await from.req('POST', '/api/send', fd);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.messageId;
}

test('tasks: create, complete, reminders by email; private to their owner', async () => {
  const a = await user('tka'); const b = await user('tkb');
  const t = await a.post('/api/tasks', { title: 'Call Ann', dueAt: Date.now() + 864e5, message: { key: 'SU5CT1g.1', subject: 'Contract', mailboxId: '12345678' } });
  assert.equal(t.status, 200); assert.equal(t.data.title, 'Call Ann'); assert.equal(t.data.message.subject, 'Contract');
  assert.equal((await a.post('/api/tasks', { title: '  ' })).status, 400);
  assert.equal((await a.post('/api/tasks', { title: 'x', dueAt: 'soon' })).status, 400);
  assert.equal((await b.get('/api/tasks')).data.open.length, 0, 'b sees none of a\'s tasks');
  assert.equal((await b.patch(`/api/tasks/${t.data.id}`, { done: true })).status, 404);
  await b.del(`/api/tasks/${t.data.id}`);
  assert.equal((await a.get('/api/tasks')).data.open.length, 1, 'b cannot delete it');
  const done = await a.patch(`/api/tasks/${t.data.id}`, { done: true });
  assert.equal(done.data.done, true);
  assert.equal((await a.get('/api/tasks')).data.done.length, 1);

  // reminder: no push subscription, so it arrives by email
  await a.post('/api/tasks', { title: `Pay invoice ${run}`, remindAt: Date.now() + 500 });
  let got = false;
  for (let i = 0; i < 12 && !got; i++) {
    await sleep(1000);
    got = (await a.get('/api/messages?folder=INBOX')).data.messages.some((m) => m.subject === `Reminder: Pay invoice ${run}`);
  }
  assert.ok(got, 'reminder email arrived');
});

test('notes: on a contact or a conversation; private', async () => {
  const a = await user('nta'); const b = await user('ntb');
  const n1 = await a.post('/api/notes', { body: 'Prefers calls', contact: 'Ann@Example.com' });
  const n2 = await a.post('/api/notes', { body: 'Agreed 10% discount', thread: 'abc@example.com', threadSubject: 'Quote' });
  assert.equal(n1.status, 200); assert.equal(n1.data.contact, 'ann@example.com');
  assert.equal(n2.data.thread, '<abc@example.com>');
  assert.equal((await a.post('/api/notes', { body: 'x', contact: 'not an address' })).status, 400);
  const both = (await a.get('/api/notes?contact=ann@example.com&thread=%3Cabc@example.com%3E')).data;
  assert.equal(both.length, 2);
  assert.equal((await a.get('/api/notes?contact=ann@example.com')).data.length, 1);
  assert.equal((await b.get('/api/notes')).data.length, 0);
  assert.equal((await b.patch(`/api/notes/${n1.data.id}`, { body: 'hacked' })).status, 404);
  assert.equal((await a.patch(`/api/notes/${n1.data.id}`, { body: 'Prefers email' })).data.body, 'Prefers email');
  // included in the export
  const ex = (await a.get('/api/export-items')).data;
  assert.equal(ex.notes.length, 2); assert.equal(ex.mailbox, a.email);
});

test('follow-ups: reminded when nobody replies, quiet when they did', async () => {
  const a = await user('fua'); const b = await user('fub');
  const id1 = await send(a, b.email, `Proposal ${run}`);
  const id2 = await send(a, b.email, `Invoice ${run}`);
  assert.ok(id1 && id2, 'send returns the Message-ID');
  // b answers the invoice (In-Reply-To set, as the app does for replies)
  await sleep(1500);
  await send(b, a.email, `Re: Invoice ${run}`, { inReplyTo: id2, references: id2 });
  await sleep(1500);

  assert.equal((await a.post('/api/followups', { messageId: id1, subject: `Proposal ${run}`, remindAt: Date.now() - 1000 })).status, 400, 'must be in the future');
  const f1 = await a.post('/api/followups', { messageId: id1, subject: `Proposal ${run}`, recipients: b.email, remindAt: Date.now() + 800 });
  const f2 = await a.post('/api/followups', { messageId: id2, subject: `Invoice ${run}`, recipients: b.email, remindAt: Date.now() + 800 });
  assert.equal(f1.status, 200, JSON.stringify(f1.data)); assert.equal(f1.data.status, 'waiting');
  assert.equal((await b.get('/api/followups')).data.length, 0, 'private');

  let list = [];
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    list = (await a.get('/api/followups')).data;
    if (list.every((f) => ['due', 'replied'].includes(f.status))) break;
  }
  assert.equal(list.find((f) => f.id === f1.data.id)?.status, 'due', 'no reply: reminder');
  assert.equal(list.find((f) => f.id === f2.data.id)?.status, 'replied', 'replied: no reminder');
  await sleep(1500);
  const inbox = (await a.get('/api/messages?folder=INBOX')).data.messages;
  assert.ok(inbox.some((m) => m.subject === 'No reply yet'), 'reminder email for the unanswered one');
  assert.equal((await a.patch(`/api/followups/${f1.data.id}`, { status: 'done' })).data.status, 'done');
});
