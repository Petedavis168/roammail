// Native push for the Roammail phone apps (mobile/): Android through Firebase Cloud Messaging (HTTP v1),
// iPhone straight through Apple Push Notification service (HTTP/2, token auth). No SDKs: both are signed JWTs.
//
// Settings (all optional; without them the apps work, just without notifications):
//   FCM_SERVICE_ACCOUNT   the Firebase service-account JSON (raw or base64)          -> Android
//   APNS_KEY              the .p8 key from developer.apple.com (raw PEM or base64)     -> iPhone
//   APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC (default net.roammail.app), APNS_SANDBOX=true for development builds
import crypto from 'node:crypto';
import http2 from 'node:http2';
import express from 'express';
import { rateLimit } from './shared.js';

const env = process.env;
const dev = env.NODE_ENV !== 'production';
const b64url = (b) => Buffer.from(b).toString('base64url');
const maybeB64 = (v) => { const s = String(v || '').trim(); return !s || s.startsWith('{') || s.startsWith('-----') ? s : Buffer.from(s, 'base64').toString('utf8'); };

function jwt(header, claims, key, alg) {
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = alg === 'ES256' ? crypto.sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }) : crypto.sign('sha256', Buffer.from(data), key);
  return `${data}.${b64url(sig)}`;
}

// ---------------------------------------------------------------- Android (FCM)
let fcmAccount;
const fcm = () => {
  if (fcmAccount === undefined) { try { fcmAccount = JSON.parse(maybeB64(env.FCM_SERVICE_ACCOUNT)) || null; } catch { fcmAccount = null; } }
  return fcmAccount?.private_key && fcmAccount?.client_email && fcmAccount?.project_id ? fcmAccount : null;
};
let fcmToken = null;
async function fcmAccess() {
  if (fcmToken && fcmToken.exp > Date.now() + 60e3) return fcmToken.value;
  const a = fcm(); const now = Math.floor(Date.now() / 1000);
  const tokenUrl = (dev && env.FCM_TOKEN_URL) || 'https://oauth2.googleapis.com/token';
  const assertion = jwt({ alg: 'RS256', typ: 'JWT' }, { iss: a.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }, a.private_key, 'RS256');
  const r = await fetch(tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error(`FCM auth failed (${r.status})`);
  fcmToken = { value: d.access_token, exp: Date.now() + Number(d.expires_in || 3600) * 1000 };
  return fcmToken.value;
}
export async function sendFcm(token, p) {
  const a = fcm(); if (!a) return { ok: false, off: true };
  const base = (dev && env.FCM_API_BASE) || 'https://fcm.googleapis.com';
  const r = await fetch(`${base}/v1/projects/${encodeURIComponent(a.project_id)}/messages:send`, {
    method: 'POST', headers: { Authorization: `Bearer ${await fcmAccess()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { token, notification: { title: p.title, body: p.body }, data: { url: String(p.url || '/app') },
      android: { priority: 'high', ttl: '3600s', notification: { tag: p.tag, channel_id: 'mail' } } } }),
  });
  if (r.ok) return { ok: true };
  const d = await r.json().catch(() => ({}));
  const code = d.error?.details?.find?.((x) => x.errorCode)?.errorCode || d.error?.status;
  return { ok: false, gone: r.status === 404 || code === 'UNREGISTERED' || code === 'INVALID_ARGUMENT' };
}

// ---------------------------------------------------------------- iPhone (APNs)
const apnsKey = () => (env.APNS_KEY && env.APNS_KEY_ID && env.APNS_TEAM_ID ? maybeB64(env.APNS_KEY) : null);
let apnsJwt = null; let apnsSession = null;
function apnsAuth() {
  if (apnsJwt && apnsJwt.at > Date.now() - 40 * 60e3) return apnsJwt.value; // Apple wants a new token every 20-60 minutes
  apnsJwt = { at: Date.now(), value: jwt({ alg: 'ES256', kid: env.APNS_KEY_ID }, { iss: env.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) }, apnsKey(), 'ES256') };
  return apnsJwt.value;
}
function apnsConnection() {
  const host = (dev && env.APNS_HOST) || (env.APNS_SANDBOX === 'true' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com');
  if (!apnsSession || apnsSession.closed || apnsSession.destroyed) {
    apnsSession = http2.connect(host);
    apnsSession.on('error', () => { apnsSession = null; });
    apnsSession.unref?.();
  }
  return apnsSession;
}
export function sendApns(token, p) {
  if (!apnsKey()) return Promise.resolve({ ok: false, off: true });
  if (!/^[0-9a-f]{32,200}$/i.test(token)) return Promise.resolve({ ok: false, gone: true });
  const body = JSON.stringify({ aps: { alert: { title: p.title, body: p.body }, sound: 'default', 'thread-id': p.thread || 'mail' }, url: String(p.url || '/app') });
  return new Promise((resolve) => {
    let req;
    try {
      req = apnsConnection().request({ ':method': 'POST', ':path': `/3/device/${token}`, authorization: `bearer ${apnsAuth()}`,
        'apns-topic': env.APNS_TOPIC || 'net.roammail.app', 'apns-push-type': 'alert', 'apns-priority': '10', 'apns-expiration': String(Math.floor(Date.now() / 1000) + 3600),
        ...(p.tag ? { 'apns-collapse-id': String(p.tag).slice(0, 64) } : {}), 'content-type': 'application/json' });
    } catch { return resolve({ ok: false }); }
    let status = 0; let data = '';
    req.setTimeout(10000, () => req.close());
    req.on('response', (h) => { status = h[':status']; });
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      let reason = ''; try { reason = JSON.parse(data || '{}').reason || ''; } catch { /* empty */ }
      resolve({ ok: status === 200, gone: status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered' });
    });
    req.on('error', () => resolve({ ok: false }));
    req.end(body);
  });
}

export const nativePushConfig = () => ({ android: !!fcm(), ios: !!apnsKey() });
/** endpoint is stored as "fcm:<token>" or "apns:<token>" in push_subs */
export function sendNative(endpoint, payload) {
  if (endpoint.startsWith('fcm:')) return sendFcm(endpoint.slice(4), payload);
  if (endpoint.startsWith('apns:')) return sendApns(endpoint.slice(5), payload);
  return Promise.resolve({ ok: false, gone: true });
}

// ---------------------------------------------------------------- app links
// Lets roammail.net links open in the phone apps. Served on every host (roammail.net and login.roammail.net).
//   ANDROID_CERT_SHA256  the SHA-256 fingerprint(s) from Play Console > App integrity (comma-separated)
//   APPLE_TEAM_ID        the 10-character Apple team ID (APNS_TEAM_ID is used if not set)
export const appLinks = express.Router();
appLinks.use('/.well-known', rateLimit({ windowMs: 60 * 1000, limit: 120 }));
appLinks.use('/apple-app-site-association', rateLimit({ windowMs: 60 * 1000, limit: 120 }));
const APP_ID = () => env.MOBILE_APP_ID || 'net.roammail.app';
appLinks.get('/.well-known/assetlinks.json', (req, res) => {
  const prints = String(env.ANDROID_CERT_SHA256 || '').split(',').map((x) => x.trim().toUpperCase()).filter((x) => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(x));
  res.set('Cache-Control', 'public, max-age=3600').json(prints.length ? [{ relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: APP_ID(), sha256_cert_fingerprints: prints } }] : []);
});
appLinks.get(['/.well-known/apple-app-site-association', '/apple-app-site-association'], (req, res) => {
  const team = String(env.APPLE_TEAM_ID || env.APNS_TEAM_ID || '').trim();
  res.set('Cache-Control', 'public, max-age=3600').type('application/json').send(JSON.stringify(/^[A-Z0-9]{10}$/.test(team)
    ? { applinks: { details: [{ appIDs: [`${team}.${APP_ID()}`], components: [{ '/': '/api/*', exclude: true }, { '/': '/*' }] }] } }
    : { applinks: { details: [] } }));
});
/** Close the APNs connection (shutdown and tests). */
export function closeNativePush() { if (apnsSession) { apnsSession.close(); apnsSession = null; } }
