// Speed: compressed app files and data, long browser caching, instant lists and emails loaded ahead of time
// (without marking them read or sending read receipts).
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
  constructor() { this.cookie = ''; this.ip = `198.51.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`; }
  async req(method, path, body, form, headers = {}) {
    const r = await fetch(BASE + path, { method, headers: { 'X-Requested-With': 'mailcow-client', 'X-Forwarded-For': this.ip, ...(this.cookie ? { Cookie: this.cookie } : {}), ...(body && !form ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: form || (body ? JSON.stringify(body) : undefined) });
    for (const c of r.headers.getSetCookie?.() || []) if (c.startsWith('mc_session=')) this.cookie = c.split(';')[0];
    const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
    return { status: r.status, data, headers: r.headers };
  }
  get(p) { return this.req('GET', p); }
  post(p, b) { return this.req('POST', p, b || {}); }
  send(fields) { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, v); return this.req('POST', '/api/send', null, f); }
}
async function signup(user) {
  const c = new Client();
  const r = await c.post('/api/signup', { name: `Test ${user}`, username: user, password: PW, acceptTerms: true, birthday: '1990-01-15', recoveryEmail: 'recovery@example.org', phone: '+15555550123', formMs: 60000 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await c.post('/api/setup/2fa/remind'); await c.post('/api/setup/step', { step: 'done' });
  return c;
}

test('app files are compressed and kept by the browser', async () => {
  await sleep(3000); // the smallest (brotli) copies are made just after start-up
  const html = await (await fetch(`${BASE}/login`)).text();
  const js = html.match(/\/app-assets\/index-[\w-]+\.js/)[0];
  const br = await fetch(BASE + js, { headers: { 'Accept-Encoding': 'br' } });
  assert.equal(br.headers.get('content-encoding'), 'br');
  assert.match(br.headers.get('cache-control'), /immutable/);
  const plain = await fetch(BASE + js, { headers: { 'Accept-Encoding': 'identity' } });
  assert.equal(plain.headers.get('content-encoding'), null);
  assert.ok((await plain.arrayBuffer()).byteLength > 3 * Number(br.headers.get('content-length')), 'at least 3x smaller');
});

test('instant inbox and emails loaded ahead without marking them read', async () => {
  const a = await signup(`sp${run}`); const b = await signup(`sq${run}`);
  for (let i = 1; i <= 3; i++) await b.send({ to: `sp${run}@${D}`, subject: `Hello ${i} ${run}`, text: `Body ${i} `.repeat(200), html: `<p>${`Body ${i} `.repeat(200)}</p>` });
  await sleep(1500);
  const list = await a.req('GET', '/api/messages?folder=INBOX', null, null, { 'Accept-Encoding': 'br' });
  assert.equal(list.headers.get('content-encoding'), 'br', 'mail list is compressed');

  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
    const [n, v] = a.cookie.split('='); await ctx.addCookies([{ name: n, value: v, domain: new URL(BASE).hostname, path: '/' }]);
    const p = await ctx.newPage();
    const errors = []; p.on('pageerror', (e) => errors.push(e.message));
    const ahead = []; p.on('request', (r) => { if (/\/api\/(thread|message)\?.*peek=1/.test(r.url())) ahead.push(r.url()); });
    await p.goto(`${BASE}/app`);
    await p.waitForSelector(`text=Hello 3 ${run}`);
    for (let i = 0; i < 20 && ahead.length < 3; i++) await sleep(200);
    assert.ok(ahead.length >= 3, `the unread emails were loaded ahead (${ahead.length})`);
    const still = (await a.get('/api/messages?folder=INBOX')).data.messages.filter((m) => m.subject.endsWith(run));
    assert.ok(still.every((m) => !m.seen), 'loading ahead did not mark anything read');

    // opening one is instant and marks it read
    await p.click(`text=Hello 3 ${run}`);
    await p.waitForSelector('text=Body 3', { timeout: 1500 });
    await sleep(800);
    assert.ok((await a.get('/api/messages?folder=INBOX')).data.messages.find((m) => m.subject === `Hello 3 ${run}`).seen, 'opening marks it read');

    // going back to the inbox shows it at once (no loading placeholders)
    await p.locator('.folder').filter({ hasNotText: /Inbox|All inboxes|Scheduled/ }).first().click();
    await p.waitForSelector('text=Hello 1', { state: 'detached' });
    await p.locator('.folder').filter({ hasText: /^\s*Inbox/ }).first().click();
    await p.waitForSelector(`text=Hello 1 ${run}`, { timeout: 150 });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
