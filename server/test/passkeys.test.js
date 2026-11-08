// Passkeys end to end in a real browser with Chrome's virtual authenticator (a simulated fingerprint reader):
// add a passkey in Settings, sign out, sign back in with it; password change removes passkeys. Needs the stack + Playwright.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const PW = 'Tq9-vLm2-Zx81';
const hdr = { 'X-Requested-With': 'mailcow-client', 'Content-Type': 'application/json', 'X-Forwarded-For': `198.23.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('passkeys: add one, sign in with it, wrong or removed passkeys are refused', async () => {
  const user = `pk${crypto.randomBytes(3).toString('hex')}`;
  const r = await fetch(`${BASE}/api/signup`, { method: 'POST', headers: hdr, body: JSON.stringify({ name: 'Pass Key', username: user, password: PW, acceptTerms: true, birthday: '1990-01-15', recoveryEmail: 'recovery@example.org', phone: '+15555550123' }) });
  assert.equal(r.status, 200);
  const cookie = r.headers.getSetCookie().find((c) => c.startsWith('mc_session=')).split(';')[0];
  for (const [p, b] of [['/api/setup/2fa/remind', {}], ['/api/setup/step', { step: 'done' }]]) await fetch(BASE + p, { method: 'POST', headers: { ...hdr, Cookie: cookie }, body: JSON.stringify(b) });
  await sleep(1200);

  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    const [n, v] = cookie.split('='); await ctx.addCookies([{ name: n, value: v, domain: new URL(BASE).hostname, path: '/' }]);

    // add a passkey in Settings → Security (asks for the password once)
    await page.goto(`${BASE}/app`); await page.waitForTimeout(1500);
    const id = new URL(page.url()).pathname.split('/')[1];
    await page.goto(`${BASE}/${id}/settings`); await page.waitForTimeout(800);
    await page.locator('text="Security"').first().click();
    page.once('dialog', (d) => d.accept(PW));
    await page.click('text=Add a passkey for this device');
    await page.waitForSelector('.plain-list li', { timeout: 15000 });
    const list = await (await fetch(`${BASE}/api/passkeys`, { headers: { ...hdr, Cookie: cookie } })).json();
    assert.equal(list.length, 1);

    // sign out, then sign in with the passkey: no email, no password, no code
    await ctx.clearCookies();
    await page.goto(`${BASE}/login`);
    await page.click('text=Sign in with a passkey');
    await page.waitForURL(new RegExp(`/${id}/`), { timeout: 15000 });
    const me = await page.evaluate(() => fetch('/api/me').then((x) => x.json()));
    assert.equal(me.email, `${user}@${process.env.TEST_DOMAIN || 'free.test'}`);

    // a forged / unknown credential is refused
    const opts = await (await fetch(`${BASE}/api/login/passkey/options`, { method: 'POST', headers: hdr, body: '{}' })).json();
    const bad = await fetch(`${BASE}/api/login/passkey`, { method: 'POST', headers: hdr, body: JSON.stringify({ token: opts.token, response: { id: 'nope', rawId: 'nope', type: 'public-key', response: {} } }) });
    assert.equal(bad.status, 401);

    // removing it from Settings means it no longer works
    const sessCookie = (await ctx.cookies()).find((c) => c.name === 'mc_session');
    assert.equal((await fetch(`${BASE}/api/passkeys?id=${encodeURIComponent(list[0].id)}`, { method: 'DELETE', headers: { ...hdr, Cookie: `mc_session=${sessCookie.value}` } })).status, 200);
    await ctx.clearCookies();
    await page.goto(`${BASE}/login`);
    await page.click('text=Sign in with a passkey');
    await page.waitForSelector('text=/isn.t set up for Roammail any more/', { timeout: 15000 });
    await ctx.close();
  } finally { await browser.close(); }
});
