// The phone apps (mobile/) run the web app inside Capacitor. This fakes the native shell (window.Capacitor and its
// plugins) in a real browser and checks what client/src/native.js does with it:
// notifications register with the server, email links open in the in-app browser, attachments go to the share sheet,
// tapping a notification opens the app. Needs the running stack and Playwright with Chromium.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const D = process.env.TEST_DOMAIN || 'free.test';
const PW = 'Tq9-vLm2-Zx81';
const hdr = { 'X-Requested-With': 'mailcow-client', 'X-Forwarded-For': `198.19.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(path, body, cookie, form) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { ...hdr, ...(cookie ? { Cookie: cookie } : {}), ...(form ? {} : { 'Content-Type': 'application/json' }) }, body: form || JSON.stringify(body) });
  return { status: r.status, cookie: (r.headers.getSetCookie?.() || []).find((c) => c.startsWith('mc_session='))?.split(';')[0] };
}

// The fake native shell, injected before the app loads
const shell = ({ platform, token }) => {
  window.__calls = []; const listeners = {};
  const on = (ev) => (fn) => { (listeners[ev] ||= []).push(fn); return Promise.resolve({ remove() {} }); };
  window.__fire = (ev, data) => (listeners[ev] || []).forEach((f) => f(data));
  window.Capacitor = {
    isNativePlatform: () => true, getPlatform: () => platform,
    Plugins: {
      Browser: { open: async (o) => { window.__calls.push(['browser', o.url]); } },
      Filesystem: { writeFile: async (o) => { window.__calls.push(['file', o.path, o.directory, o.data.length]); return { uri: `file:///cache/${o.path}` }; } },
      Share: { share: async (o) => { window.__calls.push(['share', o.files?.[0]]); } },
      PushNotifications: {
        checkPermissions: async () => ({ receive: localStorage.getItem('__perm') || 'prompt' }),
        requestPermissions: async () => { localStorage.setItem('__perm', 'granted'); window.__calls.push(['permission']); return { receive: 'granted' }; },
        createChannel: async (c) => { window.__calls.push(['channel', c.id]); },
        addListener: (ev, fn) => on(`push:${ev}`)(fn),
        register: async () => { setTimeout(() => window.__fire('push:registration', { value: token }), 30); },
      },
      App: { addListener: (ev, fn) => on(`app:${ev}`)(fn) },
      StatusBar: { setStyle: async () => {} },
    },
  };
};

test('phone app: notifications, links, attachments and notification taps', async () => {
  const user = `m${crypto.randomBytes(3).toString('hex')}`;
  const { cookie } = await post('/api/signup', { name: 'Mobile Test', username: user, password: PW, acceptTerms: true, birthday: '1990-01-15', recoveryEmail: 'recovery@example.org', phone: '+15555550123' });
  assert.ok(cookie, 'signed up');
  await post('/api/setup/2fa/remind', {}, cookie); await post('/api/setup/step', { step: 'done' }, cookie);
  await sleep(1500);
  const fd = new FormData();
  fd.append('to', `${user}@${D}`); fd.append('subject', 'Plans for Elm Street');
  fd.append('html', '<p>See <a id="ext" href="https://example.com/plans">the plans</a>.</p>');
  fd.append('attachments', new Blob(['tile samples, page 1'], { type: 'text/plain' }), 'samples.txt');
  assert.equal((await post('/api/send', null, cookie, fd)).status, 200);
  await sleep(1500);

  const browser = await chromium.launch();
  try {
    for (const [platform, token] of [['android', `fcm-${crypto.randomBytes(12).toString('hex')}`], ['ios', crypto.randomBytes(32).toString('hex')]]) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      const [n, v] = cookie.split('='); await ctx.addCookies([{ name: n, value: v, domain: new URL(BASE).hostname, path: '/' }]);
      await ctx.addInitScript(shell, { platform, token });
      const page = await ctx.newPage();
      const registered = page.waitForRequest((r) => r.url().endsWith('/api/push/native') && r.method() === 'POST', { timeout: 20000 });
      await page.goto(`${BASE}/app`);
      await page.waitForSelector('text=Plans for Elm Street', { timeout: 20000 });

      // 1. asks once for notification permission, then sends the device token to the server
      const reg = await registered;
      assert.deepEqual(JSON.parse(reg.postData()), { platform, token }, `${platform}: token registered`);
      assert.equal((await reg.response()).status(), 200);
      assert.ok(await page.evaluate(() => document.documentElement.classList.contains('native-app')));
      const calls = () => page.evaluate(() => window.__calls);
      assert.ok((await calls()).some((c) => c[0] === 'permission'));
      if (platform === 'android') assert.ok((await calls()).some((c) => c[0] === 'channel' && c[1] === 'mail'), 'Android notification channel');

      // 2. a link inside the email opens in the in-app browser, the app itself stays put
      await page.click('text=Plans for Elm Street');
      const before = page.url();
      await page.frameLocator('iframe.msg-frame').locator('#ext').click();
      await sleep(400);
      assert.ok((await calls()).some((c) => c[0] === 'browser' && c[1] === 'https://example.com/plans'), `${platform}: link → in-app browser`);
      assert.equal(page.url(), before);

      // 3. an attachment is downloaded with the session and handed to the share sheet
      await page.click('a.att');
      await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'share'), null, { timeout: 10000 });
      const file = (await calls()).find((c) => c[0] === 'file');
      assert.equal(file[1], 'samples.txt'); assert.equal(file[2], 'CACHE'); assert.ok(file[3] > 10, 'file content saved');
      assert.equal((await calls()).find((c) => c[0] === 'share')[1], 'file:///cache/samples.txt');

      // 4. tapping a notification opens the app at its link
      await page.evaluate(() => window.__fire('push:pushNotificationActionPerformed', { notification: { data: { url: '/app' } } }));
      await page.waitForURL(/\/inbox/, { timeout: 10000 });
      await ctx.close();
    }
  } finally { await browser.close(); }
});
