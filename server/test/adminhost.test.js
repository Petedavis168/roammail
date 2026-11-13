// admin.roammail.net: the admin dashboard on its own address. Not signed in: sign in first, then straight back to
// the dashboard. Signed in: straight to the dashboard. Mail pages on that address go to the main site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN = process.env.ADMIN_HOST || 'admin.roammail.test';
const PW = 'Tq9-vLm2-Zx81';
/** A request as if sent to the admin address (fetch can't set Host). */
const onAdmin = (path, cookie = '') => new Promise((resolve, reject) => {
  const u = new URL(BASE);
  http.get({ host: u.hostname, port: u.port, path, headers: { Host: ADMIN, ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
    let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, cookies: res.headers['set-cookie'] || [], body }));
  }).on('error', reject);
});

test('admin.roammail.net opens the admin dashboard, signing in first if needed', async () => {
  // not signed in: to sign-in, remembering where to come back to
  let r = await onAdmin('/');
  assert.equal(r.status, 302); assert.match(r.location, /\/login/);
  const next = r.cookies.find((c) => c.startsWith('rm_next=admin'));
  assert.ok(next, 'remembers to come back');
  assert.match((await onAdmin('/robots.txt')).body, /Disallow: \//);

  // sign in (with that reminder): back to the admin dashboard, and the reminder is cleared
  const ip = `198.51.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`;
  const user = `ah${crypto.randomBytes(3).toString('hex')}`;
  const h = { 'X-Requested-With': 'mailcow-client', 'X-Forwarded-For': ip, 'Content-Type': 'application/json' };
  const su = await fetch(`${BASE}/api/signup`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'Admin Host', username: user, password: PW, acceptTerms: true, birthday: '1990-01-15', recoveryEmail: 'r@example.org', phone: '+15555550123', formMs: 60000 }) });
  assert.equal(su.status, 200);
  const email = (await su.json()).email;
  const login = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { ...h, Cookie: next.split(';')[0] }, body: JSON.stringify({ email, password: PW }) });
  const j = await login.json();
  assert.equal(j.redirect, `https://${ADMIN}/${j.mailboxId}/admin`);
  assert.ok(login.headers.getSetCookie().some((c) => /^rm_next=;/.test(c)), 'reminder cleared');
  const cookie = login.headers.getSetCookie().find((c) => c.startsWith('mc_session=')).split(';')[0];

  // without the reminder, sign-in goes to the inbox as usual
  const plain = await (await fetch(`${BASE}/api/login`, { method: 'POST', headers: h, body: JSON.stringify({ email, password: PW }) })).json();
  assert.match(plain.redirect, /\/inbox$/);

  // signed in: / goes to the dashboard; the dashboard page loads; mail pages go to the main site
  r = await onAdmin('/', cookie);
  assert.equal(r.status, 302); assert.equal(r.location, `/${j.mailboxId}/admin`);
  r = await onAdmin(`/${j.mailboxId}/admin`, cookie);
  assert.equal(r.status, 200); assert.match(r.body, /<div id="root">|app-assets/);
});
