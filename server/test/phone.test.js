// SMS phone verification for free sign-ups (5b). Needs an app instance with Twilio settings pointing at the mock:
//   PORT=3004 TWILIO_ACCOUNT_SID=AC1 TWILIO_AUTH_TOKEN=x TWILIO_VERIFY_SID=VA1 TWILIO_API_BASE=http://127.0.0.1:8097 node --env-file=dev/test.env src/index.js
//   PHONE_BASE=http://localhost:3004 node --test test/phone.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const BASE = process.env.PHONE_BASE;
const PW = 'Tq9-vLm2-Zx81';
const run = crypto.randomBytes(3).toString('hex');
const ip = () => `198.19.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`;
const post = async (path, body, from = ip()) => {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mailcow-client', 'X-Forwarded-For': from }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => null) };
};

test('free sign-up needs a verified mobile number; one free account per number', { skip: !BASE && 'set PHONE_BASE' }, async () => {
  const cfg = await (await fetch(`${BASE}/api/signup/config`)).json();
  assert.equal(cfg.phoneRequired, true);
  const phone = `+1555${crypto.randomInt(1000000, 9999998)}`;
  assert.equal((await post('/api/signup', { name: 'P', username: `ph${run}`, password: PW, acceptTerms: true, birthday: '1990-01-15', recoveryEmail: 'recovery@example.org', phone: '+15555550123' })).status, 400, 'no phone, no account');
  assert.equal((await post('/api/signup/phone/start', { phone: '555-1234' })).status, 400, 'needs a country code');
  assert.equal((await post('/api/signup/phone/start', { phone: '+15550009999' })).status, 400, 'landline');
  assert.equal((await post('/api/signup/phone/start', { phone })).status, 200);
  assert.equal((await post('/api/signup/phone/check', { phone, code: '000000' })).status, 400);
  const ok = await post('/api/signup/phone/check', { phone, code: '123456' });
  assert.equal(ok.status, 200); assert.ok(ok.data.token);
  const s = await post('/api/signup', { name: 'P', username: `ph${run}`, password: PW, acceptTerms: true, birthday: '1990-01-15', recoveryEmail: 'recovery@example.org', phone: '+15555550123', phoneToken: ok.data.token });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  // the same number can't start another free account
  assert.equal((await post('/api/signup/phone/start', { phone })).status, 409);
  assert.equal((await post('/api/signup', { name: 'Q', username: `pq${run}`, password: PW, acceptTerms: true, birthday: '1990-01-15', recoveryEmail: 'recovery@example.org', phone: '+15555550123', phoneToken: ok.data.token })).status, 409, 'token reused');
  assert.equal((await post('/api/signup', { name: 'Q', username: `pr${run}`, password: PW, acceptTerms: true, birthday: '1990-01-15', recoveryEmail: 'recovery@example.org', phone: '+15555550123', phoneToken: 'forged' })).status, 400);
});
