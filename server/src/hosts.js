// Host routing and page URLs.
//   roammail.net               landing page + sign-up; the app lives at roammail.net/{mailboxId}/inbox etc.
//   login.roammail.net         sign-in, forgot password, recovery (then back to roammail.net/{id}/inbox)
//   www. / app.roammail.net    301 to roammail.net, same path
// With no ROOT_DOMAIN (development) everything is served from one host and sign-in lives at /login.
import express from 'express';
import { config } from './config.js';
import { resolveMailboxId, ensureMailboxId, ID_RE } from './mailboxids.js';
import { browserMailboxes } from './session.js';
import { q } from './db.js';
import { counter } from './shared.js';

const root = () => config.rootDomain;
export const loginUrl = (path = '/') => (config.loginHost ? `https://${config.loginHost}${path}` : `/login${path === '/' ? '' : path.replace(/^\/(?=\?)/, '')}`);
export const appUrl = (path = '/') => (root() ? `https://${root()}${path}` : path);

// Section names allowed under /{id}/
const SECTIONS = /^\/(inbox|sent|drafts|spam|trash|archive|calendar|contacts|settings|scheduled|quarantine|snoozed|search|admin(\/[a-z-]+)?|folder\/[^/]{1,300}|message\/[A-Za-z0-9_.-]{1,400})\/?$/;
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
  next();
});

// "/" on the root: signed in -> your inbox; otherwise the landing page (served by the web app).
// "/" on the sign-in host: already signed in (and not adding another account) -> back to the inbox.
hosts.get(['/', '/login'], async (req, res, next) => {
  const h = String(req.hostname || '').toLowerCase();
  const onLogin = config.loginHost ? h === config.loginHost : req.path === '/login';
  if (onLogin && (req.query.add || req.query.reset)) return next();
  const emails = await browserMailboxes(req);
  if (!emails.length) return next();
  const id = await ensureMailboxId(emails[0]);
  if (onLogin || req.path === '/') return res.redirect(302, appUrl(`/${id}/inbox`));
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

export { ID_RE };
