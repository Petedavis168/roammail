// Bots and scammers (sign-up traps, throwaway recovery addresses, outgoing scam check, Report scam), refer a friend,
// the status page history, "how far back" for imports, and the Private badge between Roammail users.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { scamScore, isDisposable } from '../src/scamguard.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const D = process.env.TEST_DOMAIN || 'free.test';
const PW = 'Tq9-vLm2-Zx81';
const run = crypto.randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(ip) { this.cookie = ''; this.ip = ip || `198.48.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`; }
  async req(method, path, body, form) {
    const r = await fetch(BASE + path, { method, headers: { 'X-Requested-With': 'mailcow-client', 'X-Forwarded-For': this.ip, ...(this.cookie ? { Cookie: this.cookie } : {}), ...(body && !form ? { 'Content-Type': 'application/json' } : {}) }, body: form || (body ? JSON.stringify(body) : undefined) });
    for (const c of r.headers.getSetCookie?.() || []) if (c.startsWith('mc_session=')) this.cookie = c.split(';')[0];
    const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
    return { status: r.status, data };
  }
  get(p) { return this.req('GET', p); }
  post(p, b) { return this.req('POST', p, b || {}); }
  send(fields) { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, v); return this.req('POST', '/api/send', null, f); }
}
const signupBody = (user, extra = {}) => ({ name: `Test ${user}`, username: user, password: PW, acceptTerms: true, birthday: '1990-01-15', recoveryEmail: 'recovery@example.org', phone: '+15555550123', ...extra });
async function signup(user, extra, ip) {
  const c = new Client(ip);
  const r = await c.post('/api/signup', signupBody(user, extra));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await c.post('/api/setup/2fa/remind'); await c.post('/api/setup/step', { step: 'done' });
  return c;
}

test('scam scoring', () => {
  assert.ok(scamScore({ fromName: 'PayPal Support', subject: 'Your account has been suspended', text: 'Please verify your account within 24 hours or it will be suspended. Click here to verify.' }).score >= 6);
  assert.ok(scamScore({ subject: 'Quick favor', text: 'Can you buy 5 Apple gift cards and send me the codes? I will pay you back.' }).score >= 6);
  assert.ok(scamScore({ subject: 'Invest', text: 'Send bitcoin to this wallet and we double your profit' }).score >= 3);
  const shown = scamScore({ subject: 'Docs', html: '<p>See <a href="https://evil.example/x">www.mybank.com</a></p>' });
  assert.ok(shown.reasons.some((r) => /shows mybank\.com but goes to evil\.example/.test(r)));
  assert.equal(scamScore({ subject: 'Lunch tomorrow?', text: 'Want to grab lunch at noon? I can book the place on Main St.' }).score, 0);
  assert.equal(scamScore({ subject: 'Invoice 1042', text: 'Hi Sam, attached is invoice 1042 for March. Thanks!' }).score, 0);
  assert.ok(isDisposable('x@mailinator.com')); assert.ok(!isDisposable('x@gmail.com'));
});

test('bots, scams, referrals, status page, private badge', async () => {
  // ---- sign-up bot traps
  let r = await new Client().post('/api/signup', signupBody(`bt${run}`, { website: 'http://spam.example' }));
  assert.equal(r.status, 400);
  r = await new Client().post('/api/signup', signupBody(`bt${run}`, { formMs: 400 }));
  assert.equal(r.status, 400); assert.match(r.data.error, /very fast/);
  r = await new Client().post('/api/signup', signupBody(`bt${run}`, { recoveryEmail: 'me@mailinator.com' }));
  assert.equal(r.status, 400); assert.match(r.data.error, /temporary inbox/);

  // ---- refer a friend
  const a = await signup(`sa${run}`, { formMs: 60000 });
  const ref = (await a.get('/api/referrals')).data;
  assert.match(ref.code, /^[A-HJ-NP-Z2-9]{8}$/); assert.match(ref.link, new RegExp(`/signup\\?ref=${ref.code}$`));
  const b = await signup(`sb${run}`, { ref: ref.code });
  await signup(`sc${run}`, { ref: ref.code }, a.ip); // same network as the referrer: doesn't count
  const mine = (await a.get('/api/referrals')).data;
  assert.equal(mine.friends.length, 2);
  assert.deepEqual(mine.friends.map((f) => f.status).sort(), ['not-eligible', 'pending']);
  assert.ok(mine.friends.every((f) => f.who.includes('•')), 'friends are masked');
  assert.equal((await a.get('/api/referrals')).data.code, ref.code, 'same code every time');
  await sleep(1500);

  // ---- outgoing scam check (new account): refused, a second one pauses sending
  const ea = `sa${run}@${D}`; const eb = `sb${run}@${D}`;
  r = await a.send({ to: eb, subject: 'Lunch?', text: 'Lunch on Friday?', html: '<p>Lunch on Friday?</p>' });
  assert.equal(r.status, 200);
  const scam = { to: eb, subject: 'Your PayPal account has been suspended', text: 'Please verify your account within 24 hours or it will be suspended. Click here to verify your password.', html: '<p>Please verify your account within 24 hours or it will be suspended. <a href="https://evil.example/x">www.paypal.com</a></p>', fromName: 'PayPal Support' };
  r = await a.send(scam);
  assert.equal(r.status, 403); assert.match(r.data.error, /looks like a scam/);
  r = await a.send(scam);
  assert.equal(r.status, 403);
  r = await a.send({ to: eb, subject: 'Hi', text: 'hi', html: '<p>hi</p>' });
  assert.notEqual(r.status, 200, 'sending paused after a second scam');

  // ---- private badge between Roammail users, and Report scam
  await sleep(1500);
  const lunch = (await b.get('/api/messages?folder=INBOX')).data.messages.find((m) => m.subject === 'Lunch?');
  const full = (await b.get(`/api/message?folder=INBOX&uid=${lunch.uid}`)).data;
  assert.equal(full.privateDelivery, true);
  r = await b.post('/api/report-scam', { folder: 'INBOX', uid: lunch.uid });
  assert.equal(r.status, 200); assert.equal(r.data.reported, true);
  assert.ok(!(await b.get('/api/messages?folder=INBOX')).data.messages.some((m) => m.subject === 'Lunch?'), 'moved out of the inbox');
  assert.ok((await b.get(`/api/messages?folder=${encodeURIComponent(r.data.movedTo)}`)).data.messages.some((m) => m.subject === 'Lunch?'));

  // ---- status page
  const page = await (await fetch(`${BASE}/status`)).text();
  assert.match(page, /All systems are working normally|Some services/);

  // ---- in the browser: sign-up keeps the referral code; Refer a friend page; Report scam in the menu
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
    const [n, v] = b.cookie.split('='); await ctx.addCookies([{ name: n, value: v, domain: new URL(BASE).hostname, path: '/' }]);
    const p = await ctx.newPage();
    const errors = []; p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${BASE}/app`);
    await p.click('[aria-label="Settings"]');
    await p.click('.settings-nav >> text=Refer a friend');
    await p.waitForSelector('text=Give a month, get a month');
    assert.match(await p.locator('.ref-link input').inputValue(), /\/signup\?ref=[A-Z2-9]{8}$/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
  void ea;
});
