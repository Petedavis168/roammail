// Two app servers sharing PostgreSQL + Redis (as behind a load balancer). Start server A with dev/start-stack.sh
// (REDIS_URL + PG_ADMIN_URL set) and server B on another port with the same DATABASE_URL and REDIS_URL, then:
//   BASE_A=http://localhost:3000 BASE_B=http://localhost:3002 node --test test/multiserver.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const A = process.env.BASE_A || 'http://localhost:3000';
const B = process.env.BASE_B || 'http://localhost:3002';
const PW = 'Tq9-vLm2-Zx81';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = `198.18.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`;
const H = { 'X-Requested-With': 'mailcow-client', 'Content-Type': 'application/json', 'X-Forwarded-For': ip };
const call = async (base, method, path, body, cookie) => {
  const res = await fetch(base + path, { method, headers: { ...H, ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const c = (res.headers.getSetCookie?.() || []).find((x) => x.startsWith('mc_session='));
  return { status: res.status, data: await res.json().catch(() => null), cookie: c ? c.split(';')[0] : cookie };
};

test('a session made on one server works on the other', async () => {
  const s = await call(A, 'POST', '/api/signup', { name: 'Multi', username: `ms${Date.now() % 1e6}`, password: PW, acceptTerms: true, birthday: '1990-01-15', recoveryEmail: 'recovery@example.org', phone: '+15555550123' });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  await call(A, 'POST', '/api/setup/2fa/remind', {}, s.cookie); await call(A, 'POST', '/api/setup/step', { step: 'done' }, s.cookie);
  await sleep(1500);
  const me = await call(B, 'GET', '/api/me', null, s.cookie);
  assert.equal(me.status, 200);
  assert.equal(me.data.email, s.data.email);

  const other = await call(B, 'POST', '/api/login', { email: s.data.email, password: PW }); // a second device, via server B
  assert.equal((await call(B, 'GET', '/api/me', null, other.cookie)).status, 200);
  // sign-out everywhere on A ends the live connection held by server B
  const res = await fetch(`${B}/api/events`, { headers: { Cookie: s.cookie, 'X-Forwarded-For': ip } });
  const reader = res.body.getReader(); let text = '';
  const read = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); if (text.includes('reconnect')) break; } })();
  await sleep(1000);
  assert.equal((await call(A, 'POST', '/api/security/signout-all', { password: PW }, s.cookie)).status, 200);
  await Promise.race([read, sleep(5000)]);
  assert.match(text, /event: reconnect/, 'server B dropped the live connection');
  assert.equal((await call(B, 'GET', '/api/me', null, other.cookie)).status, 401, 'the other device is signed out on server B too');
  assert.equal((await call(B, 'GET', '/api/me', null, s.cookie)).status, 200, 'the device that clicked it stays signed in');
});

test('sign-in throttling counts failures across servers', async () => {
  const email = `nobody${Date.now()}@free.test`;
  for (let i = 0; i < 5; i++) await call(A, 'POST', '/api/login', { email, password: 'wrong-password-1' });
  for (let i = 0; i < 5; i++) await call(B, 'POST', '/api/login', { email, password: 'wrong-password-1' });
  const r = await call(A, 'POST', '/api/login', { email, password: 'wrong-password-1' });
  assert.equal(r.status, 429, 'the 11th failure is blocked even though each server only saw some of them');
});
