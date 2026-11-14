// iMessage-style status between Roammail users (Delivered / Read / typing), attachment safety, the "scanned"
// badge, and the notifications prompt in the phone app. Needs the running stack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { attachmentRisk, scanInfo } from '../src/mailsafety.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const D = process.env.TEST_DOMAIN || 'free.test';
const PW = 'Tq9-vLm2-Zx81';
const run = crypto.randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor() { this.cookie = ''; this.ip = `198.44.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`; }
  async req(method, path, body, form) {
    const r = await fetch(BASE + path, { method, headers: { 'X-Requested-With': 'mailcow-client', 'X-Forwarded-For': this.ip, ...(this.cookie ? { Cookie: this.cookie } : {}), ...(body && !form ? { 'Content-Type': 'application/json' } : {}) }, body: form || (body ? JSON.stringify(body) : undefined) });
    for (const c of r.headers.getSetCookie?.() || []) if (c.startsWith('mc_session=')) this.cookie = c.split(';')[0];
    const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
    return { status: r.status, data };
  }
  get(p) { return this.req('GET', p); }
  post(p, b) { return this.req('POST', p, b || {}); }
  put(p, b) { return this.req('PUT', p, b || {}); }
  send(fields, files = []) { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, v); for (const [n, c, t] of files) f.append('attachments', new Blob([c], { type: t }), n); return this.req('POST', '/api/send', null, f); }
}
async function signup(user, name) {
  const c = new Client();
  assert.equal((await c.post('/api/signup', { name, username: user, password: PW, acceptTerms: true, birthday: '1990-01-15', recoveryEmail: 'recovery@example.org', phone: '+15555550123' })).status, 200);
  await c.post('/api/setup/2fa/remind'); await c.post('/api/setup/step', { step: 'done' });
  return c;
}

test('attachment risk and scan info', () => {
  for (const n of ['setup.exe', 'invoice.pdf.exe', 'run.JS', 'update.ps1', 'photo.jpg.scr', 'shortcut.lnk', 'disk.iso']) assert.equal(attachmentRisk(n, 'application/octet-stream'), 'block', n);
  assert.equal(attachmentRisk('report.xlsm', ''), 'macro'); assert.equal(attachmentRisk('login.html', 'text/html'), 'html');
  assert.equal(attachmentRisk('files.zip', 'application/zip'), 'archive');
  for (const n of ['report.pdf', 'photo.jpg', 'notes.docx', 'sheet.xlsx']) assert.equal(attachmentRisk(n, ''), null, n);
  const h = (o) => ({ headers: new Map(Object.entries(o)) });
  assert.deepEqual(scanInfo(h({ 'x-rspamd-queue-id': 'abc', 'x-spamd-result': 'default: False [1.2 / 15.0]; MIME_GOOD(-0.1)' })), { checked: true, virus: false, phish: false });
  assert.equal(scanInfo(h({ 'x-spamd-result': 'default: True [20 / 15]; CLAM_VIRUS(10.0)' })).virus, true);
  assert.equal(scanInfo(h({})).checked, false);
});

test('delivered, read and typing between Roammail users', async () => {
  const a = await signup(`la${run}`, 'Avery Lane'); const b = await signup(`lb${run}`, 'Blake Moss');
  const ea = `la${run}@${D}`; const eb = `lb${run}@${D}`;
  await sleep(1500);
  assert.equal((await a.send({ to: eb, subject: `Coffee? ${run}`, text: 'Coffee at 3?', html: '<p>Coffee at 3?</p>' })).status, 200);
  await sleep(1500);
  const sentMsg = (await a.get('/api/messages?folder=Sent')).data.messages.find((m) => m.subject === `Coffee? ${run}`);
  const mine = (await a.get(`/api/message?folder=Sent&uid=${sentMsg.uid}`)).data;
  let st = (await a.get(`/api/msg-status?ids=${encodeURIComponent(mine.messageId)}`)).data.status[mine.messageId];
  assert.equal(st.length, 1); assert.equal(st[0].address, eb); assert.ok(st[0].delivered); assert.equal(st[0].read, null);
  // outside addresses never get a status
  await a.send({ to: `someone${run}@example.org`, subject: 'Outside', text: 'x', html: '<p>x</p>' });
  // Blake opens it: "Read"
  const inb = (await b.get('/api/messages?folder=INBOX')).data.messages.find((m) => m.subject === `Coffee? ${run}`);
  await b.get(`/api/message?folder=INBOX&uid=${inb.uid}&peek=1`);
  st = (await a.get(`/api/msg-status?ids=${encodeURIComponent(mine.messageId)}`)).data.status[mine.messageId];
  assert.equal(st[0].read, null, 'a preview (peek) is not a read');
  await b.get(`/api/message?folder=INBOX&uid=${inb.uid}`);
  st = (await a.get(`/api/msg-status?ids=${encodeURIComponent(mine.messageId)}`)).data.status[mine.messageId];
  assert.ok(st[0].read, 'read');
  // someone else can't see the status of Avery's email
  assert.deepEqual((await b.get(`/api/msg-status?ids=${encodeURIComponent(mine.messageId)}`)).data.status, {});
  // Blake turns sharing off: his reads are no longer shown, and typing isn't sent
  assert.equal((await b.put('/api/msg-status/settings', { share: false })).data.share, false);
  await a.send({ to: eb, subject: `Second ${run}`, text: 'y', html: '<p>y</p>' });
  await sleep(1500);
  const s2 = (await a.get('/api/messages?folder=Sent')).data.messages.find((m) => m.subject === `Second ${run}`);
  const m2 = (await a.get(`/api/message?folder=Sent&uid=${s2.uid}`)).data;
  const i2 = (await b.get('/api/messages?folder=INBOX')).data.messages.find((m) => m.subject === `Second ${run}`);
  await b.get(`/api/message?folder=INBOX&uid=${i2.uid}`);
  assert.equal((await a.get(`/api/msg-status?ids=${encodeURIComponent(m2.messageId)}`)).data.status[m2.messageId][0].read, null);
  assert.equal((await b.post('/api/live/typing', { to: [ea], ref: mine.messageId })).data.sent, 0);
  await b.put('/api/msg-status/settings', { share: true });

  // attachments: a program is blocked unless confirmed; the reader sees why
  await a.send({ to: eb, subject: `Files ${run}`, text: 'see attached', html: '<p>see attached</p>' }, [['tool.exe', 'MZ fake program', 'application/octet-stream'], ['notes.pdf', '%PDF-1.4', 'application/pdf']]);
  await sleep(1500);
  const fm = (await b.get('/api/messages?folder=INBOX')).data.messages.find((m) => m.subject === `Files ${run}`);
  const ff = (await b.get(`/api/message?folder=INBOX&uid=${fm.uid}`)).data;
  const exe = ff.attachments.find((x) => x.filename === 'tool.exe');
  assert.equal(exe.risk, 'block'); assert.equal(ff.attachments.find((x) => x.filename === 'notes.pdf').risk, null);
  assert.equal((await b.get(`/api/attachment?folder=INBOX&uid=${fm.uid}&index=${exe.index}`)).status, 403);
  assert.equal((await b.get(`/api/attachment?folder=INBOX&uid=${fm.uid}&index=${exe.index}&confirm=1`)).status, 200);

  // in the browser: Blake has the conversation open; Avery replies; Blake sees "typing…", Avery sees "Read"
  const browser = await chromium.launch();
  try {
    const ctxB = await browser.newContext({ viewport: { width: 1300, height: 900 } });
    const [bn, bv] = b.cookie.split('='); await ctxB.addCookies([{ name: bn, value: bv, domain: new URL(BASE).hostname, path: '/' }]);
    const pb = await ctxB.newPage();
    const errors = []; pb.on('pageerror', (e) => errors.push(e.message));
    await pb.goto(`${BASE}/app`);
    await pb.click(`.row >> text=Coffee? ${run}`);
    await pb.waitForSelector('.tmsg');
    await sleep(1500); // live connection up
    const ctxA = await browser.newContext({ viewport: { width: 1300, height: 900 } });
    const [an, av] = a.cookie.split('='); await ctxA.addCookies([{ name: an, value: av, domain: new URL(BASE).hostname, path: '/' }]);
    const pa = await ctxA.newPage();
    await pa.goto(`${BASE}/${(await a.get('/api/me')).data.mailboxId}/sent`);
    await pa.click(`.row >> text=Coffee? ${run}`);
    await pa.waitForSelector('.chat-status >> text=/^Read/');
    await pa.click('.reply-bar >> text=Reply');
    await pa.locator('.composer [contenteditable="true"]').first().click();
    await pa.keyboard.type('Sounds good', { delay: 30 });
    await pb.waitForSelector('.typing-bubble >> text=Avery is typing', { timeout: 10000 });
    await pa.click('.composer [title="Discard draft"]').catch(() => {});
    await pb.waitForSelector('.typing-bubble', { state: 'detached', timeout: 10000 });
    // attachment warning
    await pb.click(`.row >> text=Files ${run}`);
    await pb.waitForSelector('.att.risk-block >> text=Blocked: can run programs');
    await pb.waitForSelector('.att >> text=notes.pdf');
    assert.deepEqual(errors, []);

    // phone app: the notifications prompt
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    // headless Chromium can't grant notifications; act like a phone that hasn't been asked yet
    await phone.addInitScript(() => Object.defineProperty(Notification, 'permission', { get: () => 'default' }));
    await phone.addCookies([{ name: bn, value: bv, domain: new URL(BASE).hostname, path: '/' }]);
    const pp = await phone.newPage();
    await pp.goto(`${BASE}/app`);
    await pp.waitForSelector('.push-ask >> text=Get notified about new mail');
    await pp.click('.push-ask >> text=Not now');
    await pp.waitForSelector('.push-ask', { state: 'detached' });
  } finally { await browser.close(); }
});
