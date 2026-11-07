// Moving in: import mail from Gmail, Outlook, Yahoo, AOL, iCloud or any IMAP account (punch list item 6).
//
//   App-password providers  -> a mailcow sync job (imapsync on the mail server, every 20 minutes, duplicates removed).
//   Outlook / Microsoft 365 -> Microsoft sign-in (OAuth2, when MS_CLIENT_ID/MS_CLIENT_SECRET are set). Microsoft no longer
//                              accepts app passwords for IMAP, so the app's worker copies the mail itself with XOAUTH2.
//   Anything else           -> upload an .mbox export (Google Takeout, Thunderbird, Apple Mail; Outlook .pst → .mbox).
// Every import keeps syncing new mail for 7 days so nothing is lost while people switch over, then stops by itself.
// Passwords are never stored by the app: app passwords go straight to mailcow; Microsoft tokens are sealed (AES-256-GCM).
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import readline from 'node:readline';
import multer from 'multer';
import { ImapFlow } from 'imapflow';
import { config } from './config.js';
import { q, audit } from './db.js';
import { requireAuth, seal, unseal } from './session.js';
import { mailcow } from './mailcow.js';
import { makeClient } from './imap.js';
import { assertPublicHost } from './abuse.js';
import { rateLimit } from './shared.js';
import { parseCsv, requireDomainAdmin } from './accounts.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status });
export const SYNC_DAYS = 7;
const dev = process.env.NODE_ENV !== 'production';
// Tests only: shorter sync window, and the local test mail server counts as an "old account"
const SYNC_MS = dev && process.env.IMPORT_SYNC_MS ? Number(process.env.IMPORT_SYNC_MS) : SYNC_DAYS * 864e5;
const checkHost = (host, port) => (dev && process.env.IMPORT_ALLOW_LOCAL === '1' ? Promise.resolve() : assertPublicHost(host, port));
const MAX_IMPORTS = 5;

export const PROVIDERS = {
  gmail: { label: 'Gmail', host: 'imap.gmail.com', port: 993, appPasswordUrl: 'https://myaccount.google.com/apppasswords',
    help: 'Turn on 2-Step Verification in your Google account, then create an App Password at myaccount.google.com/apppasswords and paste it here.' },
  outlook: { label: 'Outlook / Hotmail', host: 'outlook.office365.com', port: 993, oauth: true,
    help: 'Sign in with Microsoft to allow the import. If your organization blocks this, export your mail to a .pst or .mbox file and upload it below.' },
  yahoo: { label: 'Yahoo', host: 'imap.mail.yahoo.com', port: 993, appPasswordUrl: 'https://login.yahoo.com/account/security',
    help: 'In Yahoo Account Security choose "Generate app password", pick "Other app", and paste the password here.' },
  aol: { label: 'AOL', host: 'imap.aol.com', port: 993, appPasswordUrl: 'https://login.aol.com/account/security',
    help: 'In AOL Account Security choose "Generate app password", pick "Other app", and paste the password here.' },
  icloud: { label: 'iCloud', host: 'imap.mail.me.com', port: 993, appPasswordUrl: 'https://appleid.apple.com',
    help: 'Create an app-specific password at appleid.apple.com → Sign-In and Security.' },
  other: { label: 'Other (IMAP)', host: '', port: 993, help: 'Ask your provider for their IMAP server name. Use an app password if they offer one.' },
};
const SKIP_FOLDERS = /^(\[gmail\]\/)?(spam|junk|junk e-?mail|trash|bin|deleted( items| messages)?|all mail|important|starred)$/i;
const msOAuthEnabled = () => !!(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);

// ---------------------------------------------------------------- helpers
function remoteClient({ host, port, user, password, accessToken }) {
  return new ImapFlow({
    host, port, secure: Number(port) === 993, logger: false, emitLogs: false,
    auth: accessToken ? { user, accessToken } : { user, pass: password },
    tls: { rejectUnauthorized: dev ? config.tlsRejectUnauthorized : true },
    greetingTimeout: 15000, socketTimeout: 120000,
  });
}
/** One login to the old account: folders and message count, so people see what will be copied. */
async function probe(conn) {
  const c = remoteClient(conn);
  try { await c.connect(); } catch (e) {
    const msg = e.authenticationFailed || /auth|login|credential|password/i.test(`${e.responseText || ''} ${e.message}`)
      ? 'The old account rejected that email or app password. Check them and try again.'
      : `Couldn't reach ${conn.host}. Check the server name.`;
    throw fail(400, msg);
  }
  try {
    const folders = (await c.list()).filter((f) => !f.flags.has('\\Noselect') && !SKIP_FOLDERS.test(f.path) && !['\\Junk', '\\Trash', '\\All'].includes(f.specialUse));
    let messages = 0;
    for (const f of folders.slice(0, 200)) {
      try { messages += (await c.status(f.path, { messages: true })).messages || 0; } catch { /* unreadable folder */ }
    }
    return { folders: folders.length, messages };
  } finally { await c.logout().catch(() => {}); }
}
async function findSyncJobId(email, user1) {
  const jobs = await mailcow.listSyncJobs(email);
  return jobs.filter((j) => String(j.user1).toLowerCase() === user1.toLowerCase()).sort((a, b) => Number(b.id) - Number(a.id))[0]?.id || null;
}
const recordOut = (r, job) => ({
  id: r.id, kind: r.kind, provider: r.provider, label: PROVIDERS[r.provider]?.label || r.provider, user: r.remote_user, status: r.status,
  found: r.messages_found, copied: r.messages_copied, startedAt: r.created_at, stopsAt: r.stop_at, error: r.last_error || null,
  ...(job ? { running: Number(job.is_running) === 1, lastRun: job.last_run || null, success: job.success === null || job.success === undefined ? null : Number(job.success) === 1, active: Number(job.active) === 1 } : {}),
  readyToSwitch: r.status === 'active' && (r.kind === 'upload' || (job ? job.last_run && Number(job.success) === 1 : !!r.first_done_at)),
});
async function createSyncImport(email, { provider, host, port, user, password, by }) {
  if (Number((await q.get("SELECT COUNT(*) AS n FROM import_records WHERE email = ? AND status = 'active'", email)).n) >= MAX_IMPORTS) throw fail(400, `You can have up to ${MAX_IMPORTS} imports running`);
  const found = await probe({ host, port, user, password });
  await mailcow.addSyncJob(email, { host, port, user, password });
  const jobId = await findSyncJobId(email, user);
  const now = Date.now();
  const id = await q.insert(`INSERT INTO import_records(email, kind, provider, remote_user, remote_host, syncjob_id, status, messages_found, created_at, stop_at, created_by)
    VALUES(?, 'syncjob', ?, ?, ?, ?, 'active', ?, ?, ?, ?)`, email, provider, user, host, jobId, found.messages, now, now + SYNC_MS, by || email);
  await audit(by || email, null, 'import.add', { email, host, user, provider });
  return { id, ...found };
}

export const importsApi = express.Router();
importsApi.use(['/imports', '/admin/imports'], requireAuth);
const probeLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, keyGenerator: (req) => `imp:${req.user?.email || req.ip}` });

importsApi.get('/imports', wrap(async (req, res) => {
  const jobs = await mailcow.listSyncJobs(req.user.email).catch(() => []);
  const rows = await q.all('SELECT * FROM import_records WHERE email = ? ORDER BY id DESC LIMIT 20', req.user.email);
  const known = new Set(rows.map((r) => String(r.syncjob_id)));
  res.json({
    providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, { ...v, oauthReady: v.oauth ? msOAuthEnabled() : undefined }])),
    syncDays: SYNC_DAYS,
    imports: rows.map((r) => recordOut(r, jobs.find((j) => String(j.id) === String(r.syncjob_id)))),
    // sync jobs made before import tracking (or by the mail server admin)
    jobs: jobs.filter((j) => !known.has(String(j.id))).map((j) => ({ id: j.id, host: j.host1, user: j.user1, active: Number(j.active) === 1,
      running: Number(j.is_running) === 1, lastRun: j.last_run || null, success: j.success === null || j.success === undefined ? null : Number(j.success) === 1 })),
  });
}));

function connFrom(body) {
  const p = PROVIDERS[body.provider] || PROVIDERS.other;
  if (p.oauth) throw fail(400, 'Outlook uses Microsoft sign-in, not a password. Choose "Sign in with Microsoft".');
  const host = String(p.host || body.host || '').trim().toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) && !(dev && process.env.IMPORT_ALLOW_LOCAL === '1' && host === '127.0.0.1')) throw fail(400, 'Enter the IMAP server name');
  const user = String(body.user || '').trim();
  const password = String(body.password || '');
  if (!user || !password) throw fail(400, 'Enter the email address and app password of the old account');
  return { provider: PROVIDERS[body.provider] ? body.provider : 'other', host, port: Number(body.port || p.port || 993), user, password };
}

// Step 1: test the login and count what will be copied
importsApi.post('/imports/test', probeLimiter, wrap(async (req, res) => {
  const c = connFrom(req.body);
  await checkHost(c.host, c.port);
  res.json({ ok: true, ...(await probe(c)) });
}));
// Step 2: start (tests again, so a typo never creates a failing job)
importsApi.post('/imports', probeLimiter, wrap(async (req, res) => {
  if (req.delegatedMailbox) throw fail(403, 'Import into your own mailbox');
  const c = connFrom(req.body);
  await checkHost(c.host, c.port);
  res.json({ ok: true, ...(await createSyncImport(req.user.email, c)) });
}));
importsApi.patch('/imports', wrap(async (req, res) => {
  const r = await q.get('SELECT * FROM import_records WHERE id = ? AND email = ?', Number(req.body.recordId), req.user.email);
  const jobId = r ? r.syncjob_id : req.body.id;
  const j = (await mailcow.listSyncJobs(req.user.email)).find((x) => String(x.id) === String(jobId));
  if (!j && r?.kind !== 'oauth') throw fail(404, 'Import not found');
  if (j) await mailcow.editSyncJob(j.id, { active: req.body.active ? 1 : 0 });
  if (r) await q.run('UPDATE import_records SET status = ? WHERE id = ?', req.body.active ? 'active' : 'paused', r.id);
  res.json({ ok: true });
}));
importsApi.delete('/imports', wrap(async (req, res) => {
  const r = req.query.recordId ? await q.get('SELECT * FROM import_records WHERE id = ? AND email = ?', Number(req.query.recordId), req.user.email) : null;
  const jobId = r ? r.syncjob_id : req.query.id;
  const j = jobId ? (await mailcow.listSyncJobs(req.user.email)).find((x) => String(x.id) === String(jobId)) : null;
  if (!j && !r) throw fail(404, 'Import not found');
  if (j) await mailcow.deleteSyncJob(j.id);
  if (r) await q.run("UPDATE import_records SET status = 'stopped', creds = NULL WHERE id = ?", r.id);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- upload an .mbox file (any provider; Outlook .pst after converting)
const mboxUpload = multer({ storage: multer.diskStorage({ destination: os.tmpdir() }), limits: { fileSize: Number(process.env.IMPORT_UPLOAD_MB || 2048) * 1024 * 1024, files: 1 } });
/** Split an mbox file into messages ("From " separator lines, mboxrd un-escaping), calling onMessage(raw) for each. */
export async function readMbox(path, onMessage) {
  const rl = readline.createInterface({ input: fs.createReadStream(path), crlfDelay: Infinity });
  let cur = null; let count = 0;
  const flush = async () => { if (cur && cur.length) { count++; await onMessage(Buffer.from(cur.join('\r\n'), 'utf8')); } };
  for await (const line of rl) {
    if (/^From \S+.*\d{4}\s*$/.test(line) || (cur === null && line.startsWith('From '))) { await flush(); cur = []; continue; }
    if (cur === null) cur = [];
    cur.push(line.replace(/^>(>*From )/, '$1'));
  }
  await flush();
  return count;
}
importsApi.post('/imports/upload', rateLimit({ windowMs: 60 * 60 * 1000, limit: 10 }), requireAuth, mboxUpload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw fail(400, 'Choose an .mbox file');
  const folderName = `Imported/${String(req.body.folder || req.file.originalname.replace(/\.[^.]+$/, '') || 'Mail').replace(/[^\w .@-]/g, '').trim().slice(0, 60) || 'Mail'}`;
  const now = Date.now();
  const id = await q.insert(`INSERT INTO import_records(email, kind, provider, remote_user, status, messages_found, messages_copied, created_at, stop_at, created_by)
    VALUES(?, 'upload', 'file', ?, 'active', 0, 0, ?, ?, ?)`, req.user.email, req.file.originalname.slice(0, 200), now, now, req.user.email);
  // Copy in the background over a dedicated connection; the page shows progress
  const user = { email: req.user.email, password: req.user.password };
  const file = req.file.path;
  res.json({ ok: true, id, folder: folderName });
  (async () => {
    const c = makeClient(user);
    let copied = 0;
    try {
      await c.connect();
      try { await c.mailboxCreate(folderName); } catch { /* exists */ }
      await readMbox(file, async (raw) => {
        if (raw.length > 50 * 1024 * 1024) return; // skip absurd messages
        try { await c.append(folderName, raw, ['\\Seen']); copied++; } catch { /* malformed message: skip */ }
        if (copied % 50 === 0) await q.run('UPDATE import_records SET messages_copied = ?, messages_found = ? WHERE id = ?', copied, copied, id);
      });
      await q.run("UPDATE import_records SET messages_copied = ?, messages_found = ?, status = 'finished', first_done_at = ? WHERE id = ?", copied, copied, Date.now(), id);
      await audit(user.email, null, 'import.upload', { messages: copied });
    } catch (e) {
      await q.run("UPDATE import_records SET status = 'failed', last_error = ?, messages_copied = ? WHERE id = ?", String(e.message).slice(0, 300), copied, id);
    } finally {
      await c.logout().catch(() => {});
      fs.promises.unlink(file).catch(() => {});
    }
  })();
}));

// ---------------------------------------------------------------- Outlook / Microsoft 365 (OAuth2)
const MS_SCOPE = 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access openid email';
const msRedirect = () => `${config.publicUrl}/api/imports/outlook/callback`;
importsApi.get('/imports/outlook/start', wrap(async (req, res) => {
  if (!msOAuthEnabled()) throw fail(400, 'Microsoft sign-in is not set up on this server yet. Upload a .pst/.mbox export instead.');
  if (req.delegatedMailbox) throw fail(403, 'Import into your own mailbox');
  // state carries who is importing (sealed) and the session password, so the worker can write into the mailbox
  const state = seal({ email: req.user.email, password: req.user.password, n: crypto.randomBytes(8).toString('hex'), exp: Date.now() + 15 * 60e3 });
  const u = new URL('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  u.search = new URLSearchParams({ client_id: process.env.MS_CLIENT_ID, response_type: 'code', redirect_uri: msRedirect(), response_mode: 'query', scope: MS_SCOPE, state, prompt: 'select_account' }).toString();
  res.json({ url: u.toString() });
}));
async function msToken(params) {
  const r = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.MS_CLIENT_ID, client_secret: process.env.MS_CLIENT_SECRET, scope: MS_SCOPE, ...params }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error(d.error_description?.split('\r\n')[0] || 'Microsoft sign-in failed');
  return d;
}
const jwtEmail = (idToken) => { try { const p = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url')); return p.email || p.preferred_username || ''; } catch { return ''; } };
// Microsoft sends the browser back here (no app session cookie needed: the sealed state says who it is)
export const importsPublic = express.Router();
importsPublic.get('/imports/outlook/callback', rateLimit({ windowMs: 10 * 60e3, limit: 30 }), wrap(async (req, res) => {
  const st = unseal(String(req.query.state || ''));
  const back = (msg) => res.redirect(302, `/app?import=${encodeURIComponent(msg)}`);
  if (!st || st.exp < Date.now()) return back('expired');
  if (req.query.error || !req.query.code) return back('cancelled');
  try {
    const t = await msToken({ grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: msRedirect() });
    const remote = jwtEmail(t.id_token);
    if (!remote) return back('no-email');
    const found = await probe({ host: PROVIDERS.outlook.host, port: 993, user: remote, accessToken: t.access_token }).catch(() => ({ folders: 0, messages: 0 }));
    const now = Date.now();
    await q.insert(`INSERT INTO import_records(email, kind, provider, remote_user, remote_host, creds, state, status, messages_found, created_at, stop_at, created_by)
      VALUES(?, 'oauth', 'outlook', ?, ?, ?, '{}', 'active', ?, ?, ?, ?)`, st.email, remote, PROVIDERS.outlook.host,
    seal({ refresh: t.refresh_token, password: st.password, exp: now + (SYNC_DAYS + 1) * 864e5 }), found.messages, now, now + SYNC_MS, st.email);
    await audit(st.email, null, 'import.add', { provider: 'outlook', user: remote });
    return back('started');
  } catch { return back('failed'); }
}));

/** Copy new mail from one Outlook import (worker). Remembers the highest UID per folder, so each run only copies what's new. */
async function copyOAuthImport(r) {
  const c = unseal(r.creds);
  if (!c || c.exp < Date.now()) throw new Error('Sign-in expired. Start the import again.');
  const t = await msToken({ grant_type: 'refresh_token', refresh_token: c.refresh });
  if (t.refresh_token && t.refresh_token !== c.refresh) await q.run('UPDATE import_records SET creds = ? WHERE id = ?', seal({ ...c, refresh: t.refresh_token }), r.id);
  const state = JSON.parse(r.state || '{}');
  const src = remoteClient({ host: r.remote_host, port: 993, user: r.remote_user, accessToken: t.access_token });
  const dst = makeClient({ email: r.email, password: c.password });
  await src.connect(); await dst.connect();
  let copied = Number(r.messages_copied || 0);
  try {
    const dstFolders = new Set((await dst.list()).map((f) => f.path));
    for (const f of await src.list()) {
      if (f.flags.has('\\Noselect') || SKIP_FOLDERS.test(f.path) || ['\\Junk', '\\Trash', '\\All'].includes(f.specialUse)) continue;
      const target = f.path.toUpperCase() === 'INBOX' ? 'INBOX' : f.specialUse === '\\Sent' ? 'Sent' : f.specialUse === '\\Drafts' ? 'Drafts' : f.specialUse === '\\Archive' ? 'Archive' : `Imported/${f.path}`;
      if (!dstFolders.has(target)) { try { await dst.mailboxCreate(target); dstFolders.add(target); } catch { /* exists */ } }
      const lock = await src.getMailboxLock(f.path, { readOnly: true });
      try {
        const last = Number(state[f.path] || 0);
        if (!src.mailbox.exists) continue;
        for await (const m of src.fetch(`${last + 1}:*`, { uid: true, source: true, flags: true, internalDate: true }, { uid: true })) {
          if (m.uid <= last) continue; // "N:*" always returns the newest message
          await dst.append(target, m.source, [...(m.flags || [])].filter((x) => x !== '\\Recent'), m.internalDate);
          copied++; state[f.path] = m.uid;
          if (copied % 50 === 0) await q.run('UPDATE import_records SET messages_copied = ?, state = ? WHERE id = ?', copied, JSON.stringify(state), r.id);
        }
      } finally { lock.release(); }
    }
  } finally { await src.logout().catch(() => {}); await dst.logout().catch(() => {}); }
  await q.run('UPDATE import_records SET messages_copied = ?, state = ?, last_error = NULL, first_done_at = COALESCE(first_done_at, ?) WHERE id = ?', copied, JSON.stringify(state), Date.now(), r.id);
}

// ---------------------------------------------------------------- admin: bulk import from a CSV
// Columns: mailbox, provider, old email, app password[, imap server]. One sync job per row, each tested first.
importsApi.post('/admin/imports/bulk', rateLimit({ windowMs: 60 * 60 * 1000, limit: 10 }), wrap(async (req, res) => {
  const rows = parseCsv(String(req.body.csv || ''));
  if (!rows.length) throw fail(400, 'The file is empty');
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (names) => head.findIndex((h) => names.includes(h));
  const ix = { mailbox: col(['mailbox', 'roammail address', 'new email', 'email']), provider: col(['provider', 'service']), user: col(['old email', 'old address', 'source email', 'remote user']),
    password: col(['app password', 'password']), host: col(['imap server', 'host', 'server']) };
  if (ix.mailbox < 0 || ix.user < 0 || ix.password < 0) throw fail(400, 'Columns needed: mailbox, provider, old email, app password (and imap server for "other")');
  if (rows.length > 501) throw fail(400, 'Up to 500 rows at a time');
  const results = [];
  for (const r of rows.slice(1)) {
    const mailbox = String(r[ix.mailbox] || '').trim().toLowerCase();
    try {
      await requireDomainAdmin(req, mailbox.split('@')[1]);
      if (!(await mailcow.getMailbox(mailbox).catch(() => null))) throw fail(404, 'No such mailbox in your organization');
      const provider = String(r[ix.provider] || 'other').trim().toLowerCase().replace(/[^a-z]/g, '');
      const c = connFrom({ provider: PROVIDERS[provider] ? provider : 'other', host: ix.host >= 0 ? r[ix.host] : '', user: r[ix.user], password: r[ix.password] });
      await checkHost(c.host, c.port);
      const out = await createSyncImport(mailbox, { ...c, by: req.user.email });
      results.push({ mailbox, ok: true, messages: out.messages });
    } catch (e) { results.push({ mailbox: mailbox || '(blank)', ok: false, error: e.message }); }
  }
  res.json({ results, started: results.filter((x) => x.ok).length });
}));

// ---------------------------------------------------------------- worker: Outlook copies, and stop everything after 7 days
let notifier = null;
export const setImportNotifier = (fn) => { notifier = fn; };
async function tick() {
  const now = Date.now();
  // finished syncing window: stop the job and tell the person
  for (const r of await q.all("SELECT * FROM import_records WHERE status = 'active' AND kind != 'upload' AND stop_at <= ? LIMIT 50", now)) {
    const claim = await q.run("UPDATE import_records SET status = 'finished', creds = NULL WHERE id = ? AND status = 'active'", r.id);
    if (claim.changes !== 1) continue;
    if (r.syncjob_id) await mailcow.editSyncJob(r.syncjob_id, { active: 0 }).catch(() => {});
    await notifier?.(r.email, { title: 'Your import is complete', body: `We stopped copying from ${r.remote_user} after ${SYNC_DAYS} days. Everything copied stays in your mailbox.`, url: '/app' }).catch(() => {});
  }
  // Outlook imports: copy what's new (one at a time per worker; the claim keeps two workers apart)
  for (const r of await q.all("SELECT * FROM import_records WHERE status = 'active' AND kind = 'oauth' AND (next_run IS NULL OR next_run <= ?) LIMIT 5", now)) {
    const claim = await q.run('UPDATE import_records SET next_run = ? WHERE id = ? AND (next_run IS NULL OR next_run <= ?)', now + 20 * 60e3, r.id, now);
    if (claim.changes !== 1) continue;
    try { await copyOAuthImport(r); } catch (e) { await q.run('UPDATE import_records SET last_error = ? WHERE id = ?', String(e.message).slice(0, 300), r.id); }
  }
}
export function startImports() {
  if (!config.runsBackground) return;
  setInterval(() => tick().catch((e) => console.error('APP_ERROR imports', e.message)), Number(process.env.IMPORT_TICK_MS || 5 * 60e3)).unref();
}
export const importsTick = tick;
