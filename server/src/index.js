import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { api } from './routes.js';
import { publicAccounts, accounts } from './accounts.js';
import { publicSecurity, securityApi } from './security.js';
import { signatures, publicAssets } from './signatures.js';
import { mailtools } from './mailtools.js';
import { spam } from './spam.js';
import { startJobs } from './jobs.js';
import { deviceSetup, deviceSetupApi } from './devicesetup.js';
import { legalPages, privacy, startRetention } from './privacy.js';
import { calendar } from './calendar.js';
import { contacts } from './contacts.js';
import { groups } from './groups.js';

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
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
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
app.use(publicAssets);
app.use(deviceSetup);
app.use(legalPages);
app.use('/api', publicSecurity);
app.use('/api', publicAccounts);
app.use('/api', api);
app.use('/api', accounts);
app.use('/api', signatures);
app.use('/api', securityApi);
app.use('/api', mailtools);
app.use('/api', spam);
app.use('/api', deviceSetupApi);
app.use('/api', privacy);
app.use('/api', calendar);
app.use('/api', contacts);
app.use('/api', groups);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use('/api', (err, req, res, _next) => {
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : err.authenticationFailed ? 401 : 500);
  if (status >= 500) console.error(`APP_ERROR [${new Date().toISOString()}] ${req.method} ${req.path}`, err);
  // Never leak internals: only messages we created on purpose (status < 500) or from the mail server are shown
  const safe = status < 500 || err.responseText || /^mailcow:/.test(err.message || '') || err.code === 'EAUTH';
  res.status(status).json({ error: safe ? (err.responseText || err.message) : 'Something went wrong. Please try again.' });
});

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

startJobs();
startRetention();
app.listen(config.port, () => {
  console.log(`Mail client on http://localhost:${config.port}  (IMAP ${config.imap.host}:${config.imap.port}, SMTP ${config.smtp.host}:${config.smtp.port})`);
});
