// Native push for the phone apps: Firebase (Android) and APNs (iPhone) senders against local fakes, and the app-link files.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import http2 from 'node:http2';
import express from 'express';

const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const verifyJwt = (t, key, alg) => {
  const [h, c, s] = t.split('.');
  const ok = alg === 'ES256'
    ? crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))
    : crypto.verify('sha256', Buffer.from(`${h}.${c}`), key, Buffer.from(s, 'base64url'));
  return ok ? JSON.parse(Buffer.from(c, 'base64url')) : null;
};

// fake Google: token endpoint + FCM send
const fcmSeen = [];
const google = http.createServer((req, res) => {
  let b = ''; req.on('data', (x) => { b += x; }); req.on('end', () => {
    if (req.url === '/token') {
      const claims = verifyJwt(new URLSearchParams(b).get('assertion'), rsa.publicKey, 'RS256');
      res.writeHead(claims?.scope?.includes('firebase.messaging') ? 200 : 401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ access_token: 'goog-token', expires_in: 3600 }));
    }
    const m = JSON.parse(b).message;
    fcmSeen.push({ url: req.url, auth: req.headers.authorization, m });
    if (m.token === 'gone-token-xxxxxxxxxxxx') { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } })); }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"name":"x"}');
  });
});
// fake Apple (HTTP/2 cleartext)
const apnsSeen = [];
const apple = http2.createServer();
apple.on('stream', (stream, headers) => {
  let b = ''; stream.on('data', (x) => { b += x; }); stream.on('end', () => {
    apnsSeen.push({ headers, body: JSON.parse(b) });
    const gone = headers[':path'].endsWith('/dead');
    const bad = !verifyJwt(String(headers.authorization).replace('bearer ', ''), ec.publicKey, 'ES256');
    stream.respond({ ':status': bad ? 403 : gone ? 410 : 200 }); stream.end(gone ? '{"reason":"Unregistered"}' : '');
  });
});
await new Promise((r) => google.listen(0, '127.0.0.1', r));
await new Promise((r) => apple.listen(0, '127.0.0.1', r));
after(async () => { (await import('../src/nativepush.js')).closeNativePush(); google.closeAllConnections(); google.close(); apple.close(); setTimeout(() => process.exit(0), 200).unref(); });

Object.assign(process.env, {
  FCM_SERVICE_ACCOUNT: Buffer.from(JSON.stringify({ project_id: 'roam-test', client_email: 'push@roam-test.iam.gserviceaccount.com', private_key: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) })).toString('base64'),
  FCM_TOKEN_URL: `http://127.0.0.1:${google.address().port}/token`, FCM_API_BASE: `http://127.0.0.1:${google.address().port}`,
  APNS_KEY: ec.privateKey.export({ type: 'pkcs8', format: 'pem' }), APNS_KEY_ID: 'ABC123DEFG', APNS_TEAM_ID: 'TEAM123456',
  APNS_HOST: `http://127.0.0.1:${apple.address().port}`,
  ANDROID_CERT_SHA256: Array(32).fill('AB').join(':'), APPLE_TEAM_ID: 'TEAM123456',
});
const { sendNative, nativePushConfig, appLinks } = await import('../src/nativepush.js');
const payload = { title: 'Ann Lee', body: 'Lunch?', tag: 'mail-1', url: '/app' };

test('config reports both platforms', () => assert.deepEqual(nativePushConfig(), { android: true, ios: true }));

test('Android: signed OAuth, FCM v1 message, dead tokens reported', async () => {
  assert.deepEqual(await sendNative('fcm:good-token-xxxxxxxxxxxx', payload), { ok: true });
  const s = fcmSeen.at(-1);
  assert.equal(s.url, '/v1/projects/roam-test/messages:send');
  assert.equal(s.auth, 'Bearer goog-token');
  assert.equal(s.m.notification.title, 'Ann Lee'); assert.equal(s.m.data.url, '/app'); assert.equal(s.m.android.priority, 'high');
  assert.equal((await sendNative('fcm:gone-token-xxxxxxxxxxxx', payload)).gone, true);
});

test('iPhone: ES256 token auth to APNs, alert payload, 410 means gone', async () => {
  const tok = 'a'.repeat(64);
  assert.equal((await sendNative(`apns:${tok}`, payload)).ok, true);
  const s = apnsSeen.at(-1);
  assert.equal(s.headers[':path'], `/3/device/${tok}`);
  assert.equal(s.headers['apns-topic'], 'net.roammail.app');
  assert.equal(s.headers['apns-push-type'], 'alert');
  assert.equal(s.body.aps.alert.title, 'Ann Lee'); assert.equal(s.body.url, '/app');
  assert.equal((await sendNative('apns:not-hex', payload)).gone, true, 'malformed token never sent');
});

test('app-link files for Android and iOS', async () => {
  const app = express().use(appLinks);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const a = await (await fetch(`${base}/.well-known/assetlinks.json`)).json();
    assert.equal(a[0].target.package_name, 'net.roammail.app'); assert.equal(a[0].target.sha256_cert_fingerprints.length, 1);
    const r = await fetch(`${base}/.well-known/apple-app-site-association`);
    assert.match(r.headers.get('content-type'), /application\/json/);
    assert.deepEqual((await r.json()).applinks.details[0].appIDs, ['TEAM123456.net.roammail.app']);
  } finally { srv.close(); }
});
