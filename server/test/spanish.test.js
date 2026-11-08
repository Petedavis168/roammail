// Spanish: a browser set to Spanish gets the app in Spanish, and the language can be changed in Settings → General.
// Needs the running stack and Playwright with Chromium.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const hdr = { 'X-Requested-With': 'mailcow-client', 'X-Forwarded-For': `198.30.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`, 'Content-Type': 'application/json' };

test('Spanish: follows the browser language and can be switched in Settings', async () => {
  const r = await fetch(`${BASE}/api/signup`, { method: 'POST', headers: hdr, body: JSON.stringify({ name: 'Ana Ruiz', username: `es${crypto.randomBytes(3).toString('hex')}`, password: 'Tq9-vLm2-Zx81', acceptTerms: true, birthday: '1990-01-15', recoveryEmail: 'recovery@example.org', phone: '+15555550123' }) });
  const cookie = r.headers.getSetCookie().find((c) => c.startsWith('mc_session=')).split(';')[0];
  for (const [p, b] of [['/api/setup/2fa/remind', {}], ['/api/setup/step', { step: 'done' }]]) await fetch(BASE + p, { method: 'POST', headers: { ...hdr, Cookie: cookie }, body: JSON.stringify(b) });

  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ locale: 'es-ES', viewport: { width: 1280, height: 860 } });
    const [n, v] = cookie.split('='); await ctx.addCookies([{ name: n, value: v, domain: new URL(BASE).hostname, path: '/' }]);
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${BASE}/app`);
    await page.waitForSelector('text=Nuevo correo', { timeout: 20000 });
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'es');

    // Settings → General → Language: English
    await page.goto(page.url().replace(/\/inbox.*/, '/settings'));
    const picker = page.locator('label:has-text("Idioma") select');
    await picker.waitFor({ timeout: 15000 });
    await Promise.all([page.waitForEvent('load'), picker.selectOption('en')]);
    await page.waitForSelector('text=Language', { timeout: 15000 });
    await page.goto(`${BASE}/app`);
    await page.waitForSelector('text=New mail', { timeout: 20000 });
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally { await browser.close(); }
});
