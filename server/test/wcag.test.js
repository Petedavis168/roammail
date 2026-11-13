// Accessibility: no axe-core violations on the main screens, in light and dark mode; pop-ups close with Escape and
// keep keyboard focus inside.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const D = process.env.TEST_DOMAIN || 'free.test';
const PW = 'Tq9-vLm2-Zx81';
const ip = `198.51.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`;
let cookie = '';
async function post(p, b) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'X-Requested-With': 'mailcow-client', 'X-Forwarded-For': ip, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(b) });
  for (const c of r.headers.getSetCookie()) if (c.startsWith('mc_session=')) cookie = c.split(';')[0];
  return r.status;
}

test('main screens have no accessibility violations; dialogs work from the keyboard', async () => {
  const u = `ax${crypto.randomBytes(3).toString('hex')}`;
  assert.equal(await post('/api/signup', { name: 'Ax Test', username: u, password: PW, acceptTerms: true, birthday: '1990-01-15', recoveryEmail: 'r@example.org', phone: '+15555550123', formMs: 60000 }), 200);
  await post('/api/setup/2fa/remind'); await post('/api/setup/step', { step: 'done' });
  const fd = new FormData(); fd.append('to', `${u}@${D}`); fd.append('subject', 'Hello there'); fd.append('text', 'Hi'); fd.append('html', '<p>Hi</p>');
  await fetch(`${BASE}/api/send`, { method: 'POST', headers: { 'X-Requested-With': 'mailcow-client', Cookie: cookie }, body: fd });
  const browser = await chromium.launch();
  const problems = [];
  try {
    for (const theme of ['light', 'dark']) {
      const ctx = await browser.newContext({ bypassCSP: true, colorScheme: theme, viewport: { width: 1300, height: 900 } }); // CSP bypass only to inject the checker
      const p = await ctx.newPage();
      const audit = async (name) => {
        await p.addScriptTag({ content: AXE });
        const v = await p.evaluate(async () => (await axe.run(document, { resultTypes: ['violations'] })).violations.map((x) => `${x.impact} ${x.id}: ${x.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | ')}`));
        for (const x of v) problems.push(`${theme} ${name}: ${x}`);
      };
      await p.goto(`${BASE}/login`); await p.waitForSelector('.g-card'); await audit('sign-in');
      await p.goto(`${BASE}/signup`); await p.waitForSelector('.g-card'); await audit('sign-up');
      const [n, v] = cookie.split('='); await ctx.addCookies([{ name: n, value: v, domain: new URL(BASE).hostname, path: '/' }]);
      await p.goto(`${BASE}/app`); await p.waitForSelector('text=Hello there'); await audit('inbox');
      await p.click('text=Hello there'); await p.waitForSelector('.avatar-btn'); await audit('reading');
      await p.click('[aria-label="Settings"]'); await p.waitForSelector('.settings-modal'); await audit('settings');
      // keyboard: Tab stays inside, Escape closes and focus returns
      for (let i = 0; i < 40; i++) await p.keyboard.press('Tab');
      assert.ok(await p.evaluate(() => !!document.activeElement.closest('.settings-modal')), 'focus stays inside Settings');
      await p.keyboard.press('Escape');
      await p.waitForSelector('.settings-modal', { state: 'detached' });
      await p.click('.help-btn'); await p.waitForSelector('.help-panel'); await audit('help');
      await p.keyboard.press('Escape'); await p.waitForSelector('.help-panel', { state: 'detached' });
      await ctx.close();
    }
  } finally { await browser.close(); }
  assert.deepEqual(problems, []);
});
