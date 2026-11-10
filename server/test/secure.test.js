// Password-protected emails: the recipient gets only a link (no content, no password), opens it with the password
// sent separately, downloads attachments, replies securely; wrong passwords lock it; the sender sees it was opened
// and can withdraw it. Then the whole thing from the compose window in a browser. Needs the running stack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const D = process.env.TEST_DOMAIN || 'free.test';
const PW = 'Tq9-vLm2-Zx81';
const run = crypto.randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor() { this.cookie = ''; this.ip = `198.38.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`; }
  async req(method, path, body, form) {
    const r = await fetch(BASE + path, { method, headers: { 'X-Requested-With': 'mailcow-client', 'X-Forwarded-For': this.ip, ...(this.cookie ? { Cookie: this.cookie } : {}), ...(body && !form ? { 'Content-Type': 'application/json' } : {}) }, body: form || (body ? JSON.stringify(body) : undefined) });
    for (const c of r.headers.getSetCookie?.() || []) if (c.startsWith('mc_session=')) this.cookie = c.split(';')[0];
    const buf = Buffer.from(await r.arrayBuffer()); let data; try { data = JSON.parse(buf.toString()); } catch { data = buf; }
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
const inbox = async (c) => (await c.get('/api/messages', { folder: 'INBOX' })).data.messages;
const body = async (c, m) => (await c.get('/api/message', { folder: 'INBOX', uid: m.uid })).data;

test('password-protected email: link only, opens with the separate password, locks, withdraws', async () => {
  const alice = await signup(`sa${run}`); const bob = await signup(`sb${run}`);
  const a = `sa${run}@${D}`; const b = `sb${run}@${D}`;
  await sleep(1500);
  const SECRET = 'Blue-Otter-4242';

  const fd = new FormData();
  fd.append('to', b); fd.append('subject', 'Q3 payroll'); fd.append('text', 'Salaries attached. Account 12345678.'); fd.append('html', '<p>Salaries attached. Account <b>12345678</b>.</p>');
  fd.append('attachments', new Blob(['name,salary\nAnn,100\n'], { type: 'text/csv' }), 'payroll.csv');
  fd.append('protect', 'true'); fd.append('securePassword', SECRET); fd.append('secureHint', 'Our dog + office number'); fd.append('secureDays', '7');
  assert.equal((await alice.req('POST', '/api/send', null, (() => { const f = new FormData(); f.append('to', b); f.append('subject', 'x'); f.append('text', 'x'); f.append('protect', 'true'); f.append('securePassword', 'short'); return f; })())).status, 400, 'password too short');
  const sent = await alice.req('POST', '/api/send', null, fd);
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const { id, url } = sent.data.secure;
  assert.match(url, new RegExp(`/secure/${id}$`));
  await sleep(1500);

  // 1. Bob's email: a link and the hint; not the content, not the password, no attachment
  const notice = (await inbox(bob)).find((m) => /sent you a protected email/.test(m.subject));
  assert.ok(notice, 'notice arrived');
  const nb = await body(bob, notice);
  assert.ok(nb.text.includes(url)); assert.ok(nb.text.includes('Our dog + office number'));
  for (const leak of ['Q3 payroll', '12345678', SECRET, 'payroll.csv']) assert.ok(!JSON.stringify(nb).includes(leak), `notice must not contain ${leak}`);
  assert.equal(nb.attachments.length, 0);
  // Alice's Sent copy keeps the real email, marked as protected
  const sentBox = (await alice.get('/api/messages', { folder: 'Sent' })).data.messages;
  const mine = (await alice.get('/api/message', { folder: 'Sent', uid: sentBox.find((m) => m.subject === 'Q3 payroll').uid })).data;
  assert.equal(mine.secureId, id);

  // 2. opening it: wrong password, then the right one; attachment; secure reply
  const pub = new Client();
  assert.equal((await pub.get(`/api/public/secure/${id}`)).data.state, 'ok');
  assert.equal((await pub.post(`/api/public/secure/${id}/open`, { password: 'wrong-guess' })).status, 401);
  const open = await pub.post(`/api/public/secure/${id}/open`, { password: SECRET });
  assert.equal(open.status, 200, JSON.stringify(open.data));
  assert.equal(open.data.subject, 'Q3 payroll'); assert.match(open.data.html, /12345678/); assert.equal(open.data.from.address, a);
  assert.equal(open.data.attachments[0].filename, 'payroll.csv');
  const file = await pub.post(`/api/public/secure/${id}/attachment`, { token: open.data.token, index: 0 });
  assert.equal(file.data.toString(), 'name,salary\nAnn,100\n');
  assert.equal((await pub.post(`/api/public/secure/${id}/attachment`, { token: 'forged', index: 0 })).status, 401);
  assert.equal((await pub.post(`/api/public/secure/${id}/reply`, { token: open.data.token, text: 'Got it, thanks.' })).status, 200);

  // 3. the password, separately: must be the right one; no link in it
  assert.equal((await alice.post(`/api/secure/${id}/send-password`, { password: 'Not-The-Password-1' })).status, 400);
  assert.equal((await alice.post(`/api/secure/${id}/send-password`, { password: SECRET, delayMinutes: 0 })).status, 200);
  await sleep(2000);
  const pwMail = (await inbox(bob)).find((m) => m.subject === 'The password for my protected email');
  const pb = await body(bob, pwMail);
  assert.ok(pb.text.includes(SECRET)); assert.ok(!pb.text.includes(id), 'no link next to the password');
  // Alice: opened, secure reply arrived, others can't see it
  const st = (await alice.get(`/api/secure/${id}`)).data;
  assert.ok(st.openedAt); assert.equal(st.revoked, false);
  assert.ok((await inbox(alice)).some((m) => m.subject === 'Secure reply: Q3 payroll'));
  assert.ok((await inbox(alice)).some((m) => m.subject === 'Your protected email was opened'));
  assert.equal((await bob.get(`/api/secure/${id}`)).status, 404);

  // 4. withdraw: the link stops working
  assert.equal((await alice.post(`/api/secure/${id}/revoke`)).status, 200);
  assert.equal((await pub.get(`/api/public/secure/${id}`)).data.state, 'revoked');
  assert.equal((await pub.post(`/api/public/secure/${id}/open`, { password: SECRET })).status, 410);

  // 5. guessing: 5 wrong passwords lock it for a while
  const f2 = new FormData(); f2.append('to', b); f2.append('subject', 'Locked one'); f2.append('text', 'secret'); f2.append('protect', 'true'); f2.append('securePassword', SECRET);
  const id2 = (await alice.req('POST', '/api/send', null, f2)).data.secure.id;
  const guesser = new Client();
  for (let i = 0; i < 5; i++) assert.equal((await guesser.post(`/api/public/secure/${id2}/open`, { password: `guess-${i}-xx` })).status, 401);
  assert.equal((await guesser.post(`/api/public/secure/${id2}/open`, { password: SECRET })).status, 429, 'locked for 15 minutes');
  assert.equal((await guesser.get(`/api/public/secure/${id2}`)).data.state, 'wait');

  // 6. in a browser: compose a protected email with a generated password and receipts, then open it as the recipient
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
    const [n, v] = alice.cookie.split('='); await ctx.addCookies([{ name: n, value: v, domain: new URL(BASE).hostname, path: '/' }]);
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${BASE}/app`);
    await page.click('text=New mail');
    await page.keyboard.type(b); await page.keyboard.press('Enter');
    await page.locator('input[aria-label="Subject"]').first().fill('Contract draft');
    await page.locator('[contenteditable="true"]').first().click(); await page.keyboard.type('Here is the draft.');
    await page.click('[aria-label="Protect with a password"]');
    const generated = await page.locator('input[aria-label="Password"]').inputValue();
    assert.ok(generated.length >= 14, 'a strong password was generated');
    await page.locator('.protect-panel select').last().selectOption('manual');
    await page.click('[aria-label="More options"]'); await page.click('.more-menu >> text=Read receipt');
    const sendReq = page.waitForRequest((r) => r.url().endsWith('/api/send'));
    await page.click('.composer >> button:has-text("Send")');
    const posted = (await sendReq).postData() || '';
    assert.ok(posted.includes('name="readReceipt"') && posted.includes('name="protect"'), 'compose sends the new options');
    await page.waitForSelector('text=Protected email sent', { timeout: 20000 });
    assert.equal((await page.locator('.pw-box code').textContent()).trim(), generated);
    await page.click('.pw-share >> button:has-text("Done")');

    await sleep(1500);
    const link = (await body(bob, (await inbox(bob)).find((m) => /sent you a protected email/.test(m.subject) && m.uid !== notice.uid && !/Locked/.test(m.subject)))).text.match(/https?:\/\/\S+\/secure\/[\w-]+/)[0];
    const guest = await (await browser.newContext()).newPage();
    await guest.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
    await guest.fill('input[aria-label="Password"]', generated);
    await guest.click('text=Open');
    await guest.waitForSelector('h1:has-text("Contract draft")');
    assert.match(await guest.frameLocator('iframe').locator('body').textContent(), /Here is the draft/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
