// Rules (templates, auto-reply to one contact, domain match, run on the inbox now, right-click "Make a rule"),
// contact groups, and Catch up (clean-ups, one-at-a-time, auto-tidy). Needs the running stack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const D = process.env.TEST_DOMAIN || 'free.test';
const PW = 'Tq9-vLm2-Zx81';
const run = crypto.randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor() { this.cookie = ''; this.ip = `198.45.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`; }
  async req(method, path, body) {
    const r = await fetch(BASE + path, { method, headers: { 'X-Requested-With': 'mailcow-client', 'X-Forwarded-For': this.ip, ...(this.cookie ? { Cookie: this.cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    for (const c of r.headers.getSetCookie?.() || []) if (c.startsWith('mc_session=')) this.cookie = c.split(';')[0];
    const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
    return { status: r.status, data };
  }
  get(p) { return this.req('GET', p); }
  post(p, b) { return this.req('POST', p, b || {}); }
  put(p, b) { return this.req('PUT', p, b || {}); }
  del(p) { return this.req('DELETE', p); }
}
async function signup(user, name) {
  const c = new Client();
  assert.equal((await c.post('/api/signup', { name, username: user, password: PW, acceptTerms: true, birthday: '1990-01-15', recoveryEmail: 'recovery@example.org', phone: '+15555550123' })).status, 200);
  await c.post('/api/setup/2fa/remind'); await c.post('/api/setup/step', { step: 'done' });
  return c;
}
const filterOf = async (email) => (await (await fetch('http://127.0.0.1:8099/api/v1/get/filters/all', { headers: { 'X-API-Key': 'dev-key' } })).json())
  .find((x) => /rules and automatic replies/.test(x.script_desc) && String(x.script_data).includes(`"${email}"`));

test('rules, contact groups and catch up', async () => {
  const me = await signup(`ra${run}`, 'Riley Ames'); const pal = await signup(`rb${run}`, 'Jo Park');
  const email = `ra${run}@${D}`; const palEmail = `rb${run}@${D}`;
  await sleep(1500);
  const smtp = nodemailer.createTransport({ host: '127.0.0.1', port: 3025, secure: false, auth: { user: palEmail, pass: PW }, tls: { rejectUnauthorized: false } });
  const env = { from: palEmail, to: email };
  for (let i = 1; i <= 3; i++) await smtp.sendMail({ envelope: env, from: `Shop <deals@shop${run}.example>`, to: email, subject: `Deal ${i} ${run}`, text: 'Sale', headers: { 'List-Unsubscribe': '<https://shop.example/u>' } });
  for (let i = 1; i <= 2; i++) await smtp.sendMail({ envelope: env, from: `Jo Park <${palEmail}>`, to: email, subject: `Question ${i} ${run}`, text: 'Hi there?' });
  await smtp.sendMail({ envelope: env, from: `Bank <noreply@bank${run}.example>`, to: email, subject: `Statement ${run}`, text: 'Your statement' });
  await sleep(1500);

  // ---- 1. rules: auto-reply to one contact + a domain rule, then run it on the inbox
  const folders = (await me.get('/api/folders')).data;
  await me.post('/api/folders', { path: `Shopping${run}` });
  const rules = [
    { id: 'r1', name: 'Auto-reply to Jo', conditions: [{ field: 'fromIs', value: palEmail }], actions: [{ type: 'reply', subject: 'Got it', value: 'Thanks Jo, will reply soon.', days: 3 }], stop: false },
    { id: 'r2', name: 'Shop', conditions: [{ field: 'domain', value: `shop${run}.example` }], actions: [{ type: 'move', folder: `Shopping${run}` }, { type: 'read' }] },
  ];
  const saved = (await me.put('/api/rules', { rules })).data;
  assert.equal(saved[0].actions[0].type, 'reply'); assert.equal(saved[0].actions[0].days, 3); assert.equal(saved[1].conditions[0].field, 'domain');
  const f = await filterOf(email);
  assert.match(f.script_data, new RegExp(`address :is "from" "${palEmail.replace('.', '\\.')}"`));
  assert.match(f.script_data, /vacation :days 3 :handle "rule-r1" :subject "Got it"/);
  assert.match(f.script_data, new RegExp(`address :domain :is "from" "shop${run}\\.example"`));
  assert.ok(folders.length);
  let r = await me.post('/api/rules/run', { id: 'r2' });
  assert.equal(r.data.matched, 3);
  const shop = (await me.get(`/api/messages?folder=Shopping${run}`)).data.messages;
  assert.equal(shop.length, 3); assert.ok(shop.every((m) => m.seen), 'moved and marked read');
  assert.equal((await me.post('/api/rules/run', { id: 'nope' })).status, 404);

  // ---- 2. contact groups, offered in To
  const g = (await me.post('/api/contact-groups', { name: 'Book club', members: [{ address: palEmail, name: 'Jo Park' }, 'sam@example.org', 'not-an-email', 'SAM@example.org'] })).data;
  assert.equal(g.members.length, 2);
  assert.equal((await me.post('/api/contact-groups', { name: 'book club', members: ['x@example.org'] })).status, 409);
  const sugg = (await me.get('/api/contacts?q=book')).data;
  assert.equal(sugg[0].group, true); assert.equal(sugg[0].name, 'Book club'); assert.equal(sugg[0].members.length, 2);
  assert.equal((await pal.get('/api/contact-groups')).data.length, 0, 'private to each mailbox');

  // ---- 3. catch up
  for (let i = 1; i <= 16; i++) await smtp.sendMail({ envelope: env, from: `News <news@paper${run}.example>`, to: email, subject: `Edition ${i} ${run}`, text: 'News', headers: { 'List-Id': '<paper.example>' } });
  await sleep(2000);
  let c = (await me.get('/api/catchup')).data;
  assert.equal(c.newsletters, 16); assert.equal(c.primary, 2); assert.ok(c.updates >= 1);
  assert.ok(c.senders.some((s) => s.address === `news@paper${run}.example` && s.count === 16));
  r = await me.post('/api/catchup/apply', { what: 'updates', action: 'archive' });
  assert.ok(r.data.done >= 1);
  c = (await me.get('/api/catchup')).data;
  assert.equal(c.updates, 0);
  const st = (await me.put('/api/catchup/settings', { newsletters: 3, updates: 7, old: 99 })).data;
  assert.deepEqual(st, { newsletters: 3, updates: 7, old: 0 });
  assert.equal((await me.post('/api/catchup/autotidy', { force: true })).data.ok, true);

  // ---- 4. in the browser
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1350, height: 900 } });
    const [cn, cv] = me.cookie.split('='); await ctx.addCookies([{ name: cn, value: cv, domain: new URL(BASE).hostname, path: '/' }]);
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${BASE}/app`);
    // right-click → Make a rule → rule editor with that sender
    await page.click(`.row >> text=Question 1 ${run}`, { button: 'right' });
    await page.click('.ctx-menu >> text=Make a rule…');
    await page.waitForSelector('.rule-edit');
    assert.equal(await page.locator('.rule-edit .rule-row input').first().inputValue(), palEmail);
    await page.click('.rule-edit >> text=Cancel');
    await page.waitForSelector('.rule-tpl >> text=Auto-reply to one contact');
    await page.click('text=How rules work');
    await page.waitForSelector('text=checks your rules from top to bottom');
    await page.keyboard.press('Escape');
    // groups in compose
    await page.goto(`${BASE}/app`);
    await page.click('text=New mail');
    await page.keyboard.type('Book');
    await page.waitForSelector('.sugg >> text=Book club');
    await page.keyboard.press('Enter');
    await page.waitForSelector(`.rchip[title="${palEmail}"]`);
    await page.waitForSelector('.rchip[title="sam@example.org"]');
    await page.click('.composer [title="Discard draft"]').catch(() => {});
    // catch up
    await page.goto(`${BASE}/app`);
    await page.click('.inbox-tabs >> text=Primary');
    await page.click('.catchup-banner');
    await page.waitForSelector('.catchup-hero');
    await page.click('.catchup-row:has-text("Newsletters") >> text=Mark read');
    await page.waitForSelector('text=/Marked as read \\(16\\)/');
    await page.click('.catchup-go');
    await page.waitForSelector('.catchup-card');
    const total = (await page.locator('.catchup .list-head .muted').innerText()).split('/')[1].trim();
    await page.keyboard.press('k');
    if (total !== '1') { await page.waitForSelector(`text=2 / ${total}`); await page.keyboard.press('a'); }
    await page.waitForSelector('text=All done!');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
  const after = (await me.get('/api/catchup')).data;
  assert.equal(after.primary, 0); assert.equal(after.newsletters, 0);
});
