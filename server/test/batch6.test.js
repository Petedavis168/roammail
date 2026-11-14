// Batch 6: deep health check, sign-up drop-off counting, search pages and sitemap.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const h = { 'X-Requested-With': 'mailcow-client', 'Content-Type': 'application/json' };

test('deep health check tests the database', async () => {
  const r = await fetch(`${BASE}/healthz/deep`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.db, true); assert.equal(typeof j.dbMs, 'number'); assert.ok('receiving' in j.mail);
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('sign-up steps are counted (only known steps)', async () => {
  assert.equal((await fetch(`${BASE}/api/funnel`, { method: 'POST', headers: h, body: JSON.stringify({ step: 'signup_view' }) })).status, 204);
  assert.equal((await fetch(`${BASE}/api/funnel`, { method: 'POST', headers: h, body: JSON.stringify({ step: 'signup_done' }) })).status, 204, 'server-only steps are ignored, not an error');
  assert.equal((await fetch(`${BASE}/api/super/insights`)).status, 401);
});

test('comparison and moving pages, sitemap', async () => {
  for (const p of ['roammail-vs-gmail', 'roammail-vs-outlook', 'move-from-gmail', 'move-from-outlook']) {
    const r = await fetch(`${BASE}/${p}`);
    assert.equal(r.status, 200, p);
    const html = await r.text();
    assert.match(html, /<link rel="canonical" href="https:\/\/roammail\.net\//); assert.match(html, /<h1>/);
    assert.doesNotMatch(html, /\$\d/, 'no prices on these pages');
  }
  const sm = await (await fetch(`${BASE}/sitemap.xml`)).text();
  assert.match(sm, /move-from-gmail/);
  assert.match(await (await fetch(`${BASE}/robots.txt`)).text(), /Sitemap: https:\/\/roammail\.net\/sitemap\.xml/);
});
