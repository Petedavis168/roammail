// Delivery and read receipts between two Roammail users: request both, the reader is asked and sends a read receipt
// once, a delivery report arrives; both show on the sent email and the reports move to the Receipts folder.
// Needs the running stack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const D = process.env.TEST_DOMAIN || 'free.test';
const PW = 'Tq9-vLm2-Zx81';
const run = crypto.randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor() { this.cookie = ''; this.ip = `198.37.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`; }
  async req(method, path, body, form) {
    const r = await fetch(BASE + path, { method, headers: { 'X-Requested-With': 'mailcow-client', 'X-Forwarded-For': this.ip, ...(this.cookie ? { Cookie: this.cookie } : {}), ...(body && !form ? { 'Content-Type': 'application/json' } : {}) }, body: form || (body ? JSON.stringify(body) : undefined) });
    for (const c of r.headers.getSetCookie?.() || []) if (c.startsWith('mc_session=')) this.cookie = c.split(';')[0];
    const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
    return { status: r.status, data };
  }
  get(p, q) { return this.req('GET', q ? `${p}?${new URLSearchParams(q)}` : p); }
  post(p, b) { return this.req('POST', p, b || {}); }
}
async function signup(user) {
  const c = new Client();
  assert.equal((await c.post('/api/signup', { name: `Test ${user}`, username: user, password: PW, acceptTerms: true, birthday: '1990-01-15', recoveryEmail: 'recovery@example.org', phone: '+15555550123' })).status, 200);
  await c.post('/api/setup/2fa/remind'); await c.post('/api/setup/step', { step: 'done' });
  return c;
}

test('receipts: request delivery and read receipts, reader answers once, status on the sent email', async () => {
  const alice = await signup(`ra${run}`); const bob = await signup(`rb${run}`);
  const a = `ra${run}@${D}`; const b = `rb${run}@${D}`;
  await sleep(1500);

  const fd = new FormData();
  fd.append('to', b); fd.append('subject', 'Contract attached'); fd.append('text', 'Please sign.');
  fd.append('readReceipt', 'true'); fd.append('deliveryReceipt', 'true');
  const sent = await alice.req('POST', '/api/send', null, fd);
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const msgId = sent.data.messageId;
  let st = (await alice.get('/api/receipts', { messageId: msgId })).data;
  assert.equal(st.readRequested, true); assert.equal(st.deliveryRequested, true);
  assert.equal(st.recipients[0].address, b); assert.equal(st.recipients[0].read, null);
  await sleep(1500);

  // Bob opens it: it asks for a receipt; he sends one; a second try does nothing
  const inbox = (await bob.get('/api/messages', { folder: 'INBOX' })).data.messages;
  const m = inbox.find((x) => x.subject === 'Contract attached');
  let full = (await bob.get('/api/message', { folder: 'INBOX', uid: m.uid })).data;
  assert.equal(full.receiptRequested, true);
  assert.equal((await bob.post('/api/receipts/send', { folder: 'INBOX', uid: m.uid })).data.sent, true);
  assert.equal((await bob.post('/api/receipts/send', { folder: 'INBOX', uid: m.uid })).data.already, true, 'only once');
  full = (await bob.get('/api/message', { folder: 'INBOX', uid: m.uid })).data;
  assert.equal(full.receiptRequested, false);

  // the receiving server's delivery report (stand-in, as Postfix would send it)
  const dsn = nodemailer.createTransport({ host: '127.0.0.1', port: 3025, secure: false, auth: { user: b, pass: PW }, tls: { rejectUnauthorized: false } });
  const boundary = 'dsn-boundary';
  await dsn.sendMail({ envelope: { from: b, to: [a] }, raw: [
    `From: Mail Delivery System <${b}>`, `To: <${a}>`, 'Subject: Delivery Status Notification (Success)', 'MIME-Version: 1.0',
    `Content-Type: multipart/report; report-type=delivery-status; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain', '', 'Your message was delivered.', '',
    `--${boundary}`, 'Content-Type: message/delivery-status', '', 'Reporting-MTA: dns; mail.example.test', '',
    `Final-Recipient: rfc822; ${b}`, 'Action: delivered', 'Status: 2.0.0', '',
    `--${boundary}`, 'Content-Type: text/rfc822-headers', '', `Message-ID: ${msgId}`, `Subject: Contract attached`, '', `--${boundary}--`, ''].join('\r\n') });
  await sleep(2500);

  // Alice sees delivered and read; the two reports left her inbox for the Receipts folder
  st = (await alice.get('/api/receipts', { messageId: msgId })).data;
  assert.ok(st.recipients[0].read, 'read'); assert.ok(st.recipients[0].delivered, 'delivered');
  const left = (await alice.get('/api/messages', { folder: 'INBOX' })).data.messages;
  assert.ok(!left.some((x) => /^(Read: Contract attached|Delivery Status)/.test(x.subject)), 'reports moved out of the inbox');
  const filed = (await alice.get('/api/messages', { folder: 'Receipts' })).data.messages;
  assert.equal(filed.length, 2);

  // an email without a request can't be "answered"
  const plain = new FormData(); plain.append('to', b); plain.append('subject', 'No receipt please'); plain.append('text', 'hi');
  await alice.req('POST', '/api/send', null, plain);
  await sleep(1500);
  const p = (await bob.get('/api/messages', { folder: 'INBOX' })).data.messages.find((x) => x.subject === 'No receipt please');
  assert.equal((await bob.post('/api/receipts/send', { folder: 'INBOX', uid: p.uid })).status, 400);
});
