// Offline mode in a real browser: after one visit, Roammail opens and shows recent mail with no connection;
// mail written offline waits in the Outbox and sends when the connection is back; signing out forgets it all.
// Needs the running stack and Playwright with Chromium.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const D = process.env.TEST_DOMAIN || 'free.test';
const PW = 'Tq9-vLm2-Zx81';
const hdr = { 'X-Requested-With': 'mailcow-client', 'X-Forwarded-For': `198.28.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('offline: open the app, read saved mail, Outbox sends on reconnect, sign-out forgets it', async () => {
  const user = `of${crypto.randomBytes(3).toString('hex')}`;
  const email = `${user}@${D}`;
  const r = await fetch(`${BASE}/api/signup`, { method: 'POST', headers: { ...hdr, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Off Line', username: user, password: PW, acceptTerms: true, birthday: '1990-01-15', recoveryEmail: 'recovery@example.org', phone: '+15555550123' }) });
  const cookie = r.headers.getSetCookie().find((c) => c.startsWith('mc_session=')).split(';')[0];
  for (const [p, b] of [['/api/setup/2fa/remind', {}], ['/api/setup/step', { step: 'done' }]]) await fetch(BASE + p, { method: 'POST', headers: { ...hdr, 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(b) });
  await sleep(1000);
  const fd = new FormData(); fd.append('to', email); fd.append('subject', 'Read me on the plane'); fd.append('text', 'Boarding pass details inside.');
  await fetch(`${BASE}/api/send`, { method: 'POST', headers: { ...hdr, Cookie: cookie }, body: fd });
  await sleep(1500);

  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const [n, v] = cookie.split('='); await ctx.addCookies([{ name: n, value: v, domain: new URL(BASE).hostname, path: '/' }]);
    await ctx.addInitScript(() => localStorage.setItem('remember', '1')); // "Keep me signed in": offline copy allowed
    const page = await ctx.newPage();
    await page.goto(`${BASE}/app`);
    await page.waitForFunction(async () => !!(await navigator.serviceWorker?.ready), null, { timeout: 15000 });
    await page.reload(); // a second visit: from now on the service worker sees the app's requests
    await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 15000 });
    await page.waitForSelector('text=Read me on the plane');
    await page.click('.row >> text=Read me on the plane'); await page.waitForSelector('text=Boarding pass details inside.');
    const inbox = page.url();

    // no connection: the app still opens and the saved message is readable
    await ctx.setOffline(true);
    await page.goto(inbox.replace(/\/message\/.*/, '/inbox'));
    await page.waitForSelector('text=Read me on the plane', { timeout: 15000 });
    await page.click('.row >> text=Read me on the plane');
    await page.waitForSelector('text=Boarding pass details inside.', { timeout: 15000 });

    // write and send while offline: it goes to the Outbox
    await page.keyboard.press('Escape');
    await page.click('text=New mail');
    await page.keyboard.type(email); await page.keyboard.press('Enter');
    await page.locator('input[placeholder="Subject"], input[aria-label="Subject"]').first().fill('Written at 30,000 feet');
    await page.locator('[contenteditable="true"]').first().click(); await page.keyboard.type('Sent from the plane.');
    await page.click('.composer >> button:has-text("Send")');
    await page.waitForSelector('text=/Saved to your Outbox/', { timeout: 15000 });

    // back online: it sends by itself
    await ctx.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForSelector('text=/offline message was sent/', { timeout: 20000 });
    await sleep(1500);
    const list = await (await fetch(`${BASE}/api/messages?folder=INBOX`, { headers: { ...hdr, Cookie: cookie } })).json();
    assert.ok(list.messages.some((m) => m.subject === 'Written at 30,000 feet'), 'the offline message arrived');

    // signing out deletes the offline copy
    const before = await page.evaluate(async () => (await (await caches.open('mail-v2')).keys()).length);
    assert.ok(before > 0, 'mail was saved for offline use');
    await page.evaluate(() => navigator.serviceWorker.controller.postMessage({ type: 'signout' }));
    await sleep(800);
    assert.equal(await page.evaluate(async () => (await caches.keys()).includes('mail-v2')), false, 'offline mail deleted on sign-out');
    await ctx.close();

    // without "Keep me signed in" (e.g. a shared computer) nothing is kept on the device
    const shared = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    await shared.addCookies([{ name: n, value: v, domain: new URL(BASE).hostname, path: '/' }]);
    const p2 = await shared.newPage();
    await p2.goto(`${BASE}/app`);
    await p2.waitForFunction(async () => !!(await navigator.serviceWorker?.ready), null, { timeout: 15000 });
    await p2.reload(); await p2.waitForSelector('text=Read me on the plane');
    await sleep(800);
    assert.equal(await p2.evaluate(async () => (await caches.has('mail-v2')) ? (await (await caches.open('mail-v2')).keys()).length : 0), 0, 'no mail saved on a shared computer');
    await shared.close();
  } finally { await browser.close(); }
});
