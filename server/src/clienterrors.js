// Errors from people's browsers and the phone apps. They land in the server log as APP_ERROR lines, so the
// CloudWatch alarm "RoamMail - errors spiking in the app" (log metric filter on APP_ERROR) also covers the front end.
// Nothing personal is kept: message, file:line and page path (no query string), cut to a few hundred characters.
import express from 'express';
import { rateLimit } from './shared.js';

const clean = (v, n) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[^\x20-\x7e -￿]/g, '').slice(0, n);
const seen = new Map(); // same error from the same place: log once a minute

export const clientErrors = express.Router();
clientErrors.post('/client-error', rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }), (req, res) => {
  const b = req.body || {};
  const message = clean(b.message, 300);
  if (!message) return res.status(400).json({ error: 'message required' });
  const where = clean(b.source, 200).replace(/\?.*$/, '');
  const page = clean(b.page, 200).replace(/[?#].*$/, '').replace(/\/(message|folder)\/.*$/, '/$1/…'); // no message IDs or folder names
  const app = /^(web|android|ios)$/.test(b.app) ? b.app : 'web';
  const key = `${app}|${message}|${where}`;
  const now = Date.now();
  if ((seen.get(key) || 0) > now - 60e3) return res.status(204).end();
  seen.set(key, now);
  if (seen.size > 2000) for (const [k, t] of seen) if (t < now - 60e3) seen.delete(k);
  console.error(`APP_ERROR client ${app} ${message} at ${where} on ${page} v=${clean(b.version, 20)}`);
  res.status(204).end();
});
