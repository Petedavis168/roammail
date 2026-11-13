import express from 'express';
import helmet from 'helmet';
import { rateLimit } from './shared.js';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { api } from './routes.js';
import { sharedboxes } from './sharedboxes.js';
import { applyRetention, archive } from './archive.js';
import { push, startPush, pushStats, notify } from './push.js';
import { tasksApi, startReminders, setReminderNotifier } from './tasks.js';
import { importsApi, importsPublic, startImports, setImportNotifier } from './imports.js';
import { phoneApi } from './phone.js';
import { reputationApi, startReputationReport } from './reputation.js';
import { sendSystemMail } from './recovery.js';
import { help } from './help.js';
import { hosts, siteRouter, ID_PATH, notFound } from './hosts.js';
import { requireAuth } from './session.js';
import { setupApi, requireSetupApi } from './setup.js';
import { abuseDesk, outboundAdmin, startOutboundChecks } from './outbound.js';
import { startStatusRecorder, ops, metricsMiddleware, startMetricsLog, gauge, startDbBackups } from './ops.js';
import { q } from './db.js';
import { publicAccounts, accounts } from './accounts.js';
import { publicSecurity, securityApi } from './security.js';
import { signatures, publicAssets } from './signatures.js';
import { mailtools } from './mailtools.js';
import { spam } from './spam.js';
import { startJobs } from './jobs.js';
import { deviceSetup, deviceSetupApi } from './devicesetup.js';
import { legalPages, privacy, startRetention } from './privacy.js';
import { appLinks } from './nativepush.js';
import { clientErrors } from './clienterrors.js';
import { passkeysApi, passkeyLogin } from './passkeys.js';
import { ssoApi, ssoPublic } from './sso.js';
import { bookingApi, bookingPublic, bookingPages } from './booking.js';
import { subscriptionsApi } from './subscriptions.js';
import { nudgesApi } from './nudges.js';
import { screenerApi } from './screener.js';
import { voiceApi, voicePages } from './voice.js';
import { statusApi } from './status.js';
import { contactGroups } from './contactgroups.js';
import { catchupApi } from './catchup.js';
import { scamApi } from './scamguard.js';
import { referralsApi, startReferralRewards } from './referrals.js';
import { privacyReport } from './privacyreport.js';
import { studentApi } from './student.js';
import { chatAlertsApi } from './chatalerts.js';
import { endExpiredGifts } from './premium.js';
import { aliasesApi } from './aliases.js';
import { receiptsApi } from './receipts.js';
import { secureApi, securePublic, securePages } from './secure.js';
import { aiApi } from './ai.js';
import { premiumApi } from './premium.js';
import { calendar } from './calendar.js';
import { contacts } from './contacts.js';
import { groups } from './groups.js';
import { billing, billingWebhook } from './billing.js';
import { publicRecovery, recovery, processTwoFactorResets } from './recovery.js';

const app = express();
// Number of reverse proxies in front of the app (Caddy = 1). Wrong values let clients fake their IP.
app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1));
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:', 'http:'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      frameSrc: ["'self'", 'blob:', ...(config.turnstile.siteKey ? ['https://challenges.cloudflare.com'] : [])],
      scriptSrc: ["'self'", ...(config.turnstile.siteKey ? ['https://challenges.cloudflare.com'] : [])],
      connectSrc: ["'self'"],
      mediaSrc: ["'self'", 'blob:'], // voice notes (recording preview + playback)
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(metricsMiddleware);
app.use(billingWebhook); // Stripe → raw body, verified by signature
app.use(cookieParser());
app.use(express.json({ limit: '2mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=(), payment=(), usb=(), interest-cohort=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  next();
});
// Generous overall limit per IP to blunt scraping / brute force against any endpoint
app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 600, standardHeaders: true, legacyHeaders: false }));

// CSRF defence: state-changing API calls must carry a custom header
// (browsers can't add it cross-site without CORS, which we don't enable).
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.get('X-Requested-With') !== 'mailcow-client') {
    return res.status(403).json({ error: 'Missing CSRF header' });
  }
  next();
});
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use(appLinks); // before host routing: these must be served on every host, never redirected
app.use(bookingPages); // public booking pages, same on every host
app.use(securePages); // password-protected email page, same on every host
app.use(voicePages); // voice-note player page, same on every host
app.use(hosts);
app.use(ops);
app.use(abuseDesk);
app.use(help);
gauge('sessions_active', async () => (await q.get('SELECT COUNT(*) AS n FROM sessions')).n);
gauge('jobs_pending', async () => (await q.get("SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending'")).n);
// Background work must never crash the server; log it so the error alarm fires instead.
process.on('unhandledRejection', (e) => console.error('APP_ERROR unhandled', e));
startMetricsLog();
if (config.runsBackground) startDbBackups();
app.use(publicAssets);
app.use(deviceSetup);
app.use(legalPages);
app.use('/api', clientErrors); // browser and phone-app error reports (no sign-in needed)
app.use('/api', publicSecurity);
app.use('/api', passkeyLogin); // sign in with a passkey (no session yet)
app.use('/api', ssoPublic); // sign in with Microsoft / Google (no session yet)
app.use('/api', bookingPublic); // public booking pages: times, booking, cancel links (no sign-in)
app.use('/api', securePublic); // password-protected emails: open, attachments, reply (no sign-in)
app.use('/api', importsPublic); // Microsoft sign-in callback for imports (no session: sealed state)
app.use('/api', publicRecovery);
app.use('/api', requireSetupApi); // server tool may call with a signed request (no session)
app.use('/api/setup', requireAuth);
app.use('/api', setupApi);
app.use('/api', phoneApi);
app.use('/api', publicAccounts);
app.use('/api', api);
app.use('/api', accounts);
app.use('/api', signatures);
app.use('/api', securityApi);
app.use('/api', passkeysApi);
app.use('/api', ssoApi);
app.use('/api', bookingApi);
app.use('/api', subscriptionsApi);
app.use('/api', nudgesApi);
app.use('/api', screenerApi);
app.use('/api', voiceApi);
app.use('/api', statusApi);
app.use('/api', contactGroups);
app.use('/api', catchupApi);
app.use('/api', scamApi);
app.use('/api', referralsApi);
app.use('/api', privacyReport);
app.use('/api', studentApi);
app.use('/api', chatAlertsApi);
app.use('/api', aliasesApi);
app.use('/api', receiptsApi);
app.use('/api', secureApi);
app.use('/api', aiApi);
app.use('/api', premiumApi);
app.use('/api', mailtools);
app.use('/api', spam);
app.use('/api', deviceSetupApi);
app.use('/api', privacy);
app.use('/api', tasksApi);
app.use('/api', reputationApi);
app.use('/api', importsApi);
app.use('/api', calendar);
app.use('/api', contacts);
app.use('/api', groups);
app.use('/api', billing);
app.use('/api', recovery);
app.use('/api', sharedboxes);
app.use('/api', archive);
app.use('/api', push);
app.use('/api', outboundAdmin);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use('/api', (err, req, res, _next) => {
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : err.authenticationFailed ? 401 : 500);
  if (status >= 500 && err.expose !== true) console.error('APP_ERROR [%s] %s %s', new Date().toISOString(), req.method, String(req.path).replace(/[\r\n]/g, ''), err);
  // Never leak internals: only messages we created on purpose (status < 500) or from the mail server are shown
  const safe = status < 500 || err.expose === true || err.responseText || /^mailcow:/.test(err.message || '') || err.code === 'EAUTH';
  const code = (status < 500 || err.expose === true) && /^[a-z][a-z0-9_]*$/.test(String(err.code || '')) ? err.code : undefined; // our own codes only (ai_off, ...)
  res.status(status).json({ error: safe ? (err.responseText || err.message) : 'Something went wrong. Please try again.', ...(code ? { code } : {}) });
});

// Public marketing site (Pete's static site in /site): roammail.net/, its pages and /assets
const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../site');
if (fs.existsSync(site)) app.use(siteRouter(site));

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
// Polish: a real favicon.ico (the PNG inside an ICO wrapper) and robots.txt on every host
let favicon = null;
const staticLimiter = rateLimit({ windowMs: 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false });
app.get('/favicon.ico', staticLimiter, (req, res) => {
  if (!favicon) {
    const png = fs.readFileSync(path.join(dist, 'favicon.png'));
    const head = Buffer.alloc(22);
    head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4); // ICO, 1 image
    const w = png.readUInt32BE(16); const h = png.readUInt32BE(20);
    head.writeUInt8(w >= 256 ? 0 : w, 6); head.writeUInt8(h >= 256 ? 0 : h, 7);
    head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12); head.writeUInt32LE(png.length, 14); head.writeUInt32LE(22, 18);
    favicon = Buffer.concat([head, png]);
  }
  res.type('image/x-icon').set('Cache-Control', 'public, max-age=86400').send(favicon);
});
app.get('/robots.txt', staticLimiter, (req, res) => {
  const host = String(req.hostname || '').toLowerCase();
  const body = config.loginHost && host === config.loginHost
    ? 'User-agent: *\nAllow: /$\nAllow: /signup\nDisallow: /\n' // sign-in host: only the sign-in and sign-up pages
    : 'User-agent: *\nDisallow: /api/\nDisallow: /app\nDisallow: /help/contact\n'; // the website; mailbox pages need a sign-in anyway
  res.type('text/plain').set('Cache-Control', 'public, max-age=86400').send(body);
});
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  // Only real app pages get the app; anything else is a real 404 (no soft-404s for scanners and search engines)
  app.get(/^\/(?!api\/).*/, staticLimiter, (req, res) => {
    if (/^\/(login|signup)?\/?$/.test(req.path) || ID_PATH.test(req.path)) return res.sendFile(path.join(dist, 'index.html'));
    return notFound(res);
  });
}

startOutboundChecks();
startPush();
// Task reminders and follow-ups: a push to the person's devices; email if they have none
setReminderNotifier(async (email, n) => {
  if (await notify(email, { title: n.title, body: n.body, tag: `${n.kind}-${Date.now()}`, url: n.url })) return;
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  await sendSystemMail(email, n.title, `<p style="font-family:Segoe UI,Arial,sans-serif;font-size:14px">${esc(n.body)}</p><p><a href="${esc(config.publicUrl || '')}${n.url}">Open ${esc(config.appName)}</a></p>`);
});
startReminders();
setImportNotifier(async (email, n) => {
  if (await notify(email, { title: n.title, body: n.body, tag: `import-${Date.now()}`, url: n.url })) return;
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  await sendSystemMail(email, n.title, `<p style="font-family:Segoe UI,Arial,sans-serif;font-size:14px">${esc(n.body)}</p>`);
});
startImports();
startReputationReport();
gauge('push_watchers', () => pushStats().watching);
if (config.runsBackground) {
  await startJobs();
  await startRetention();
  startStatusRecorder(); // uptime history for the status page
  startReferralRewards(); // refer a friend: free months once the friend is a real, active user
  setInterval(() => applyRetention().catch((e) => console.error('APP_ERROR retention policy', e.message)), 24 * 3600e3).unref();
  setInterval(() => endExpiredGifts().catch((e) => console.error('APP_ERROR gifts', e.message)), 6 * 3600e3).unref();
  setInterval(() => processTwoFactorResets().catch((e) => console.error('APP_ERROR 2fa resets', e)), 10 * 60 * 1000).unref();
}
app.listen(config.port, () => {
  console.log(`Mail client on http://localhost:${config.port}  (IMAP ${config.imap.host}:${config.imap.port}, SMTP ${config.smtp.host}:${config.smtp.port})`);
});
