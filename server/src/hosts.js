// Host routing and page URLs.
//   roammail.net               landing page + sign-up; the app lives at roammail.net/{mailboxId}/inbox etc.
//   login.roammail.net         sign-in, forgot password, recovery (then back to roammail.net/{id}/inbox)
//   admin.roammail.net         the admin dashboard (business admins and super-admins); sign-in first if needed
//   www. / app.roammail.net    301 to roammail.net, same path
// With no ROOT_DOMAIN (development) everything is served from one host and sign-in lives at /login.
import express from 'express';
import path from 'node:path';
import { config } from './config.js';
import { resolveMailboxId, ensureMailboxId, ID_RE } from './mailboxids.js';
import { browserMailboxes } from './session.js';
import { q } from './db.js';
import { counter, rateLimit } from './shared.js';

const root = () => config.rootDomain;
export const loginUrl = (path = '/') => (config.loginHost ? `https://${config.loginHost}${path}` : `/login${path === '/' ? '' : path.replace(/^\/(?=\?)/, '')}`);
export const appUrl = (path = '/') => (root() ? `https://${root()}${path}` : path);

// Section names allowed under /{id}/
const SECTIONS = /^\/(inbox|sent|drafts|spam|trash|archive|calendar|contacts|settings|scheduled|quarantine|all|snoozed|search|admin(\/[a-z-]+)?|folder\/[^/]{1,300}|message\/[A-Za-z0-9_.-]{1,400})\/?$/;
const ID_PATH = /^\/(\d{8}|\d{6}-\d{3}-[A-Z]{2})(\/.*)?$/;

const notFound = (res) => res.status(404).type('html').set('Cache-Control', 'no-store').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found</title>
<body style="font-family:Segoe UI,Arial,sans-serif;text-align:center;padding:18vh 20px;color:#242424"><img src="/roammail-mark.png" alt="" height="48"><h1>Page not found</h1>
<p>This page doesn't exist, or you're not signed in to it.</p><p><a href="${loginUrl('/')}">Sign in</a> · <a href="${appUrl('/')}">${config.appName} home</a></p></body>`);

async function canOpen(emails, target) {
  if (emails.includes(target)) return true;
  for (const e of emails) if (await q.get('SELECT 1 FROM shared_access WHERE mailbox = ? AND member = ?', target, e)) return true;
  return false;
}

export const hosts = express.Router();

hosts.use((req, res, next) => {
  if (!root()) return next();
  const h = String(req.hostname || '').toLowerCase();
  if (h === `www.${root()}` || h === `app.${root()}`) return res.redirect(301, `https://${root()}${req.originalUrl}`);
  // The sign-in host only serves sign-in pages; mailbox URLs belong on the root
  if (h === config.loginHost && ID_PATH.test(req.path)) return res.redirect(302, `https://${root()}${req.originalUrl}`);
  // The admin host only shows the admin dashboard; mail pages belong on the root
  if (config.adminHost && h === config.adminHost) {
    const m = ID_PATH.exec(req.path);
    if (m && !/^\/admin(\/|$)/.test(m[2] || '')) return res.redirect(302, `https://${root()}${req.originalUrl}`);
  }
  next();
});
// admin.roammail.net: straight to the dashboard of the first signed-in account, or sign in first and come back
const ADMIN_NEXT = 'rm_next';
hosts.get('/', async (req, res, next) => {
  if (!config.adminHost || String(req.hostname || '').toLowerCase() !== config.adminHost) return next();
  const emails = await browserMailboxes(req);
  if (!emails.length) {
    res.cookie(ADMIN_NEXT, 'admin', { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/', maxAge: 30 * 60e3, ...(config.cookieDomain ? { domain: config.cookieDomain } : {}) });
    return res.redirect(302, loginUrl('/'));
  }
  return res.redirect(302, `/${await ensureMailboxId(emails[0])}/admin`);
});
/** After signing in: back to the admin dashboard if that's where they started. */
export function afterLoginUrl(req, res, mailboxId, fallback) {
  if (req.cookies?.[ADMIN_NEXT] !== 'admin' || !config.adminHost) return fallback;
  res.clearCookie(ADMIN_NEXT, { path: '/', ...(config.cookieDomain ? { domain: config.cookieDomain } : {}) });
  return `https://${config.adminHost}/${mailboxId}/admin`;
}

// Sign-in page while already signed in (and not adding another account): straight to the inbox.
hosts.get(['/', '/login'], async (req, res, next) => {
  const h = String(req.hostname || '').toLowerCase();
  const onLogin = config.loginHost ? h === config.loginHost : req.path === '/login';
  if (!onLogin || req.query.add || req.query.reset) return next();
  const emails = await browserMailboxes(req);
  if (!emails.length) return next();
  return res.redirect(302, appUrl(`/${await ensureMailboxId(emails[0])}/inbox`));
});
// Installed app (PWA start_url): the first signed-in mailbox, or sign-in
const appLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });
hosts.get('/app', appLimiter, async (req, res) => {
  const emails = await browserMailboxes(req);
  if (!emails.length) return res.redirect(302, loginUrl('/'));
  const imp = /^[a-z-]{1,20}$/.test(String(req.query.import || '')) ? String(req.query.import) : '';
  const section = imp ? 'settings' : ['calendar', 'contacts'].includes(req.query.view) ? req.query.view : 'inbox';
  const qs = imp ? `?import=${imp}` : req.query.share === '1' ? '?share=1' : req.query.compose === '1' ? `?compose=1${/^mailto:[^\s]{1,2000}$/i.test(String(req.query.mailto || '')) ? `&mailto=${encodeURIComponent(String(req.query.mailto))}` : ''}` : ['tasks', 'notes', 'followups'].includes(req.query.panel) ? `?panel=${req.query.panel}` : '';
  return res.redirect(302, appUrl(`/${await ensureMailboxId(emails[0])}/${section}${qs}`));
});
// Shared from another app before the app's offline helper was installed: just open a new email
hosts.post('/share-target', (req, res) => res.redirect(303, '/app?compose=1'));
// Sign-up lives on the sign-in host: roammail.net/signup -> login.roammail.net/signup (query kept)
hosts.get('/signup', (req, res, next) => {
  if (config.loginHost && String(req.hostname || '').toLowerCase() !== config.loginHost) {
    return res.redirect(301, `https://${config.loginHost}${req.originalUrl}`);
  }
  next();
});

// /{mailboxId}/... : resolve the ID on the server; only a signed-in owner or a delegate gets the page, everyone else 404.
hosts.get(ID_PATH, async (req, res, next) => {
  if (root() && String(req.hostname || '').toLowerCase() !== root()) return next();
  const [, id, rest = ''] = ID_PATH.exec(req.path);
  const emails = await browserMailboxes(req);
  if (!emails.length) return res.redirect(302, loginUrl('/')); // never echo the ID or an address to the sign-in page
  const r = await resolveMailboxId(id);
  if (!r || !(await canOpen(emails, r.email))) {
    if (await counter.hit(`idmiss:${req.ip}`, 10 * 60 * 1000) > 30) return res.status(429).type('text').send('Too many requests');
    return notFound(res);
  }
  const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  if (!r.active) return res.redirect(301, `/${r.current}${rest}${qs}`); // initials changed: old link keeps working
  if (!rest || rest === '/') return res.redirect(302, `/${id}/inbox`);
  if (!SECTIONS.test(rest)) return notFound(res);
  res.set('Cache-Control', 'no-store');
  next(); // the web app's index.html
});

export { ID_RE, ID_PATH, notFound };

// ---------------------------------------------------------------- the public website
const SITE_PAGES = ['index', 'terms', 'privacy', 'cookies', 'acceptable-use', 'accessibility', 'legal', 'brand', 'roammail-vs-gmail', 'roammail-vs-outlook', 'move-from-gmail', 'move-from-outlook'];
const SITE_FILES = /^\/(style\.css|app\.js|pricing\.js|comparison\.js|setup\.js|privacy-controls\.js|sitemap\.xml)$/;
export function siteRouter(dir) {
  const r = express.Router();
  // Logos are used by the sign-in pages and the app too, so /assets is served on every host
  r.use('/assets', express.static(path.join(dir, 'assets'), { maxAge: '7d', fallthrough: false }));
  const onSite = (req) => !config.rootDomain || String(req.hostname || '').toLowerCase() === config.rootDomain;
  r.get('/get-started.html', (req, res, next) => {
    if (!onSite(req)) return next();
    const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    res.redirect(301, config.loginHost ? `https://${config.loginHost}/signup${qs}` : `/signup${qs}`);
  });
  r.get(/^\/([a-z-]+)?(\.html)?$/, (req, res, next) => {
    if (!onSite(req)) return next();
    const name = (req.params[0] || 'index');
    if (!SITE_PAGES.includes(name)) return next();
    if (!req.params[0] && req.path !== '/') return next();
    res.set('Cache-Control', 'public, max-age=600');
    res.sendFile(path.join(dir, `${name}.html`));
  });
  r.get(SITE_FILES, (req, res, next) => (onSite(req) ? res.set('Cache-Control', 'public, max-age=600').sendFile(path.join(dir, req.path.slice(1))) : next()));
  return r;
}
