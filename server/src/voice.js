// Voice notes: record a short message in the compose window; the email carries a link to a simple player page
// that works in any browser (no Roammail account needed). Kept for a year, then deleted. Up to 5 minutes.
import express from 'express';
import crypto from 'node:crypto';
import multer from 'multer';
import { q, audit } from './db.js';
import { requireAuth } from './session.js';
import { config } from './config.js';
import { rateLimit } from './shared.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const MAX_BYTES = 6 * 1024 * 1024;
const KEEP_MS = 365 * 864e5;
const TYPES = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac' };
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const baseUrl = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const ID_RE = /^[A-Za-z0-9_-]{22}$/;

/** Does the file start like an audio file of that type? (A renamed file can't sneak through.) */
function looksLikeAudio(b, mime) {
  if (!b || b.length < 12) return false;
  if (mime === 'audio/webm') return b.readUInt32BE(0) === 0x1a45dfa3;
  if (mime === 'audio/ogg') return b.subarray(0, 4).toString() === 'OggS';
  if (mime === 'audio/wav') return b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WAVE';
  if (mime === 'audio/mpeg') return b.subarray(0, 3).toString() === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0);
  if (mime === 'audio/aac') return b[0] === 0xff && (b[1] & 0xf0) === 0xf0;
  return b.subarray(4, 8).toString() === 'ftyp'; // mp4 / m4a
}

export const voiceApi = express.Router();
voiceApi.use('/voice', requireAuth);

voiceApi.post('/voice', rateLimit({ windowMs: 3600e3, limit: 60 }), upload.single('audio'), wrap(async (req, res) => {
  const f = req.file;
  const mime = String(f?.mimetype || '').split(';')[0].toLowerCase();
  if (!f || !TYPES[mime]) throw fail(400, 'Record a voice note first');
  if (!looksLikeAudio(f.buffer, mime)) throw fail(400, 'That recording didn’t come through properly. Try again.');
  const duration = Math.max(0, Math.min(5 * 60e3, Math.round(Number(req.body.durationMs) || 0)));
  const id = crypto.randomBytes(16).toString('base64url');
  await q.run('INSERT INTO voice_notes(id, owner, mime, data, duration_ms, created_at, expires_at) VALUES(?, ?, ?, ?, ?, ?, ?)', id, req.user.email, mime, f.buffer, duration, Date.now(), Date.now() + KEEP_MS);
  await audit(req.user.email, null, 'voice.upload', { id, size: f.buffer.length });
  res.json({ id, url: `${baseUrl(req)}/voice/${id}`, durationMs: duration });
}));

voiceApi.delete('/voice/:id', wrap(async (req, res) => {
  await q.run('DELETE FROM voice_notes WHERE id = ? AND owner = ?', String(req.params.id), req.user.email);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- the public player
export const voicePages = express.Router();
const fmtLen = (ms) => { const s = Math.round((ms || 0) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

voicePages.get('/voice/:id', wrap(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Robots-Tag', 'noindex'); res.setHeader('Referrer-Policy', 'no-referrer');
  const id = String(req.params.id);
  const row = ID_RE.test(id) ? await q.get('SELECT owner, duration_ms, created_at, expires_at FROM voice_notes WHERE id = ?', id) : null;
  const app = esc(config.appName || 'Roammail');
  const ok = row && Number(row.expires_at) > Date.now();
  const sender = ok ? (await q.get('SELECT name FROM profiles WHERE email = ?', row.owner).catch(() => null))?.name || row.owner : '';
  res.status(ok ? 200 : 404).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer">
<title>Voice message · ${app}</title><link rel="icon" href="/favicon.png"><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:linear-gradient(160deg,#eef2ff,#f8fafc);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a}
.card{background:#fff;border-radius:22px;box-shadow:0 20px 50px rgba(15,23,42,.12);padding:28px 26px;width:min(420px,92vw);text-align:center}
.mic{width:64px;height:64px;border-radius:20px;margin:0 auto 12px;display:grid;place-items:center;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;font-size:30px}
h1{font-size:19px;margin:0 0 4px}p{margin:0 0 16px;color:#64748b;font-size:14px}audio{width:100%}
footer{margin-top:16px;font-size:12px;color:#94a3b8}a{color:#2563eb}
@media (prefers-color-scheme:dark){body{background:#0b1220;color:#e2e8f0}.card{background:#111a2e;box-shadow:none}p{color:#94a3b8}}
</style></head><body><main class="card">
<div class="mic" aria-hidden="true">🎤</div>
${ok ? `<h1>Voice message from ${esc(sender)}</h1><p>${fmtLen(row.duration_ms)} · ${esc(new Date(Number(row.created_at)).toDateString())}</p>
<audio controls preload="metadata" src="/voice/${id}/audio"></audio>` : '<h1>This voice message isn’t available</h1><p>It may have been deleted or expired.</p>'}
<footer>Sent with <a href="/">${app}</a></footer></main></body></html>`);
}));

voicePages.get('/voice/:id/audio', wrap(async (req, res) => {
  const id = String(req.params.id);
  if (!ID_RE.test(id)) return res.status(404).end();
  const row = await q.get('SELECT mime, data, expires_at FROM voice_notes WHERE id = ?', id);
  if (!row || Number(row.expires_at) < Date.now()) return res.status(404).end();
  const buf = Buffer.from(row.data);
  res.setHeader('Content-Type', row.mime); res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=3600'); res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  // Safari asks for byte ranges before it will play audio
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m) {
    let start = m[1] === '' ? buf.length - Number(m[2]) : Number(m[1]);
    let end = m[1] !== '' && m[2] !== '' ? Number(m[2]) : buf.length - 1;
    start = Math.max(0, start); end = Math.min(end, buf.length - 1);
    if (start > end) { res.setHeader('Content-Range', `bytes */${buf.length}`); return res.status(416).end(); }
    res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${buf.length}`);
    return res.end(buf.subarray(start, end + 1));
  }
  if (!req.headers.range) q.run('UPDATE voice_notes SET plays = plays + 1 WHERE id = ?', id).catch(() => {});
  res.end(buf);
}));
// Expired notes are removed by the retention job, and all of them with the account (privacy.js)
