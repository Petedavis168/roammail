// Faster sending (pooled connection, Sent copy filed after), better-formed mail (text part, own-domain Message-ID),
// contact cards, "best time to send", the installable app (manifest, share target) and swipe gestures on phones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { bestSendTime } from '../../client/src/snooze.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const D = process.env.TEST_DOMAIN || 'free.test';
const PW = 'Tq9-vLm2-Zx81';
const run = crypto.randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor() { this.cookie = ''; this.ip = `198.42.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`; }
  async req(method, path, body, form) {
    const r = await fetch(BASE + path, { method, redirect: 'manual', headers: { 'X-Requested-With': 'mailcow-client', 'X-Forwarded-For': this.ip, ...(this.cookie ? { Cookie: this.cookie } : {}), ...(body && !form ? { 'Content-Type': 'application/json' } : {}) }, body: form || (body ? JSON.stringify(body) : undefined) });
    for (const c of r.headers.getSetCookie?.() || []) if (c.startsWith('mc_session=')) this.cookie = c.split(';')[0];
    const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
    return { status: r.status, data, headers: r.headers };
  }
  get(p) { return this.req('GET', p); }
  post(p, b) { return this.req('POST', p, b || {}); }
  send(fields) { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, v); return this.req('POST', '/api/send', null, f); }
}
async function signup(user, name) {
  const c = new Client();
  assert.equal((await c.post('/api/signup', { name, username: user, password: PW, acceptTerms: true, birthday: '1990-01-15', recoveryEmail: 'recovery@example.org', phone: '+15555550123' })).status, 200);
  await c.post('/api/setup/2fa/remind'); await c.post('/api/setup/step', { step: 'done' });
  return c;
}

test('best time to send: from when they usually write', () => {
  const now = new Date(2026, 10, 9, 15, 0); // a Monday afternoon
  const tue10 = []; for (let w = 0; w < 6; w++) { const d = new Date(2026, 9, 6 + w * 7, 10, 12); tue10.push(d.getTime()); } // Tuesdays ~10:12
  const b = bestSendTime(tue10, now);
  assert.equal(b.usual, true); assert.equal(b.hour, 10);
  const at = new Date(b.at); assert.equal(at.getDay(), 2); assert.equal(at.getHours(), 9); assert.equal(at.getMinutes(), 50);
  const g = bestSendTime([], now); // no history: next weekday morning
  assert.equal(g.usual, false); assert.equal(new Date(g.at).getHours(), 8);
  const fri = bestSendTime([], new Date(2026, 10, 13, 15, 0)); assert.equal(new Date(fri.at).getDay(), 1, 'skips the weekend');
});

test('sending, contact cards, installable app, gestures', async () => {
  const me = await signup(`ca${run}`, 'Casey Adams'); const pal = await signup(`cb${run}`, 'Robin Bell');
  const email = `ca${run}@${D}`; const palEmail = `cb${run}@${D}`;
  await sleep(1500);

  // ---- 1. sending: quick, Sent copy filed right after, text part added, Message-ID on our domain
  let t0 = Date.now();
  assert.equal((await me.send({ to: palEmail, subject: `First ${run}`, html: '<p>Hello <b>Robin</b>, how are you?</p>' })).status, 200);
  const first = Date.now() - t0;
  t0 = Date.now();
  assert.equal((await me.send({ to: palEmail, subject: `Second ${run}`, html: '<p>Again</p>', text: 'Again' })).status, 200);
  const second = Date.now() - t0;
  assert.ok(second < 3000, `second send took ${second} ms (first ${first} ms)`);
  await sleep(1500);
  const sent = (await me.get('/api/messages?folder=Sent')).data.messages;
  assert.ok(sent.some((m) => m.subject === `First ${run}`) && sent.some((m) => m.subject === `Second ${run}`), 'Sent copies filed');
  const got = (await pal.get('/api/messages?folder=INBOX')).data.messages.find((m) => m.subject === `First ${run}`);
  const full = (await pal.get(`/api/message?folder=INBOX&uid=${got.uid}`)).data;
  assert.match(full.text, /Hello Robin, how are you\?/i, 'plain-text part made from the HTML');
  assert.match(full.messageId, new RegExp(`@${D.replace('.', '\\.')}>?$`), 'Message-ID on the sender’s domain');
  // pal replies twice
  await pal.send({ to: email, subject: `Re: First ${run}`, text: 'Good thanks!', html: '<p>Good thanks!</p>' });
  await pal.send({ to: email, subject: `Photos ${run}`, text: 'Here', html: '<p>Here</p>' });
  await sleep(1500);

  // ---- 2. contact card
  let card = (await me.get(`/api/people/card?email=${palEmail}`)).data;
  assert.equal(card.name, 'Robin Bell'); assert.equal(card.stats.received, 2); assert.equal(card.stats.sent, 2);
  assert.ok(card.recent.some((m) => m.dir === 'in' && m.subject === `Photos ${run}`) && card.recent.some((m) => m.dir === 'out'));
  assert.equal(card.inContacts, false);
  await me.post('/api/notes', { body: 'Prefers calls in the morning', contact: palEmail });
  card = (await me.get(`/api/people/card?email=${palEmail}`)).data;
  assert.equal(card.notes[0].body, 'Prefers calls in the morning');
  assert.equal((await me.get('/api/people/card?email=not-an-email')).status, 400);
  const act = (await me.get(`/api/people/activity?email=${palEmail}`)).data;
  assert.equal(act.times.length, 2);

  // ---- 3. installable app
  const mf = await (await fetch(`${BASE}/manifest.webmanifest`)).json();
  assert.equal(mf.share_target.action, '/share-target'); assert.equal(mf.protocol_handlers[0].protocol, 'mailto');
  assert.ok(mf.screenshots.length >= 2 && mf.shortcuts.length >= 3);
  for (const s of mf.screenshots) assert.equal((await fetch(`${BASE}${s.src}`)).status, 200, s.src);
  const st = await fetch(`${BASE}/share-target`, { method: 'POST', redirect: 'manual' });
  assert.equal(st.status, 303); assert.equal(st.headers.get('location'), '/app?compose=1');

  // ---- 4. in the browser
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
    const [cn, cv] = me.cookie.split('='); await ctx.addCookies([{ name: cn, value: cv, domain: new URL(BASE).hostname, path: '/' }]);
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${BASE}/app`);
    // contact card from the sender's name
    await page.click(`.row >> text=Photos ${run}`);
    await page.click('.tmsg-head .person-link.strong');
    await page.waitForSelector('.ccard >> text=Robin Bell');
    await page.waitForSelector('.ccard >> text=Prefers calls in the morning');
    assert.match(await page.locator('.ccard').innerText(), /2 from them · 2 to them/);
    await page.click('.ccard-actions >> text=Save');
    await page.waitForSelector('.ccard-saved >> text=In contacts');
    await page.click('.ccard-actions >> text=Email');
    await page.waitForSelector('.composer');
    assert.match(await page.locator('.composer').first().innerText(), /Robin Bell|cb/);
    // best time to send, in the send menu
    await page.click('.composer [title="Schedule send"]');
    await page.waitForSelector('.best-time >> text=Best time for Robin');
    await page.keyboard.press('Escape');
    await page.click('.composer [title="Discard draft"]').catch(() => {});

    // shared from another app: the app opens a new email with it
    await page.evaluate(async () => {
      const c = await caches.open('share-v1');
      await c.put('/share/meta', new Response(JSON.stringify({ title: 'Trip photos', text: 'Look at these', url: 'https://example.com/album', files: [{ i: 0, name: 'beach.txt', type: 'text/plain' }] })));
      await c.put('/share/file/0', new Response('sand and sea', { headers: { 'Content-Type': 'text/plain' } }));
    });
    await page.goto(`${BASE}/app?share=1`);
    await page.waitForSelector('.composer input[aria-label="Subject"][value="Trip photos"]');
    assert.match(await page.locator('.composer [contenteditable="true"]').first().innerText(), /Look at these\s+https:\/\/example\.com\/album/);
    await page.waitForSelector('.composer >> text=beach.txt');
    assert.deepEqual(errors, []);

    // phone: swipe a message left to archive it
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await phone.addCookies([{ name: cn, value: cv, domain: new URL(BASE).hostname, path: '/' }]);
    const pp = await phone.newPage();
    await pp.goto(`${BASE}/app`);
    const row = pp.locator('.row', { hasText: `Re: First ${run}` });
    await row.waitFor();
    const box = await row.boundingBox();
    const cdp = await phone.newCDPSession(pp);
    const y = box.y + box.height / 2;
    const touch = (type, x) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    await touch('touchStart', box.x + box.width - 20);
    for (let x = box.x + box.width - 30; x > box.x + 40; x -= 25) await touch('touchMove', x);
    await touch('touchEnd');
    await pp.waitForSelector(`.row >> text=Re: First ${run}`, { state: 'detached', timeout: 8000 });
    await sleep(800);
    assert.ok((await me.get('/api/messages?folder=Archive')).data.messages.some((m) => m.subject === `Re: First ${run}`), 'archived');
  } finally { await browser.close(); }
});
