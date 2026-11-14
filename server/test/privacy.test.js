// Privacy features: Subscriptions (find newsletters, one-click and email unsubscribe, clear out, keep), hide-my-email
// aliases, look-alike sender warnings, and tracker blocking in a real browser. Needs the running stack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const D = process.env.TEST_DOMAIN || 'free.test';
const IDP = 'http://127.0.0.1:8095';
const PW = 'Tq9-vLm2-Zx81';
const run = crypto.randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor() { this.cookie = ''; this.ip = `198.36.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`; }
  async req(method, path, body) {
    const r = await fetch(BASE + path, { method, headers: { 'X-Requested-With': 'mailcow-client', 'X-Forwarded-For': this.ip, ...(this.cookie ? { Cookie: this.cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
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
const smtp = (user) => nodemailer.createTransport({ host: '127.0.0.1', port: 3025, secure: false, auth: { user: `${user}@${D}`, pass: PW }, tls: { rejectUnauthorized: false } });

test('subscriptions, aliases, look-alike senders and tracker blocking', async () => {
  const me = await signup(`pv${run}`);
  await signup(`nl${run}`); await signup(`ls${run}`); const listOwner = await signup(`lo${run}`);
  const email = `pv${run}@${D}`;
  await sleep(1500);

  // newsletters: one with one-click unsubscribe (3 emails), one that only takes an unsubscribe email (2), one personal email
  const news = smtp(`nl${run}`); const list = smtp(`ls${run}`);
  for (let i = 1; i <= 3; i++) {
    await news.sendMail({ from: { name: 'Daily Deals', address: `nl${run}@${D}` }, to: email, subject: `Deal #${i}`, text: 'Big savings',
      headers: { 'List-Unsubscribe': `<${IDP}/unsub/deals-${run}>, <mailto:lo${run}@${D}?subject=unsub-deals>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click', 'List-Id': '<deals.example>' } });
  }
  for (let i = 1; i <= 2; i++) {
    await list.sendMail({ from: { name: 'Club Updates', address: `ls${run}@${D}` }, to: email, subject: `Club news ${i}`, text: 'Hello members',
      headers: { 'List-Unsubscribe': `<mailto:lo${run}@${D}?subject=unsubscribe-club>` } });
  }
  // a phishing-style email: a company's name with someone else's address, carrying a tracking pixel and tracked link
  await list.sendMail({ from: { name: 'PayPal Support', address: `ls${run}@${D}` }, to: email, subject: 'Your account is limited',
    html: '<p>Please <a id="lnk" href="https://shop.example/offer?id=7&utm_source=mail&utm_campaign=x&fbclid=abc">review</a>.</p><img src="https://track.sendgrid.net/wf/open?upn=xyz" width="1" height="1">' });
  await sleep(2500);

  // 1. Subscriptions: grouped by sender, counted; the personal-looking email isn't a subscription
  let subs = (await me.get('/api/subscriptions', { refresh: '1' })).data.senders;
  const deals = subs.find((s) => s.address === `nl${run}@${D}`);
  const club = subs.find((s) => s.address === `ls${run}@${D}`);
  assert.equal(deals.count, 3); assert.equal(deals.unread, 3); assert.equal(deals.oneClick, true); assert.equal(deals.name, 'Daily Deals');
  assert.equal(club.count, 2); assert.equal(club.oneClick, false); assert.equal(club.canUnsubscribe, true);

  // one-click: our server POSTs to the sender's unsubscribe address
  let r = await me.post('/api/subscriptions/unsubscribe', { address: deals.address });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.method, 'one-click');
  const hits = await (await fetch(`${IDP}/test/unsubs`)).json();
  assert.ok(hits.some((h) => h.path === `/unsub/deals-${run}` && h.body === 'List-Unsubscribe=One-Click'));
  // by email: an "unsubscribe" email goes to the list's address, from my mailbox
  r = await me.post('/api/subscriptions/unsubscribe', { address: club.address });
  assert.equal(r.data.method, 'email');
  await sleep(2000);
  const got = (await listOwner.get('/api/messages', { folder: 'INBOX' })).data.messages;
  assert.ok(got.some((m) => m.subject === 'unsubscribe-club' && m.from?.[0]?.address === email), 'unsubscribe email sent');
  subs = (await me.get('/api/subscriptions')).data.senders;
  assert.equal(subs.find((s) => s.address === deals.address).status, 'unsubscribed');
  // keep, then clear out a sender's emails to Archive
  await me.post('/api/subscriptions/keep', { address: club.address });
  assert.equal((await me.get('/api/subscriptions')).data.senders.find((s) => s.address === club.address).status, 'kept');
  r = await me.post('/api/subscriptions/cleanup', { address: deals.address, action: 'archive' });
  assert.equal(r.data.moved, 3);
  assert.ok(!(await me.get('/api/subscriptions')).data.senders.some((s) => s.address === deals.address), 'gone from the inbox');
  assert.equal((await me.post('/api/subscriptions/unsubscribe', { address: 'not-an-address' })).status, 400);

  // 2. Aliases: create, note, switch off and on, limit, delete; on the mail server too
  let a = (await me.get('/api/aliases')).data;
  assert.equal(a.aliases.length, 0); assert.equal(a.limit, 10); assert.equal(a.domain, D);
  const al = (await me.post('/api/aliases', { note: 'Shoe shop' })).data;
  assert.match(al.address, new RegExp(`^[a-z]+\\.[a-z]+\\.[0-9a-f]{4}@${D.replace('.', '\\.')}$`));
  const onServer = async () => (await (await fetch('http://127.0.0.1:8099/api/v1/get/alias/all', { headers: { 'X-API-Key': 'dev-key' } })).json()).find((x) => x.address === al.address);
  assert.equal((await onServer()).goto, email); assert.equal(Number((await onServer()).active), 1);
  assert.equal((await me.req('PATCH', `/api/aliases/${al.id}`, { active: false })).data.active, false);
  assert.equal(Number((await onServer()).active), 0, 'switched off on the mail server');
  await me.req('PATCH', `/api/aliases/${al.id}`, { active: true, note: 'Shoe shop (spam?)' });
  const other = await signup(`px${run}`);
  assert.equal((await other.req('PATCH', `/api/aliases/${al.id}`, { active: false })).status, 404, 'not someone else’s');
  for (let i = 0; i < 9; i++) assert.equal((await me.post('/api/aliases', {})).status, 200);
  assert.equal((await me.post('/api/aliases', {})).status, 402, 'free limit');
  assert.equal((await me.req('DELETE', `/api/aliases/${al.id}`)).status, 200);
  assert.equal(await onServer(), undefined, 'removed from the mail server');

  // 3. look-alike sender: a company's name with a different address
  const phish = (await me.get('/api/search', { q: 'subject:limited' })).data.messages[0];
  const full = (await me.get('/api/message', { folder: 'INBOX', uid: phish.uid })).data;
  assert.equal(full.security.lookalike.brand, 'paypal'); assert.equal(full.security.lookalike.reason, 'brand-name');

  // 4. trackers: the pixel and link codes are removed, even with pictures shown, and reported
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
    const [n, v] = me.cookie.split('='); await ctx.addCookies([{ name: n, value: v, domain: new URL(BASE).hostname, path: '/' }]);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/app`);
    await page.click('.row >> text=Your account is limited');
    await page.waitForSelector('text=/2 trackers blocked/', { timeout: 15000 });
    await page.waitForSelector('text=/may be pretending|calls themselves "PayPal Support"/');
    const href = await page.frameLocator('iframe.msg-frame').locator('#lnk').getAttribute('href');
    assert.equal(href, 'https://shop.example/offer?id=7');
    // Subscriptions and Aliases are in the sidebar
    await page.click('.app-rail >> button[aria-label="Subscriptions"]');
    await page.waitForSelector('.sub-row >> text=Club Updates');
    await page.click('.chip >> text=Kept');
    assert.equal(await page.locator('.sub-row').count(), 1);
    await page.click('.folder >> text=Aliases');
    await page.waitForSelector('text=/9 of 10 aliases used/');
  } finally { await browser.close(); }
});
