// Web push: subscribe, get a notification when mail arrives, signing out everywhere stops it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const PW = 'Tq9-vLm2-Zx81';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = `198.18.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 254)}`;
let cookie = '';
const call = async (method, path, body) => {
  const res = await fetch(BASE + path, { method, headers: { 'X-Requested-With': 'mailcow-client', 'X-Forwarded-For': ip, ...(cookie ? { Cookie: cookie } : {}), ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
  for (const c of res.headers.getSetCookie?.() || []) if (c.startsWith('mc_session=')) cookie = c.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => null) };
};

test('push: new mail triggers an encrypted web push; sign-out everywhere stops it', async () => {
  const received = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
  const server = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (req, res) => { let b = []; req.on('data', (c) => b.push(c)); req.on('end', () => { received.push({ headers: req.headers, body: Buffer.concat(b) }); res.writeHead(201); res.end(); }); });
  await new Promise((r) => server.listen(12999, '127.0.0.1', r));
  try {
    const s = await call('POST', '/api/signup', { name: 'Pusher', username: `push${Date.now() % 1e6}`, password: PW, acceptTerms: true });
    assert.equal(s.status, 200);
    await call('POST', '/api/setup/2fa/remind', {}); await call('POST', '/api/setup/step', { step: 'done' });
    await sleep(1300);
    const { publicKey } = (await call('GET', '/api/push/key')).data;
    assert.ok(publicKey.length > 80);
    const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
    const subscription = { endpoint: 'https://127.0.0.1:12999/push/abc', keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
    assert.equal((await call('POST', '/api/push/subscribe', { subscription: { ...subscription, endpoint: 'http://evil.example/x' } })).status, 400, 'only https push services');
    assert.equal((await call('POST', '/api/push/subscribe', { subscription })).status, 200);
    await sleep(5000); // worker starts watching
    const fd = new FormData(); fd.append('to', s.data.email); fd.append('subject', 'Ping'); fd.append('text', 'hello');
    assert.equal((await call('POST', '/api/send', fd)).status, 200);
    for (let i = 0; i < 20 && !received.length; i++) await sleep(500);
    assert.ok(received.length >= 1, 'push delivered');
    const p = received[0];
    assert.equal(p.headers['content-encoding'], 'aes128gcm', 'payload encrypted end to end');
    assert.match(p.headers.authorization, /^vapid t=.+, k=/);
    assert.ok(!p.body.toString('latin1').includes('Ping'), 'subject not readable by the push service');

    assert.equal((await call('POST', '/api/security/signout-all', { password: PW })).status, 200);
    await sleep(3000);
    const before = received.length;
    const fd2 = new FormData(); fd2.append('to', s.data.email); fd2.append('subject', 'Ping 2'); fd2.append('text', 'x');
    await call('POST', '/api/send', fd2);
    await sleep(4000);
    assert.equal(received.length, before, 'no more pushes after signing out everywhere');
  } finally { server.close(); }
});
