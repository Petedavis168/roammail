// Smart inbox tabs, the Screener, voice messages and tasks beside the calendar. Needs the running stack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const D = process.env.TEST_DOMAIN || 'free.test';
const PW = 'Tq9-vLm2-Zx81';
const run = crypto.randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor() { this.cookie = ''; this.ip = `198.41.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`; }
  async req(method, path, body, form, headers = {}) {
    const r = await fetch(BASE + path, { method, headers: { 'X-Requested-With': 'mailcow-client', 'X-Forwarded-For': this.ip, ...(this.cookie ? { Cookie: this.cookie } : {}), ...(body && !form ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: form || (body ? JSON.stringify(body) : undefined) });
    for (const c of r.headers.getSetCookie?.() || []) if (c.startsWith('mc_session=')) this.cookie = c.split(';')[0];
    const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
    return { status: r.status, data, headers: r.headers };
  }
  get(p) { return this.req('GET', p); }
  post(p, b) { return this.req('POST', p, b || {}); }
  put(p, b) { return this.req('PUT', p, b || {}); }
  send(fields) { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, v); return this.req('POST', '/api/send', null, f); }
}
async function signup(user) {
  const c = new Client();
  assert.equal((await c.post('/api/signup', { name: `Test ${user}`, username: user, password: PW, acceptTerms: true, birthday: '1990-01-15', recoveryEmail: 'recovery@example.org', phone: '+15555550123' })).status, 200);
  await c.post('/api/setup/2fa/remind'); await c.post('/api/setup/step', { step: 'done' });
  return c;
}
const filterOf = async (email) => (await (await fetch('http://127.0.0.1:8099/api/v1/get/filters/all', { headers: { 'X-API-Key': 'dev-key' } })).json())
  .find((x) => /rules and automatic replies/.test(x.script_desc) && String(x.script_data).includes(`"${email}"`));

test('smart inbox tabs, screener, voice messages, tasks beside the calendar', async () => {
  const me = await signup(`ta${run}`); const pal = await signup(`tb${run}`);
  const email = `ta${run}@${D}`; const palEmail = `tb${run}@${D}`;
  await sleep(1500);
  const smtp = nodemailer.createTransport({ host: '127.0.0.1', port: 3025, secure: false, auth: { user: palEmail, pass: PW }, tls: { rejectUnauthorized: false } });
  const env = { from: palEmail, to: email };
  await smtp.sendMail({ envelope: env, from: `Shop News <news@shop${run}.example>`, to: email, subject: `Weekly deals ${run}`, text: 'Deals', headers: { 'List-Unsubscribe': '<https://shop.example/u>' } });
  await smtp.sendMail({ envelope: env, from: `Shop <noreply@shop${run}.example>`, to: email, subject: `Your order shipped ${run}`, text: 'Shipped' });
  await smtp.sendMail({ envelope: env, from: `Pal <${palEmail}>`, to: email, subject: `Dinner Friday? ${run}`, text: 'Are you free?' });
  await sleep(1500);

  // ---- 1. tabs
  const tab = async (k) => (await me.get(`/api/messages?folder=INBOX&tab=${k}`)).data;
  const p = await tab('primary'); const u = await tab('updates'); const n = await tab('newsletters');
  assert.ok(p.messages.some((m) => m.subject === `Dinner Friday? ${run}`)); assert.ok(!p.messages.some((m) => /Weekly deals|order shipped/.test(m.subject)));
  assert.deepEqual(u.messages.map((m) => m.subject).filter((x) => x.includes(run)), [`Your order shipped ${run}`]);
  assert.deepEqual(n.messages.map((m) => m.subject), [`Weekly deals ${run}`]);
  assert.equal(p.tabs.newsletters, 1); assert.equal(p.tabs.updates >= 1, true);
  assert.equal((await me.get('/api/messages?folder=INBOX&tab=updates&filter=unread')).data.messages.length >= 1, true);

  // ---- 2. screener
  let s = (await me.get('/api/screener')).data;
  assert.equal(s.enabled, false);
  assert.equal((await me.send({ to: `old.friend${run}@example.org`, subject: 'hi', text: 'hi', html: '<p>hi</p>' })).status, 200);
  await sleep(800);
  const on = (await me.put('/api/screener', { enabled: true })).data;
  assert.equal(on.enabled, true); assert.ok(on.learned >= 2, 'learned from Sent and Inbox');
  let f = await filterOf(email);
  assert.match(f.script_data, /fileinto :create "Screener"/);
  assert.ok(f.script_data.includes(`"old.friend${run}@example.org"`) && f.script_data.includes(`"${palEmail}"`), 'known people get through');
  // a stranger's email lands in Screener (the mail server does this; here we put it there directly)
  const imap = new ImapFlow({ host: '127.0.0.1', port: 3143, secure: false, auth: { user: email, pass: PW }, logger: false });
  await imap.connect();
  const raw = (from, subj) => `From: ${from}\r\nTo: ${email}\r\nSubject: ${subj}\r\nMessage-ID: <${crypto.randomUUID()}@x>\r\nDate: ${new Date().toUTCString()}\r\n\r\nHello\r\n`;
  await imap.append('Screener', raw(`Stranger <stranger${run}@example.net>`, 'Quick question'));
  await imap.append('Screener', raw(`Stranger <stranger${run}@example.net>`, 'Following up'));
  await imap.append('Screener', raw(`Spammy <spam${run}@example.net>`, 'You won'));
  await imap.logout();
  s = (await me.get('/api/screener')).data;
  assert.deepEqual(s.waiting.map((w) => [w.address, w.count]).sort(), [[`spam${run}@example.net`, 1], [`stranger${run}@example.net`, 2]]);
  let r = await me.post('/api/screener/decide', { address: `stranger${run}@example.net`, decision: 'allow' });
  assert.equal(r.data.moved, 2);
  assert.ok((await me.get('/api/messages?folder=INBOX')).data.messages.some((m) => m.subject === 'Following up'), 'moved to the inbox');
  r = await me.post('/api/screener/decide', { address: `spam${run}@example.net`, decision: 'block' });
  assert.equal(r.data.moved, 1);
  f = await filterOf(email);
  assert.ok(f.script_data.includes(`"stranger${run}@example.net"`)); assert.match(f.script_data, new RegExp(`blocked senders\\nif address :is "from" \\["spam${run}@example\\.net"\\]`));
  assert.equal((await me.get('/api/screener')).data.waiting.length, 0);
  // writing to someone new lets them through
  await me.send({ to: `new.client${run}@example.org`, subject: 'Proposal', text: 'x', html: '<p>x</p>' });
  await sleep(4000);
  assert.ok((await filterOf(email)).script_data.includes(`"new.client${run}@example.org"`));
  assert.equal((await me.post('/api/screener/decide', { address: 'nope' })).status, 400);

  // ---- 3. voice messages
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), crypto.randomBytes(4000)]);
  let fd = new FormData(); fd.append('durationMs', '4200'); fd.append('audio', new Blob([webm], { type: 'audio/webm' }), 'v.webm');
  const v = (await me.req('POST', '/api/voice', null, fd)).data;
  assert.match(v.url, /\/voice\/[\w-]{22}$/); assert.equal(v.durationMs, 4200);
  const page = await (await fetch(`${BASE}/voice/${v.id}`)).text();
  assert.match(page, new RegExp(`Voice message from Test ta${run}`)); assert.match(page, /0:04/);
  const part = await fetch(`${BASE}/voice/${v.id}/audio`, { headers: { Range: 'bytes=0-3' } });
  assert.equal(part.status, 206); assert.deepEqual([...Buffer.from(await part.arrayBuffer())], [0x1a, 0x45, 0xdf, 0xa3]);
  assert.equal((await fetch(`${BASE}/voice/${v.id}/audio`)).headers.get('content-type'), 'audio/webm');
  assert.equal((await fetch(`${BASE}/voice/AAAAAAAAAAAAAAAAAAAAAA`)).status, 404);
  fd = new FormData(); fd.append('audio', new Blob(['<script>alert(1)</script>'], { type: 'audio/webm' }), 'x.webm');
  assert.equal((await me.req('POST', '/api/voice', null, fd)).status, 400, 'not really audio');
  assert.equal((await new Client().req('POST', '/api/voice', null, (() => { const x = new FormData(); x.append('audio', new Blob([webm], { type: 'audio/webm' }), 'v.webm'); return x; })())).status, 401);

  // ---- 4. in the browser
  const due = new Date(); due.setHours(17, 0, 0, 0);
  await me.post('/api/tasks', { title: `Call the bank ${run}`, dueAt: due.getTime() });
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const [cn, cv] = me.cookie.split('='); await ctx.addCookies([{ name: cn, value: cv, domain: new URL(BASE).hostname, path: '/' }]);
    const pg = await ctx.newPage();
    const errors = []; pg.on('pageerror', (e) => errors.push(e.message));
    await pg.goto(`${BASE}/app`);
    await pg.waitForSelector(`.row >> text=Dinner Friday? ${run}`);
    assert.equal(await pg.locator(`.row >> text=Weekly deals ${run}`).count(), 0, 'newsletter not in Primary');
    await pg.click('.inbox-tabs >> text=Newsletters');
    await pg.waitForSelector(`.row >> text=Weekly deals ${run}`);
    // calendar: today's task is on the calendar and in the list; tick it off
    await pg.click('.app-rail >> button[aria-label="Calendar"]');
    await pg.waitForSelector(`.cal-tasks >> text=Call the bank ${run}`);
    assert.ok(await pg.locator(`.task-chip >> text=Call the bank ${run}`).count() >= 1, 'on the calendar');
    await pg.locator('.cal-task', { hasText: `Call the bank ${run}` }).locator('.task-check').click();
    await pg.waitForSelector(`.cal-tasks >> text=Call the bank ${run}`, { state: 'detached' });
    assert.equal((await me.get('/api/tasks')).data.open.length, 0);
    // screener page
    await pg.click('.app-rail >> button[aria-label="Screener"]');
    await pg.waitForSelector('text=No one is waiting');
    // compose has the voice button and recorder
    await pg.click('.app-rail >> button[aria-label="Mail"]');
    await pg.click('text=New mail');
    await pg.click('.composer [aria-label="Voice message"]');
    await pg.waitForSelector('.voice-rec >> text=up to 5 minutes');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
