// Out of office (schedule, inside/outside replies, cover person, bar in the app), smart templates (ready-made gallery,
// fill-in fields in the compose window) and follow-up nudges ("No reply in 3 days. Bump it?"). Needs the running
// stack, started with NUDGE_DAY_MS (dev/test.env) so "3 days" is 3 seconds.
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
  constructor() { this.cookie = ''; this.ip = `198.39.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`; }
  async req(method, path, body, form) {
    const r = await fetch(BASE + path, { method, headers: { 'X-Requested-With': 'mailcow-client', 'X-Forwarded-For': this.ip, ...(this.cookie ? { Cookie: this.cookie } : {}), ...(body && !form ? { 'Content-Type': 'application/json' } : {}) }, body: form || (body ? JSON.stringify(body) : undefined) });
    for (const c of r.headers.getSetCookie?.() || []) if (c.startsWith('mc_session=')) this.cookie = c.split(';')[0];
    const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
    return { status: r.status, data };
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
const filters = async (email) => (await (await fetch(`http://127.0.0.1:8099/api/v1/get/filters/${encodeURIComponent(email)}`, { headers: { 'X-API-Key': 'dev-key' } })).json());

test('out of office, smart templates and follow-up nudges', async () => {
  const alice = await signup(`na${run}`); const bob = await signup(`nb${run}`);
  const a = `na${run}@${D}`; const b = `nb${run}@${D}`;
  await sleep(1500);

  // ---- 1. out of office
  let v = (await alice.get('/api/vacation')).data;
  assert.equal(v.enabled, false); assert.equal(v.activeNow, false); assert.equal(v.showColleagues, true);
  assert.equal((await alice.put('/api/vacation', { enabled: true, message: '' })).status, 400, 'needs a message');
  assert.equal((await alice.put('/api/vacation', { enabled: true, message: 'Away', start: '2030-05-10', end: '2030-05-01' })).status, 400, 'end before start');
  assert.equal((await alice.put('/api/vacation', { enabled: true, message: 'Away', cover: 'not an email' })).status, 400);
  assert.equal((await alice.put('/api/vacation', { enabled: true, message: 'Away', cover: `x${run}@example.org`, forwardToCover: true })).status, 403, 'free accounts cannot auto-forward');
  // scheduled for the future: saved, on, but not active yet
  v = (await alice.put('/api/vacation', { enabled: true, subject: 'Away', message: 'Back soon', start: '2099-01-01', end: '2099-01-10' })).data;
  assert.equal(v.enabled, true); assert.equal(v.activeNow, false);
  // now, open-ended
  v = (await alice.put('/api/vacation', { enabled: true, subject: 'On vacation', message: 'I am away until Monday.', cover: `x${run}@example.org`, coverName: 'Xavier' })).data;
  assert.equal(v.activeNow, true); assert.equal(v.coverName, 'Xavier'); assert.equal(v.forwardToCover, false);
  const f = (await filters(a)).find((x) => /rules and automatic replies/.test(x.script_desc) && String(x.script_data).includes(a));
  assert.ok(f && /vacation :days 1/.test(f.script_data) && /I am away until Monday/.test(f.script_data), 'automatic reply on the mail server');
  assert.ok(!/redirect/.test(f.script_data), 'no forwarding');
  // colleagues' status is only for business accounts
  assert.deepEqual((await bob.get(`/api/ooo?emails=${a}`)).data.away, []);

  // ---- 2. templates keep their group
  const tpl = { name: 'Quote', subject: 'Your quote for {{service}}', html: '<div>Hi {{first_name}}, the price is {{price}}.</div>', category: 'Sales' };
  const saved = (await alice.put('/api/templates', { templates: [tpl] })).data.templates;
  assert.equal(saved[0].category, 'Sales'); assert.match(saved[0].html, /\{\{price\}\}/);

  // ---- 3. nudges: three emails to Bob (nudge after 7 "days" first, so the too-early check isn't racing the clock)
  await alice.put('/api/nudges/settings', { days: 7, onlyQuestions: true });
  const mid = async (subject) => (await alice.get('/api/messages?folder=Sent')).data.messages.find((m) => m.subject === subject);
  assert.equal((await alice.send({ to: b, subject: `Review ${run}`, text: 'Could you review the draft by Friday?', html: '<p>Could you review the draft by Friday?</p>' })).status, 200);
  assert.equal((await alice.send({ to: b, subject: `FYI ${run}`, text: 'Just so you know, the office is closed.', html: '<p>Just so you know, the office is closed.</p>' })).status, 200);
  assert.equal((await alice.send({ to: b, subject: `Lunch ${run}`, text: 'Lunch on Tuesday?', html: '<p>Lunch on Tuesday?</p>' })).status, 200);
  await sleep(1500);
  // Bob answers the lunch one
  const lunch = (await bob.get('/api/messages?folder=INBOX')).data.messages.find((m) => m.subject === `Lunch ${run}`);
  const lunchFull = (await bob.get(`/api/message?folder=INBOX&uid=${lunch.uid}`)).data;
  assert.equal((await bob.send({ to: a, subject: `Re: Lunch ${run}`, text: 'Yes!', html: '<p>Yes!</p>', inReplyTo: lunchFull.messageId, references: lunchFull.messageId })).status, 200);
  // too early: nothing yet
  assert.equal((await alice.get('/api/nudges?refresh=1')).data.nudges.length, 0, 'not before 3 "days"');
  await alice.put('/api/nudges/settings', { days: 3, onlyQuestions: true });
  await sleep(3500);
  let n = (await alice.get('/api/nudges?refresh=1')).data;
  assert.deepEqual(n.nudges.map((x) => x.subject), [`Review ${run}`], 'only the unanswered question');
  assert.equal(n.nudges[0].to[0].address, b); assert.ok(n.nudges[0].days >= 3);
  // all emails, not just questions
  await alice.put('/api/nudges/settings', { days: 3, onlyQuestions: false });
  n = (await alice.get('/api/nudges')).data;
  assert.deepEqual(n.nudges.map((x) => x.subject).sort(), [`FYI ${run}`, `Review ${run}`]);
  // dismiss
  assert.equal((await alice.post('/api/nudges/dismiss', { messageId: n.nudges.find((x) => x.subject === `FYI ${run}`).messageId })).status, 200);
  assert.deepEqual((await alice.get('/api/nudges?refresh=1')).data.nudges.map((x) => x.subject), [`Review ${run}`]);
  assert.equal((await alice.post('/api/nudges/dismiss', { messageId: 'nope' })).status, 400);
  await alice.put('/api/nudges/settings', { days: 3, onlyQuestions: true });

  // ---- 4. in the browser
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
    const [cn, cv] = alice.cookie.split('='); await ctx.addCookies([{ name: cn, value: cv, domain: new URL(BASE).hostname, path: '/' }]);
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${BASE}/app`);
    // the out-of-office bar
    await page.waitForSelector('.ooo-bar >> text=Out of office is on');
    // the nudge, and bumping it opens a reply to Bob
    await page.waitForSelector(`.nudge >> text=Review ${run}`);
    await page.click('.nudge >> button:has-text("Bump")');
    await page.waitForSelector(`.composer input[aria-label="Subject"][value="Re: Review ${run}"]`);
    assert.match(await page.locator('.composer [contenteditable="true"]').first().innerText(), /just following up/i);
    await page.click('.composer [title="Discard draft"]').catch(() => {});
    await page.waitForSelector('.nudge', { state: 'detached' }); // the bumped one is gone

    // templates: add a ready-made one, then use it with fill-in fields
    await page.goto(`${BASE}/app`);
    await page.click('[aria-label="Settings"]');
    await page.click('.settings-nav >> text=Templates').catch(() => page.click('text=Templates'));
    await page.click('.seg >> text=Ready-made');
    await page.click('.chip >> text=Sales');
    await page.locator('.tpl-card', { hasText: 'Send a quote' }).locator('button:has-text("Add to my templates")').click();
    await page.waitForSelector('text=Added to your templates');
    await page.keyboard.press('Escape');
    await page.goto(`${BASE}/app`);
    await page.click('text=New mail');
    await page.keyboard.type(`${b}`); await page.keyboard.press('Enter');
    await page.click('[aria-label="More options"]'); await page.click('.more-menu >> text=Template');
    await page.fill('.tpl-menu input[type="search"]', 'quote');
    await page.locator('.tpl-menu button', { hasText: 'Send a quote' }).first().click();
    await page.fill('.tpl-fill label:has-text("Service") input', 'Roof repair');
    await page.fill('.tpl-fill label:has-text("Price") input', '$1,200');
    await page.click('.tpl-fill >> button:has-text("Insert")');
    assert.equal(await page.locator('.composer input[aria-label="Subject"]').inputValue(), 'Your quote for Roof repair');
    const body = await page.locator('.composer [contenteditable="true"]').first().innerText();
    assert.match(body, /Hi Nb\w*,/); assert.match(body, /\$1,200/); assert.match(body, /\{\{timing\}\}/, 'left blank stays to fill later');

    // the out-of-office settings page, then turn it off from the bar
    await page.click('.composer [title="Discard draft"]').catch(() => {});
    await page.click('.ooo-bar >> button:has-text("Turn off")');
    await page.waitForSelector('.ooo-bar', { state: 'detached' });
    assert.equal((await alice.get('/api/vacation')).data.enabled, false);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
